import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), snapshot: vi.fn(), walletNetwork: vi.fn(),
  poll: null, timeout: null, events: {} }));
const ACCOUNT = "0x0000000000000000000000000000000000000002";
vi.mock("ethers", async (importOriginal) => ({ ...await importOriginal(), BrowserProvider: class {
  async send() { return ["0x0000000000000000000000000000000000000002"]; }
  getNetwork() { return mocks.walletNetwork(); }
  getSigner() { return {}; }
} }));
vi.mock("./auction.js", async (importOriginal) => ({ ...await importOriginal(),
  DEPLOYMENT: { address: "0x0000000000000000000000000000000000000001", chainId: 31337, abi: [] },
  readContract: () => ({}), readProvider: { getNetwork: () => mocks.rpc() },
  loadSnapshot: (...args) => mocks.snapshot(...args),
}));
const { default: App } = await import("./App.jsx");
const originalEthereum = window.ethereum;
const originalObserver = globalThis.ResizeObserver;
const originalSetTimeout = globalThis.setTimeout;
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
  mocks.timeout = null;
  mocks.rpc.mockResolvedValue({ chainId: 31337n });
  mocks.walletNetwork.mockResolvedValue({ chainId: 31337n });
  mocks.snapshot.mockImplementation(async () => snapshot());
  vi.spyOn(globalThis, "setInterval").mockImplementation((fn, ms) => { if (ms === 2000) mocks.poll = fn; return 1; });
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  // Capture the 30 s refresh timeout; other timers (testing-library's) run normally.
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...rest) => {
    if (ms === 30000) { mocks.timeout = fn; return 30000; }
    return originalSetTimeout(fn, ms, ...rest);
  });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ethereum = { on: (name, fn) => { mocks.events[name] = fn; }, removeListener: () => {} };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.ethereum = originalEthereum;
  globalThis.ResizeObserver = originalObserver;
});
const bidButton = () => screen.getByRole("button", { name: "Bid", exact: true });
// setInterval is stubbed, so waitFor only retries on DOM changes; mock counts are read after a flushed act.
async function mount() { render(<App />); await act(async () => {}); }
async function tick() { await act(async () => { mocks.poll(); }); }

describe("AC61: a refresh slower than the poll interval still publishes", () => {
  it("AC61: routine polls do not start a refresh while a slow one runs, and its snapshot publishes", async () => {
    const slow = deferred();
    mocks.snapshot.mockReturnValueOnce(slow.promise);
    await mount();
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) await tick(); // 6 s of polls against a refresh that has not returned.
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading auction...")).toBeTruthy();
    await act(async () => { slow.resolve(snapshot()); });
    expect(screen.queryByText("Loading auction...")).toBeNull();
    expect(screen.getByText("Current step")).toBeTruthy();
    expect(screen.queryByText(/Could not read the chain/)).toBeNull();
    await tick(); // The first poll after it settles starts the next refresh.
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });

  it("AC61: a wallet connection or account change starts a refresh at once and ignores the earlier response", async () => {
    const routine = deferred(), connected = deferred();
    mocks.snapshot.mockReturnValueOnce(routine.promise).mockReturnValueOnce(connected.promise);
    await mount();
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await screen.findByText(/0x0000.*0002/);
    await act(async () => {});
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    expect(mocks.snapshot.mock.calls[1][1]).toBe(ACCOUNT);
    await act(async () => { routine.resolve(snapshot({ owner: "0x0000000000000000000000000000000000000009" })); });
    expect(screen.getByText("Loading auction...")).toBeTruthy();

    const later = deferred(), switched = deferred();
    await act(async () => { connected.resolve(snapshot()); });
    await waitFor(() => expect(bidButton().disabled).toBe(false));
    mocks.snapshot.mockReturnValueOnce(later.promise).mockReturnValueOnce(switched.promise);
    await tick();
    expect(mocks.snapshot).toHaveBeenCalledTimes(3);
    const other = "0x0000000000000000000000000000000000000003";
    await act(async () => { mocks.events.accountsChanged([other]); });
    expect(mocks.snapshot).toHaveBeenCalledTimes(4);
    expect(mocks.snapshot.mock.calls[3][1]).toBe(other);
    await act(async () => { later.resolve(snapshot()); });
    expect(screen.getByText("Loading auction...")).toBeTruthy();
    await tick(); // The superseded response settling must not let a poll overtake the account-change refresh.
    expect(mocks.snapshot).toHaveBeenCalledTimes(4);
    await act(async () => { switched.resolve(snapshot()); });
    expect(screen.queryByText("Loading auction...")).toBeNull();
  });

  it("AC61: a refresh that hangs past 30 s fails with a timeout, ignores its late response, and the next poll retries", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await screen.findByText(/0x0000.*0002/);
    await waitFor(() => expect(bidButton().disabled).toBe(false));
    const hung = deferred();
    const calls = mocks.snapshot.mock.calls.length;
    mocks.snapshot.mockReturnValueOnce(hung.promise);
    await tick();
    expect(mocks.snapshot).toHaveBeenCalledTimes(calls + 1);
    expect(mocks.timeout).toBeTypeOf("function");
    await act(async () => { mocks.timeout(); });
    expect(await screen.findByText(/did not respond within 30 seconds/)).toBeTruthy();
    expect(bidButton().disabled).toBe(true);
    await act(async () => { hung.resolve(snapshot()); });
    expect(screen.getByText(/did not respond within 30 seconds/)).toBeTruthy();
    expect(bidButton().disabled).toBe(true);
    await tick();
    expect(mocks.snapshot).toHaveBeenCalledTimes(calls + 2);
    await waitFor(() => expect(screen.queryByText(/did not respond within 30 seconds/)).toBeNull());
    expect(bidButton().disabled).toBe(false);
  });
});
