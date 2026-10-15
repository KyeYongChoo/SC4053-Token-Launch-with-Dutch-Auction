import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSnapshot, readProvider } from "./auction.js";

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
    if (tag === "latest") return LATEST;
    if (pending instanceof Error) throw pending;
    return pending ?? null;
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
  ]) {
    it(`AC55: falls back to the latest block's timestamp when the pending block is ${label}`, async () => {
      blocks(pending);
      const snap = await loadSnapshot(contract(), null);
      expect(snap.nextBlockTime).toBe(LATEST.timestamp);
      expect(snap.awaitingBlock).toBe(false);
    });
  }
});
