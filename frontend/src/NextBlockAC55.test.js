import { afterEach, describe, expect, it, vi } from "vitest";
import { displayedStep, loadSnapshot, readProvider } from "./auction.js";

// AC55: the pending block's timestamp is the time the next block will get. The latest block stays
// the pinned snapshot; next-block time only decides countdowns and whether the end has passed.
const WAD = 10n ** 18n;
const END = 1200;
const LATEST = { number: 21, timestamp: 1039 };

// Active and not ended at the latest block (step 17 of 20).
function contract() {
  const values = { state: 1n, startTime: 0n, endTime: BigInt(END), stepCount: 20n, stepDuration: 60n,
    supply: 100n * WAD, currentStep: 17n, isEnded: false, soldOut: false, soldOutStep: 0n,
    owner: "0x0000000000000000000000000000000000000002", finalizedAt: 0n, proceedsWithdrawn: false,
    reservePrice: WAD, minBid: 1n,
    clearing: { step: 0n, price: 0n, tokensSold: 0n, proceeds: 0n, earlyNum: 0n, earlyDen: 1n, joinNum: 0n, joinDen: 1n },
    claimDeadline: 0n, MAX_BIDS_PER_ADDRESS: 100n };
  const c = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, async () => value]));
  c.priceAt = async (k) => 3n * WAD - (BigInt(k) * WAD) / 10n;
  c.demandAt = async () => 0n;
  c.stepJoinAmount = async () => 0n;
  c.filters = { BidPlaced: () => "placed", BidCancelled: () => "cancelled" };
  c.queryFilter = async () => [];
  return c;
}
function blocks(pending) {
  vi.spyOn(readProvider, "getBlock").mockImplementation(async (tag) => {
    if (tag !== "latest") throw new Error(`unexpected getBlock(${tag})`);
    return LATEST;
  });
  // Raw JSON-RPC, shaped as Hardhat returns it: hex quantities and a null number for pending.
  vi.spyOn(readProvider, "send").mockImplementation(async (method, params) => {
    expect([method, params]).toEqual(["eth_getBlockByNumber", ["pending", false]]);
    if (pending instanceof Error) throw pending;
    if (pending && "raw" in pending) return pending.raw;
    return pending && { number: null, hash: null, timestamp: "0x" + pending.timestamp.toString(16) };
  });
}
afterEach(() => vi.restoreAllMocks());

describe("AC55: next-block time from the pending block", () => {
  it("AC55: a pending block at END marks the snapshot as awaiting a block", async () => {
    blocks({ timestamp: END });
    const snap = await loadSnapshot(contract(), null);
    expect(snap.chainNow).toBe(LATEST.timestamp);
    expect(snap.nextBlockTime).toBe(END);
    expect(snap.awaitingBlock).toBe(true);
    expect(snap.ended).toBe(false); // The chain's own answer is kept as read.
  });

  it("AC55: a pending block one second before END is not awaiting a block", async () => {
    blocks({ timestamp: END - 1 });
    const snap = await loadSnapshot(contract(), null);
    expect(snap.nextBlockTime).toBe(END - 1);
    expect(snap.awaitingBlock).toBe(false);
  });

  for (const [label, pending] of [
    ["unavailable", null],
    ["a failed request", new Error("pending not supported")],
    ["earlier than the latest block", { timestamp: LATEST.timestamp - 100 }],
    ["malformed (bad hex timestamp)", { raw: { number: null, timestamp: "0xzz" } }],
    ["malformed (no timestamp)", { raw: { number: null, hash: null } }],
    ["malformed (not an object)", { raw: "pending" }],
  ]) {
    it(`AC55: falls back to the latest block's timestamp when the pending block is ${label}`, async () => {
      blocks(pending);
      const snap = await loadSnapshot(contract(), null);
      expect(snap.nextBlockTime).toBe(LATEST.timestamp);
      expect(snap.awaitingBlock).toBe(false);
    });
  }
});

describe("AC55: displayed step k = min(floor((t − T0)/Δ), N − 1)", () => {
  const active = { state: 1, ended: false, soldOut: false, cur: 17, startTime: 0, stepSeconds: 60, stepCount: 20 };
  it("AC55: follows next-block time into a later step", () => {
    expect(displayedStep(active, 1080)).toBe(18); // first second of step 18
    expect(displayedStep(active, 1139)).toBe(18);
    expect(displayedStep(active, 1140)).toBe(19);
  });
  it("AC55: is capped at N − 1", () => {
    expect(displayedStep(active, END)).toBe(19);
    expect(displayedStep(active, END + 600)).toBe(19);
  });
  it("AC55: is never earlier than the latest block's step", () => {
    expect(displayedStep(active, 1000)).toBe(17); // step 16 by time, 17 at the latest block
  });
  it("AC55: does not move ahead of the latest block unless active, unended and unsold", () => {
    expect(displayedStep({ ...active, state: 0 }, 1140)).toBe(17);
    expect(displayedStep({ ...active, ended: true }, 1140)).toBe(17);
    expect(displayedStep({ ...active, soldOut: true }, 1140)).toBe(17); // a sell-out is not predicted
    expect(displayedStep({ ...active, state: 2 }, 1140)).toBe(17);
  });
});
