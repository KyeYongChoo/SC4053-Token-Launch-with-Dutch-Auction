import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ snapshot: vi.fn() }));
const OWNER = "0x0000000000000000000000000000000000000002";
vi.mock("ethers", async (importOriginal) => ({ ...await importOriginal(), BrowserProvider: class {
  async send() { return ["0x0000000000000000000000000000000000000002"]; }
  async getNetwork() { return { chainId: 31337n }; }
} }));
vi.mock("./auction.js", async (importOriginal) => ({ ...await importOriginal(),
  DEPLOYMENT: { address: "0x0000000000000000000000000000000000000001", chainId: 31337, abi: [] },
  readContract: () => ({}), readProvider: { getNetwork: async () => ({ chainId: 31337n }) },
  loadSnapshot: (...args) => mocks.snapshot(...args),
}));
const { default: App } = await import("./App.jsx");
const originalEthereum = window.ethereum;
const originalObserver = globalThis.ResizeObserver;
const WAD = 10n ** 18n;
function finalized(proceeds, overrides = {}) {
  return { fetchedAt: Date.now() / 1000, chainNow: 2000, state: 2, startTime: 0, endTime: 1200,
    stepCount: 20, stepSeconds: 60, supply: 100n * WAD, cur: 19, ended: true,
    soldOut: false, soldOutStep: 0, owner: OWNER, finalizedAt: 1200, claimDeadline: 1800,
    proceedsWithdrawn: false, reservePrice: WAD, minBidWei: 1n,
    clearing: { step: 19, price: WAD, tokensSold: proceeds, proceeds, earlyNum: 1n, earlyDen: 1n, joinNum: 1n, joinDen: 1n },
    prices: Array.from({ length: 20 }, (_, k) => (29n * WAD) / 10n - BigInt(k) * WAD / 10n),
    demand: Array(20).fill(0n), joins: Array(20).fill(0n), feed: [], myBids: [], ...overrides };
}
beforeEach(() => {
  vi.spyOn(globalThis, "setInterval").mockImplementation(() => 1);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ethereum = { on: () => {}, removeListener: () => {} };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); mocks.snapshot.mockReset(); window.ethereum = originalEthereum; globalThis.ResizeObserver = originalObserver; });
async function ownerView(snap) {
  mocks.snapshot.mockImplementation(async () => snap);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await screen.findByText(/0x0000.*0002/);
  await act(async () => {});
  // Sweep (after the deadline) or Finalize (ended, unfinalized) is enabled, so the UI is ready and any
  // disabled Withdraw is AC59's doing.
  const readyButton = snap.state === 2 ? "Sweep after claim deadline" : "Finalize";
  await waitFor(() => expect(screen.getByRole("button", { name: readyButton }).disabled).toBe(false));
}
const withdrawButton = () => screen.getByRole("button", { name: "Withdraw proceeds" });

describe("AC59: zero proceeds disables Withdraw proceeds", () => {
  it("disables Withdraw proceeds and explains why when finalized with zero proceeds", async () => {
    await ownerView(finalized(0n));
    expect(withdrawButton().disabled).toBe(true);
    expect(screen.getByText("No proceeds to withdraw.")).toBeTruthy();
  });
  it("keeps Withdraw proceeds enabled when finalized with nonzero proceeds not yet withdrawn", async () => {
    await ownerView(finalized(WAD));
    expect(withdrawButton().disabled).toBe(false);
    expect(screen.queryByText("No proceeds to withdraw.")).toBeNull();
  });
  it("still disables Withdraw proceeds once nonzero proceeds are withdrawn", async () => {
    await ownerView(finalized(WAD, { proceedsWithdrawn: true }));
    expect(withdrawButton().disabled).toBe(true);
    expect(screen.queryByText("No proceeds to withdraw.")).toBeNull();
  });
  it("disables Withdraw proceeds and explains why when zero proceeds were already withdrawn", async () => {
    await ownerView(finalized(0n, { proceedsWithdrawn: true }));
    expect(withdrawButton().disabled).toBe(true);
    expect(screen.getByText("No proceeds to withdraw.")).toBeTruthy();
  });
  it("keeps Withdraw proceeds enabled for an ended, unfinalized auction with zero projected proceeds", async () => {
    // SPEC §6: Withdraw is offered as for an ended, unfinalized auction; withdrawProceeds auto-finalizes (AC42).
    await ownerView(finalized(0n, { state: 1, finalizedAt: 0, claimDeadline: 0 }));
    expect(withdrawButton().disabled).toBe(false);
    expect(screen.queryByText("No proceeds to withdraw.")).toBeNull();
  });
});
