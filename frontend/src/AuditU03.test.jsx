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
  sendWithHeadroom: (provider, c, method, ...args) => c[method](...args), // Gas headroom is covered by AC56 tests.
}));
const { default: App } = await import("./App.jsx");
const originalEthereum = window.ethereum;
const originalObserver = globalThis.ResizeObserver;
const WAD = 10n ** 18n;
const BIG_ID = "9007199254740993";
function snapshot(overrides = {}) {
  return { fetchedAt: Date.now() / 1000, chainNow: 300, state: 1, startTime: 0, endTime: 1200,
    stepCount: 20, stepSeconds: 60, supply: 100n * WAD, cur: 5, ended: false,
    soldOut: false, soldOutStep: 0, owner: ACCOUNT, finalizedAt: 0, claimDeadline: 0,
    proceedsWithdrawn: false, reservePrice: WAD, minBidWei: 1n,
    clearing: { step: 19, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 1n, earlyDen: 1n, joinNum: 1n, joinDen: 1n },
    prices: Array.from({ length: 20 }, (_, k) => (29n * WAD) / 10n - BigInt(k) * WAD / 10n),
    demand: Array(20).fill(0n), joins: Array(20).fill(0n), feed: [],
    myBids: [{ id: BIG_ID, bidder: ACCOUNT, ethAmount: WAD, maxPrice: WAD, placedStep: 0,
      effectiveStep: 6, cancelled: false, claimed: false }], ...overrides };
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
  mocks.write.mockReturnValue(Object.fromEntries(["bid", "cancelBid", "claim", "finalize", "startAuction", "withdrawProceeds", "sweep"].map((name) => [name, mocks.send])));
  vi.spyOn(globalThis, "setInterval").mockImplementation((fn, ms) => { if (ms === 2000) mocks.poll = fn; return 1; });
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ethereum = { on: (name, fn) => { mocks.events[name] = fn; }, removeListener: () => {} };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.ethereum = originalEthereum; globalThis.ResizeObserver = originalObserver; });
async function connect() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await screen.findByText(/0x0000.*0002/);
  await act(async () => {});
}
const bidButton = () => screen.getByRole("button", { name: "Bid", exact: true });
const transactionButtons = () => screen.queryAllByRole("button", { name: /^(Bid|Cancel|Claim tokens and refunds|Finalize|Start auction|Withdraw proceeds|Sweep after claim deadline)$/ });
function expectDisabled() { for (const button of transactionButtons()) expect(button.disabled).toBe(true); }
async function ready() { await connect(); await waitFor(() => expect(bidButton().disabled).toBe(false)); }
async function refresh() { await act(async () => { await mocks.poll(); }); }
async function beginRefresh() { let promise; await act(async () => { promise = mocks.poll(); }); return { promise }; }

describe("U03: read and signing chains must agree", () => {
  it("allows a bid only when both providers match the deployment", async () => {
    await ready();
    fireEvent.click(bidButton());
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    expect(mocks.signer).toHaveBeenCalledTimes(1);
  });
  it("disables transaction actions when the RPC starts on the wrong chain", async () => {
    mocks.rpc.mockResolvedValue({ chainId: 1n });
    await connect();
    expect(await screen.findByText(/read-only RPC is on chain 1/i)).toBeTruthy();
    expectDisabled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("disables actions while the RPC chain is unknown", async () => {
    const pending = deferred();
    mocks.rpc.mockReturnValue(pending.promise);
    await connect();
    expectDisabled();
  });
  it("disables actions while the wallet chain is unknown", async () => {
    const pending = deferred();
    mocks.walletNetwork.mockReturnValue(pending.promise);
    await connect();
    expectDisabled();
  });
  it("disables actions on an RPC network failure", async () => {
    mocks.rpc.mockRejectedValue(new Error("RPC offline"));
    await connect();
    expectDisabled();
  });
  it("disables actions on a snapshot failure after a previously successful read", async () => {
    await ready();
    mocks.snapshot.mockRejectedValue(new Error("snapshot offline"));
    await refresh();
    expect(await screen.findByText(/snapshot offline/)).toBeTruthy();
    expectDisabled();
  });
  it("disables actions on a wrong wallet chain", async () => {
    mocks.walletNetwork.mockResolvedValue({ chainId: 1n });
    await connect();
    expect(await screen.findByText(/Wrong network/)).toBeTruthy();
    expectDisabled();
  });
  it("blocks a changed RPC chain before obtaining a signer", async () => {
    await ready();
    mocks.rpc.mockResolvedValue({ chainId: 1n });
    fireEvent.click(bidButton());
    await screen.findByText(/Bid failed/);
    expect(mocks.signer).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("blocks an RPC recheck failure before obtaining a signer", async () => {
    await ready();
    mocks.rpc.mockRejectedValue(new Error("RPC offline"));
    fireEvent.click(bidButton());
    await screen.findByText(/Bid failed/);
    expect(mocks.signer).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("preserves the existing pre-send check for a changed wallet chain", async () => {
    await ready();
    mocks.walletNetwork.mockResolvedValue({ chainId: 1n });
    fireEvent.click(bidButton());
    await screen.findByText(/Bid failed.*Wallet is on chain 1/);
    expect(mocks.signer).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("recovers only after a matching-chain successful refresh", async () => {
    await ready();
    mocks.rpc.mockResolvedValue({ chainId: 1n });
    await refresh();
    expectDisabled();
    mocks.rpc.mockResolvedValue({ chainId: 31337n });
    await refresh();
    expect(bidButton().disabled).toBe(false);
  });
  it("passes an exact decimal bid ID unchanged to cancellation", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(BIG_ID));
  });
});

describe("Refresh ordering: old results cannot re-enable actions", () => {
  it("ignores a delayed successful snapshot after a newer RPC mismatch", async () => {
    await ready();
    const old = deferred();
    mocks.snapshot.mockReturnValueOnce(old.promise);
    const pending = await beginRefresh();
    mocks.rpc.mockResolvedValue({ chainId: 1n });
    await refresh();
    await act(async () => { old.resolve(snapshot()); await pending.promise; });
    expectDisabled();
  });
  it("ignores a delayed network response that predates a newer failed refresh", async () => {
    await ready();
    const old = deferred();
    mocks.rpc.mockReturnValueOnce(old.promise);
    const pending = await beginRefresh();
    mocks.rpc.mockRejectedValue(new Error("newer RPC failure"));
    await refresh();
    await act(async () => { old.resolve({ chainId: 31337n }); await pending.promise; });
    expectDisabled();
  });
  it("ignores an old snapshot when the connected account changes", async () => {
    await ready();
    const old = deferred(), latest = deferred();
    mocks.snapshot.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const pending = await beginRefresh();
    await act(async () => { mocks.events.accountsChanged(["0x0000000000000000000000000000000000000003"]); });
    await act(async () => { old.resolve(snapshot()); await pending.promise; });
    expectDisabled();
    await act(async () => { latest.resolve(snapshot({ myBids: [] })); });
    await waitFor(() => expect(bidButton().disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
