import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// AC55 rendering: once the next block would be at or past END the UI treats the auction as ended.
// loadSnapshot is mocked; NextBlockAC55.test.js covers how the snapshot computes awaitingBlock.
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
const END = 1200;
const originalEthereum = window.ethereum;
const originalResizeObserver = globalThis.ResizeObserver;

const standing = { id: "0", bidder: ACCOUNT, ethAmount: WAD, maxPrice: WAD, placedStep: 5,
  effectiveStep: 19, cancelled: false, claimed: false };
const snapshot = (overrides = {}) => ({
  fetchedAt: Date.now() / 1000, chainNow: 1039, nextBlockTime: 1039, awaitingBlock: false,
  state: 1, startTime: 0, endTime: END, stepCount: 20, stepSeconds: 60, supply: 100n * WAD, cur: 17,
  ended: false, soldOut: false, soldOutStep: 0, owner: "0x000000000000000000000000000000000000dEaD",
  finalizedAt: 0, claimDeadline: 0, proceedsWithdrawn: false, reservePrice: WAD, minBidWei: 1n,
  maxBidsPerAddress: 100,
  clearing: { step: 0, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 0n, earlyDen: 1n, joinNum: 0n, joinDen: 1n },
  prices: Array.from({ length: 20 }, (_, k) => 3n * WAD - BigInt(k) * WAD / 10n),
  demand: Array(20).fill(0n), joins: Array(20).fill(0n), myBids: [standing], feed: [], ...overrides,
});

beforeEach(() => {
  mocks.snapshot = null;
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

async function connected(snap) {
  mocks.snapshot = snap;
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await waitFor(() => expect(screen.queryByText("Connect a wallet to see your bids.")).toBeNull());
  // Actions open once the wallet's chain check has finished; Claim or Cancel shows when it has.
  await waitFor(() => expect(screen.getByRole("button", { name: /^(Claim tokens and refunds|Cancel)$/ }).disabled).toBe(false));
  return within(screen.getByRole("heading", { name: "My bids" }).closest("section"));
}

describe("AC55: rendering while waiting for a new block", () => {
  it("AC55: awaiting a block shows the ended status and Finalize, and disables Bid and Cancel", async () => {
    const bids = await connected(snapshot({ nextBlockTime: END + 5, awaitingBlock: true }));
    expect(screen.getByRole("heading", { name: "Ended, waiting for a new block" })).toBeTruthy();
    expect(screen.queryByText("Auction ends in")).toBeNull();
    expect(screen.getByRole("button", { name: "Finalize" }).disabled).toBe(false);
    expect(screen.getByText(/the next transaction closes the auction/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(true);
    expect(bids.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(bids.getByRole("button", { name: "Claim tokens and refunds" }).disabled).toBe(false);
  });

  it("AC55 (control): before END the countdown runs from next-block time and actions stay open", async () => {
    const bids = await connected(snapshot({ nextBlockTime: END - 90 }));
    expect(screen.getByRole("heading", { name: "Active" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Finalize" })).toBeNull();
    // Counting from the latest block (1039) would show 2m 41s.
    expect(screen.getByText("Auction ends in").nextSibling.textContent).toMatch(/^1m 2\ds$/);
    // Next-block time 1110 is in step 18, though the latest block says 17: the next boundary is 1140.
    expect(screen.getByText("Next step in").nextSibling.textContent).toMatch(/^(30|29|28)s$/);
    expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(false);
    expect(bids.getByRole("button", { name: "Cancel" }).disabled).toBe(false);
  });
});
