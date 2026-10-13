import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSnapshot, readProvider, DEPLOYMENT } from "./auction.js";

const ACCOUNT = "0x0000000000000000000000000000000000000002";
const IDS = [9007199254740992n, 9007199254740993n];
const BLOCK = { number: 42, timestamp: 10_000 };
function fixture() {
  vi.spyOn(readProvider, "getBlock").mockResolvedValue(BLOCK);
  const values = { state: 1n, startTime: 9000n, endTime: 10200n, stepCount: 2n, stepDuration: 600n,
    supply: 10n ** 18n, currentStep: 1n, isEnded: false, soldOut: false, soldOutStep: 0n,
    owner: ACCOUNT, finalizedAt: 0n, proceedsWithdrawn: false, reservePrice: 1n, minBid: 1n,
    clearing: { step: 0n, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 0n, earlyDen: 1n, joinNum: 0n, joinDen: 1n },
    bidsOf: IDS, claimDeadline: 0n };
  const c = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, vi.fn(async () => value)]));
  c.priceAt = vi.fn(async (k) => 2n - BigInt(k));
  c.demandAt = vi.fn(async () => 0n);
  c.stepJoinAmount = vi.fn(async () => 0n);
  c.getBid = vi.fn(async () => ({ bidder: ACCOUNT, ethAmount: 1n, maxPrice: 1n,
    placedStep: 0n, effectiveStep: 1n, cancelled: false, claimed: false }));
  c.filters = { BidPlaced: () => "placed", BidCancelled: () => "cancelled" };
  c.queryFilter = vi.fn(async () => []);
  return { c, values };
}
afterEach(() => vi.restoreAllMocks());

describe("U04: one captured block per snapshot", () => {
  it("pins every scalar read, step bucket and bidder lookup to the captured block", async () => {
    const { c, values } = fixture();
    await loadSnapshot(c, ACCOUNT);
    expect(readProvider.getBlock).toHaveBeenCalledTimes(1);
    expect(readProvider.getBlock).toHaveBeenCalledWith("latest");
    for (const name of Object.keys(values)) {
      expect(c[name]).toHaveBeenCalledTimes(1);
      expect(c[name]).toHaveBeenCalledWith(...(name === "bidsOf" ? [ACCOUNT] : []), { blockTag: BLOCK.number });
    }
    for (const name of ["priceAt", "demandAt", "stepJoinAmount"]) {
      expect(c[name]).toHaveBeenCalledTimes(2);
      for (let k = 0; k < 2; k++) expect(c[name]).toHaveBeenNthCalledWith(k + 1, k, { blockTag: BLOCK.number });
    }
    for (let k = 0; k < IDS.length; k++) expect(c.getBid).toHaveBeenNthCalledWith(k + 1, IDS[k], { blockTag: BLOCK.number });
  });
  it("limits both event queries to the same captured block", async () => {
    const { c } = fixture();
    await loadSnapshot(c, ACCOUNT);
    expect(c.queryFilter).toHaveBeenCalledTimes(2);
    expect(c.queryFilter).toHaveBeenNthCalledWith(1, "placed", DEPLOYMENT.deployBlock ?? 0, BLOCK.number);
    expect(c.queryFilter).toHaveBeenNthCalledWith(2, "cancelled", DEPLOYMENT.deployBlock ?? 0, BLOCK.number);
  });
  it("does not mix a later finalized state or later events with the captured timestamp", async () => {
    const { c } = fixture();
    c.state.mockImplementation(async (opts) => opts?.blockTag === 42 ? 1n : 2n);
    c.currentStep.mockImplementation(async (opts) => opts?.blockTag === 42 ? 0n : 1n);
    c.claimDeadline.mockImplementation(async (opts) => opts?.blockTag === 42 ? 0n : 2_602_000n);
    c.queryFilter.mockImplementation(async (filter, from, to) => to === 42 ? [] : [{ args: {
      bidId: 99n, bidder: ACCOUNT, ethAmount: 1n, maxPrice: 1n, placedStep: 1n, effectiveStep: 1n,
    } }]);
    const snap = await loadSnapshot(c, ACCOUNT);
    expect(snap.chainNow).toBe(BLOCK.timestamp);
    expect(snap.state).toBe(1);
    expect(snap.cur).toBe(0);
    expect(snap.claimDeadline).toBe(0);
    expect(snap.feed).toEqual([]);
  });
  it("pins disconnected reads without requesting another account's bids", async () => {
    const { c } = fixture();
    const snap = await loadSnapshot(c, null);
    expect(c.bidsOf).not.toHaveBeenCalled();
    expect(c.getBid).not.toHaveBeenCalled();
    expect(snap.myBids).toEqual([]);
    expect(c.state).toHaveBeenCalledTimes(1);
    expect(c.state).toHaveBeenCalledWith({ blockTag: BLOCK.number });
    expect(c.queryFilter).toHaveBeenNthCalledWith(1, "placed", DEPLOYMENT.deployBlock ?? 0, BLOCK.number);
  });
  it("rejects an unavailable latest block before making contract or event calls", async () => {
    const { c } = fixture();
    readProvider.getBlock.mockResolvedValue(null);
    await expect(loadSnapshot(c, ACCOUNT)).rejects.toThrow(/latest block.*unavailable/i);
    expect(c.state).not.toHaveBeenCalled();
    expect(c.queryFilter).not.toHaveBeenCalled();
  });
  it("retains distinct exact bid IDs above Number.MAX_SAFE_INTEGER in my bids and feed", async () => {
    const { c } = fixture();
    c.queryFilter.mockImplementation(async (filter) => filter === "placed" ? IDS.map((bidId) => ({ args: {
      bidId, bidder: ACCOUNT, ethAmount: 1n, maxPrice: 1n, placedStep: 0n, effectiveStep: 1n,
    } })) : [{ args: { bidId: IDS[1] } }]);
    const snap = await loadSnapshot(c, ACCOUNT);
    expect(snap.myBids.map((b) => b.id)).toEqual(IDS.map(String));
    expect(snap.feed.map((b) => b.id)).toEqual([...IDS].reverse().map(String));
    expect(snap.feed.map((b) => b.cancelled)).toEqual([true, false]);
  });
});
