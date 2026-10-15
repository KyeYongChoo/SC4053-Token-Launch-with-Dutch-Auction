import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AbiCoder, Contract, id } from "ethers";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const ACCOUNT = "0x0000000000000000000000000000000000000002";
const ABI = ["function bid(uint256 maxPrice) payable", "function cancelBid(uint256 bidId)", "function finalize()"];
const mocks = vi.hoisted(() => ({ estimate: vi.fn(), sendTransaction: vi.fn(), provider: null }));
vi.mock("ethers", async (importOriginal) => ({ ...await importOriginal(), BrowserProvider: class {
  async send() { return ["0x0000000000000000000000000000000000000002"]; }
  async getNetwork() { return { chainId: 31337n }; }
  async getSigner() { return {}; }
} }));
vi.mock("./auction.js", async (importOriginal) => {
  const { JsonRpcProvider } = await vi.importActual("ethers");
  mocks.provider = new JsonRpcProvider("http://127.0.0.1:1", 31337, { staticNetwork: true });
  mocks.provider.getNetwork = async () => ({ chainId: 31337n });
  mocks.provider.send = (...args) => mocks.estimate(...args);
  return { ...await importOriginal(),
    DEPLOYMENT: { address: "0x0000000000000000000000000000000000000001", chainId: 31337, abi: [] },
    readContract: () => ({}), readProvider: mocks.provider,
    loadSnapshot: async () => snapshot(), writeContract: () => contract(),
  };
});
const { default: App } = await import("./App.jsx");
const { gasLimitFor, sendWithHeadroom } = await import("./auction.js");
const WAD = 10n ** 18n;
const BID_ID = "7";
function snapshot() {
  return { fetchedAt: Date.now() / 1000, chainNow: 300, state: 1, startTime: 0, endTime: 1200,
    stepCount: 20, stepSeconds: 60, supply: 100n * WAD, cur: 5, ended: false,
    soldOut: false, soldOutStep: 0, owner: ACCOUNT, finalizedAt: 0, claimDeadline: 0,
    proceedsWithdrawn: false, reservePrice: WAD, minBidWei: 1n,
    clearing: { step: 19, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 1n, earlyDen: 1n, joinNum: 1n, joinDen: 1n },
    prices: Array.from({ length: 20 }, (_, k) => (29n * WAD) / 10n - BigInt(k) * WAD / 10n),
    demand: Array(20).fill(0n), joins: Array(20).fill(0n), feed: [],
    myBids: [{ id: BID_ID, bidder: ACCOUNT, ethAmount: WAD, maxPrice: WAD, placedStep: 0,
      effectiveStep: 6, cancelled: false, claimed: false }] };
}
// The wallet: a real ethers Contract whose signer records what it is asked to sign.
function contract() {
  return new Contract(ADDRESS, ABI, { provider: null, getAddress: async () => ACCOUNT,
    sendTransaction: (tx) => mocks.sendTransaction(tx) });
}
// The error ethers builds when eth_estimateGas reverts with require(..., reason).
function revertError(reason) {
  const data = id("Error(string)").slice(0, 10) + AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2);
  return mocks.provider.getRpcError({ method: "eth_estimateGas", params: [{}] },
    { error: { code: 3, message: `execution reverted: ${reason}`, data } });
}
const hex = (n) => "0x" + n.toString(16);
const originalEthereum = window.ethereum;
const originalObserver = globalThis.ResizeObserver;
beforeEach(() => {
  mocks.estimate.mockReset();
  mocks.sendTransaction.mockReset();
  mocks.sendTransaction.mockRejectedValue(new Error("wallet closed"));
  vi.spyOn(globalThis, "setInterval").mockImplementation(() => 1);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ethereum = { on: () => {}, removeListener: () => {} };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.ethereum = originalEthereum; globalThis.ResizeObserver = originalObserver; });

describe("AC56: gas limit is ceil(pending estimate × 1.25)", () => {
  it("rounds the 1.25 headroom up to a whole unit of gas", () => {
    expect(gasLimitFor(223_454n)).toBe(279_318n); // 279,317.5, the bid from issue #40
    expect(gasLimitFor(21_000n)).toBe(26_250n);
    expect(gasLimitFor(4n)).toBe(5n);
    expect(gasLimitFor(1n)).toBe(2n);
    expect(gasLimitFor(0n)).toBe(0n);
    expect(gasLimitFor("0x368de")).toBe(279_318n); // eth_estimateGas returns a hex quantity
  });
  it("estimates against the pending block and signs with the headroom limit", async () => {
    mocks.estimate.mockResolvedValue(hex(223_454n));
    await expect(sendWithHeadroom(mocks.provider, contract(), "bid", 2n * WAD, { value: WAD })).rejects.toThrow("wallet closed");
    expect(mocks.estimate).toHaveBeenCalledTimes(1);
    const [method, [rpcTx, block]] = mocks.estimate.mock.calls[0];
    expect([method, block]).toEqual(["eth_estimateGas", "pending"]);
    expect(rpcTx).toMatchObject({ from: ACCOUNT.toLowerCase(), to: ADDRESS.toLowerCase(), value: hex(WAD) });
    const signed = mocks.sendTransaction.mock.calls[0][0];
    expect(signed).toMatchObject({ gasLimit: 279_318n, value: WAD, data: rpcTx.data });
  });
  it("adds the limit to calls without overrides", async () => {
    mocks.estimate.mockResolvedValue(hex(100_000n));
    await expect(sendWithHeadroom(mocks.provider, contract(), "finalize")).rejects.toThrow("wallet closed");
    expect(mocks.sendTransaction.mock.calls[0][0].gasLimit).toBe(125_000n);
  });
  it("does not ask the wallet to sign when the estimate reverts", async () => {
    mocks.estimate.mockRejectedValue(revertError("below minBid"));
    await expect(sendWithHeadroom(mocks.provider, contract(), "bid", WAD, { value: 1n })).rejects.toMatchObject({ reason: "below minBid" });
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("AC56: UI actions sign with the headroom limit", () => {
  async function ready() {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await screen.findByText(/0x0000.*0002/);
    await act(async () => {});
    await waitFor(() => expect(screen.getByRole("button", { name: "Bid", exact: true }).disabled).toBe(false));
  }
  it("Bid signs with ceil(pending estimate × 1.25)", async () => {
    mocks.estimate.mockResolvedValue(hex(223_454n));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Bid", exact: true }));
    await waitFor(() => expect(mocks.sendTransaction).toHaveBeenCalledTimes(1));
    expect(mocks.estimate.mock.calls[0][1][1]).toBe("pending");
    expect(mocks.sendTransaction.mock.calls[0][0]).toMatchObject({ gasLimit: 279_318n, value: WAD });
  });
  it("Cancel signs with ceil(pending estimate × 1.25)", async () => {
    mocks.estimate.mockResolvedValue(hex(80_001n));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocks.sendTransaction).toHaveBeenCalledTimes(1));
    expect(mocks.sendTransaction.mock.calls[0][0].gasLimit).toBe(100_002n);
  });
  it("shows the revert reason and never reaches the wallet when the estimate reverts", async () => {
    mocks.estimate.mockRejectedValue(revertError("below minBid"));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Bid", exact: true }));
    expect(await screen.findByText("Bid failed: below minBid")).toBeTruthy();
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
  });
});
