import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), snapshot: vi.fn(), walletNetwork: vi.fn(),
  signer: vi.fn(), write: vi.fn(), send: vi.fn(), poll: null, events: {} }));
const ACCOUNT = "0x0000000000000000000000000000000000000002";
vi.mock("ethers", async (importOriginal) => ({ ...await importOriginal(), BrowserProvider: class {
  async send() { return ["0x0000000000000000000000000000000000000002"]; }
  getNetwork() { return mocks.walletNetwork(); }
  getSigner() { return mocks.signer(); }
} }));
vi.mock("./auction.js", async (importOriginal) => ({ ...await importOriginal(),
  DEPLOYMENT: { address: "0x0000000000000000000000000000000000000001", chainId: 31337, abi: [] },
  readContract: () => ({}), readProvider: { getNetwork: () => mocks.rpc() },
  loadSnapshot: (...args) => mocks.snapshot(...args), writeContract: (...args) => mocks.write(...args),
}));
const { default: App } = await import("./App.jsx");
const originalEthereum = window.ethereum;
const originalObserver = globalThis.ResizeObserver;
const originalLocation = window.location;
const WAD = 10n ** 18n;
function snapshot(overrides = {}) {
  return { fetchedAt: Date.now() / 1000, chainNow: 300, state: 1, startTime: 0, endTime: 1200,
    stepCount: 20, stepSeconds: 60, supply: 100n * WAD, cur: 5, ended: false,
    soldOut: false, soldOutStep: 0, owner: ACCOUNT, finalizedAt: 0, claimDeadline: 0,
    proceedsWithdrawn: false, reservePrice: WAD, minBidWei: 1n,
    clearing: { step: 19, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 1n, earlyDen: 1n, joinNum: 1n, joinDen: 1n },
    prices: Array.from({ length: 20 }, (_, k) => (29n * WAD) / 10n - BigInt(k) * WAD / 10n),
    demand: Array(20).fill(0n), joins: Array(20).fill(0n), feed: [], myBids: [], ...overrides };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.events = {};
  mocks.rpc.mockResolvedValue({ chainId: 31337n });
  mocks.walletNetwork.mockResolvedValue({ chainId: 31337n });
  mocks.snapshot.mockImplementation(async () => snapshot());
  mocks.signer.mockResolvedValue({});
  mocks.send.mockResolvedValue({ wait: async () => ({}) });
  mocks.write.mockReturnValue({ bid: mocks.send });
  vi.spyOn(globalThis, "setInterval").mockImplementation((fn, ms) => { if (ms === 2000) mocks.poll = fn; return 1; });
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ethereum = { on: (name, fn) => { mocks.events[name] = fn; }, removeListener: () => {} };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.ethereum = originalEthereum;
  globalThis.ResizeObserver = originalObserver;
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});
async function connect() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await screen.findByText(/0x0000.*0002/);
  await act(async () => {});
}
const bidButton = () => screen.getByRole("button", { name: "Bid", exact: true });
const transactionButtons = () => screen.queryAllByRole("button", { name: /^(Bid|Cancel|Claim tokens and refunds|Finalize|Start auction|Withdraw proceeds|Sweep after claim deadline)$/ });
function expectDisabled() {
  expect(transactionButtons().length).toBeGreaterThan(0);
  for (const button of transactionButtons()) expect(button.disabled).toBe(true);
}
async function ready() { await connect(); await waitFor(() => expect(bidButton().disabled).toBe(false)); }
async function beginRefresh() { let promise; await act(async () => { promise = mocks.poll(); }); return { promise }; }

describe("AC60: routine polls keep action readiness", () => {
  it("keeps transaction actions enabled while a routine poll is in flight", async () => {
    await ready();
    const rpc = deferred(), snap = deferred();
    const calls = mocks.snapshot.mock.calls.length;
    mocks.rpc.mockReturnValueOnce(rpc.promise);
    mocks.snapshot.mockReturnValueOnce(snap.promise);
    const pending = await beginRefresh();
    expect(bidButton().disabled).toBe(false);
    await act(async () => { rpc.resolve({ chainId: 31337n }); });
    expect(mocks.snapshot).toHaveBeenCalledTimes(calls + 1);
    expect(bidButton().disabled).toBe(false);
    await act(async () => { snap.resolve(snapshot()); await pending.promise; });
    expect(bidButton().disabled).toBe(false);
  });
  it("disables actions when the routine poll fails", async () => {
    await ready();
    const rpc = deferred();
    mocks.rpc.mockReturnValueOnce(rpc.promise);
    const pending = await beginRefresh();
    expect(bidButton().disabled).toBe(false);
    await act(async () => { rpc.reject(new Error("RPC offline")); await pending.promise; });
    expect(await screen.findByText(/RPC offline/)).toBeTruthy();
    expectDisabled();
  });
  it("disables actions when the routine poll finds a network mismatch", async () => {
    await ready();
    const rpc = deferred();
    mocks.rpc.mockReturnValueOnce(rpc.promise);
    const pending = await beginRefresh();
    expect(bidButton().disabled).toBe(false);
    await act(async () => { rpc.resolve({ chainId: 1n }); await pending.promise; });
    expect(await screen.findByText(/read-only RPC is on chain 1/i)).toBeTruthy();
    expectDisabled();
  });
  it("disables actions at once on an account change", async () => {
    await ready();
    const latest = deferred();
    mocks.snapshot.mockReturnValueOnce(latest.promise);
    await act(async () => { mocks.events.accountsChanged(["0x0000000000000000000000000000000000000003"]); });
    expect(transactionButtons().filter((button) => !button.disabled)).toEqual([]);
    await act(async () => { latest.resolve(snapshot()); });
    await waitFor(() => expect(bidButton().disabled).toBe(false));
  });
  it("disables actions at once on a network change", async () => {
    await ready();
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, reload } });
    await act(async () => { mocks.events.chainChanged("0x1"); });
    expect(reload).toHaveBeenCalledTimes(1);
    expectDisabled();
  });
  it("disables actions after a signing check until a later poll succeeds", async () => {
    await ready();
    const after = deferred();
    const calls = mocks.snapshot.mock.calls.length;
    mocks.snapshot.mockReturnValueOnce(after.promise);
    fireEvent.click(bidButton());
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(calls + 1));
    await act(async () => {});
    expectDisabled();
    await act(async () => { after.resolve(snapshot()); });
    await waitFor(() => expect(bidButton().disabled).toBe(false));
  });
});
