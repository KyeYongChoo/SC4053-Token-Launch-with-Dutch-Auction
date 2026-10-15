import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// Exercise the actual App/MyBids rendering. Wallet and read RPC are deterministic test doubles.
const mocks = vi.hoisted(() => ({ snapshot: null }));
vi.mock("./auction.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DEPLOYMENT: { address: "0x0000000000000000000000000000000000000001", chainId: 31337, abi: [] },
    readContract: () => ({}),
    readProvider: { getNetwork: async () => ({ chainId: 31337n }) },
    loadSnapshot: async () => mocks.snapshot,
  };
});

const { default: App } = await import("./App.jsx");
const ACCOUNT = "0x0000000000000000000000000000000000000002";
const WAD = 10n ** 18n;
const DEADLINE = 2_602_000; // finalizedAt=10_000 plus 30 days.
const originalEthereum = window.ethereum;
const originalResizeObserver = globalThis.ResizeObserver;

const bid = (overrides = {}) => ({ id: 0, bidder: ACCOUNT, ethAmount: WAD, maxPrice: WAD,
  placedStep: 0, effectiveStep: 2, cancelled: false, claimed: false, ...overrides });
const snapshot = (overrides = {}) => ({
  fetchedAt: Date.now() / 1000, chainNow: 300, state: 1, startTime: 0, endTime: 1200,
  stepCount: 20, stepSeconds: 60, supply: 100n * WAD, cur: 5, ended: false,
  soldOut: false, soldOutStep: 0, owner: "0x000000000000000000000000000000000000dEaD",
  finalizedAt: 0, claimDeadline: 0, proceedsWithdrawn: false, reservePrice: WAD, minBidWei: 1n,
  clearing: { step: 19, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 1n, earlyDen: 1n, joinNum: 1n, joinDen: 1n },
  prices: Array.from({ length: 20 }, (_, k) => (29n * WAD) / 10n - BigInt(k) * WAD / 10n),
  demand: Array(20).fill(0n), joins: Array(20).fill(0n), myBids: [bid()], feed: [], ...overrides,
});
const finalized = (overrides = {}) => snapshot({ state: 2, ended: true, cur: 19,
  finalizedAt: 10_000, claimDeadline: DEADLINE, chainNow: DEADLINE - 1,
  clearing: { step: 19, price: WAD, tokensSold: WAD, proceeds: WAD, earlyNum: 1n, earlyDen: 1n, joinNum: 1n, joinDen: 1n },
  ...overrides });

beforeEach(() => {
  // Browser time is deliberately far beyond the snapshot deadline by default.
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ethereum = {
    request: vi.fn(async ({ method }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCOUNT];
      if (method === "eth_chainId") return "0x7a69";
      throw new Error(`Unexpected wallet request: ${method}`);
    }),
    on: vi.fn(), removeListener: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.ethereum = originalEthereum;
  globalThis.ResizeObserver = originalResizeObserver;
});

async function myBids(snap) {
  mocks.snapshot = snap;
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  return waitFor(() => {
    const heading = screen.getByRole("heading", { name: "My bids" });
    const panel = within(heading.closest("section"));
    expect(panel.queryByText("Connect a wallet to see your bids.")).toBeNull();
    return panel;
  });
}
function expectClaim(panel) {
  const button = panel.getByRole("button", { name: "Claim tokens and refunds" });
  expect(button.disabled).toBe(false);
}
function expectNoClaim(panel) {
  expect(panel.queryByRole("button", { name: "Claim tokens and refunds" })).toBeNull();
}

describe("U01: activated bids remain Live", () => {
  it("labels an earlier-step active bid Live and does not offer cancellation", async () => {
    const panel = await myBids(snapshot());
    expect(panel.getByRole("cell", { name: "Live" })).toBeTruthy();
    expect(panel.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
  it("labels a bid at the current step Live without cancellation", async () => {
    const panel = await myBids(snapshot({ myBids: [bid({ effectiveStep: 5 })] }));
    expect(panel.getByRole("cell", { name: "Live" })).toBeTruthy();
    expect(panel.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
  it("keeps a future-step bid Standing with cancellation enabled", async () => {
    const panel = await myBids(snapshot({ myBids: [bid({ effectiveStep: 6 })] }));
    expect(panel.getByRole("cell", { name: "Standing from step 6" })).toBeTruthy();
    expect(panel.getByRole("button", { name: "Cancel" }).disabled).toBe(false);
  });
  it("preserves Cancelled status ahead of step labels", async () => {
    const panel = await myBids(snapshot({ myBids: [bid({ cancelled: true })] }));
    expect(panel.getByRole("cell", { name: "Cancelled" })).toBeTruthy();
    expect(panel.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
  it("preserves Claimed status after settlement", async () => {
    const panel = await myBids(finalized({ myBids: [bid({ claimed: true })] }));
    expect(panel.getByRole("cell", { name: "Claimed" })).toBeTruthy();
    expectNoClaim(panel);
  });
});

describe("U02: claims follow the chain snapshot deadline", () => {
  it("offers Claim before the deadline even when the browser clock is ahead", async () => {
    expectClaim(await myBids(finalized()));
  });
  it("offers Claim at the snapshot deadline even when the local countdown estimate is past it", async () => {
    expectClaim(await myBids(finalized({ chainNow: DEADLINE, fetchedAt: Date.now() / 1000 - 60 })));
  });
  it("hides Claim one second after expiry and explains sweep eligibility", async () => {
    const panel = await myBids(finalized({ chainNow: DEADLINE + 1 }));
    expectNoClaim(panel);
    expect(panel.getByText(/Claim period has expired.*unclaimed tokens and ETH may be swept/i)).toBeTruthy();
  });
  it("still treats claims as expired when the browser clock is behind", async () => {
    vi.mocked(Date.now).mockReturnValue(1_000);
    const panel = await myBids(finalized({ chainNow: DEADLINE + 1 }));
    expectNoClaim(panel);
    expect(panel.getByText(/Claim period has expired/i)).toBeTruthy();
  });
  it("offers auto-finalizing Claim after auction end before a deadline exists", async () => {
    expectClaim(await myBids(snapshot({ ended: true, cur: 19, chainNow: DEADLINE + 1 })));
  });
  it("does not offer Claim after sweep", async () => {
    expectNoClaim(await myBids(finalized({ state: 3, chainNow: DEADLINE + 1 })));
  });
  for (const [name, bids] of [["no bids", []], ["only cancelled bids", [bid({ cancelled: true })]], ["only claimed bids", [bid({ claimed: true })]]]) {
    it(`does not offer Claim with ${name}`, async () => {
      expectNoClaim(await myBids(finalized({ myBids: bids })));
    });
  }
});
