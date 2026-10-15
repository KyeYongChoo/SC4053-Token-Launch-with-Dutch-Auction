import { Contract, JsonRpcProvider, formatEther } from "ethers";
import deployment from "./deployment.json";

// Data access for the auction. The quote and preview maths (SPEC.md §2) live in maths.js, which
// the contract tests also load, and are re-exported here. The contract remains the source of truth.
export { WAD, previewBid, quoteBid } from "./maths.js";

export const DEPLOYMENT = deployment;
export const RPC_URL = import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8545";
export const STATE_NAMES = ["Created", "Active", "Finalized", "Swept"];

export const readProvider = new JsonRpcProvider(RPC_URL);

export function readContract() {
  return new Contract(DEPLOYMENT.address, DEPLOYMENT.abi, readProvider);
}

export function writeContract(signer) {
  return new Contract(DEPLOYMENT.address, DEPLOYMENT.abi, signer);
}

const range = (n) => Array.from({ length: n }, (_, i) => i);

/** The pending block's timestamp in seconds, or 0 when the node cannot supply one. */
async function pendingTimestamp() {
  try {
    const pending = await readProvider.send("eth_getBlockByNumber", ["pending", false]);
    return pending?.timestamp ? Number(BigInt(pending.timestamp)) : 0;
  } catch {
    return 0;
  }
}

/** Reads contract state and events at one captured block height. */
export async function loadSnapshot(c, account) {
  const block = await readProvider.getBlock("latest");
  if (!block) throw new Error("Latest block is unavailable.");
  const atBlock = { blockTag: block.number };
  const fetchedAt = Date.now() / 1000;
  // The pending block carries the timestamp the next block will get. A local chain that mines only
  // on transactions leaves the latest block behind real time, so countdowns run from this instead.
  // Read it as raw JSON: Hardhat returns the pending block with number null, which getBlock rejects.
  const nextBlockTime = Math.max(Number(block.timestamp), await pendingTimestamp());

  const [state, startTime, endTime, stepCount, stepSeconds, supply, cur, ended, soldOut, soldOutStep,
    owner, finalizedAt, proceedsWithdrawn, reservePrice, minBid, clearing, bidIds, claimDeadline, maxBidsPerAddress] = await Promise.all([
    c.state(atBlock),
    c.startTime(atBlock),
    c.endTime(atBlock),
    c.stepCount(atBlock),
    c.stepDuration(atBlock),
    c.supply(atBlock),
    c.currentStep(atBlock),
    c.isEnded(atBlock),
    c.soldOut(atBlock),
    c.soldOutStep(atBlock),
    c.owner(atBlock),
    c.finalizedAt(atBlock),
    c.proceedsWithdrawn(atBlock),
    c.reservePrice(atBlock),
    c.minBid(atBlock),
    c.clearing(atBlock),
    account ? c.bidsOf(account, atBlock) : Promise.resolve([]),
    c.claimDeadline(atBlock),
    c.MAX_BIDS_PER_ADDRESS(atBlock),
  ]);

  const N = Number(stepCount);
  const [prices, demand, joins] = await Promise.all([
    Promise.all(range(N).map((k) => c.priceAt(k, atBlock))),
    Promise.all(range(N).map((k) => c.demandAt(k, atBlock))),
    Promise.all(range(N).map((k) => c.stepJoinAmount(k, atBlock))),
  ]);

  const myBids = await Promise.all(
    bidIds.map(async (id) => {
      const b = await c.getBid(id, atBlock);
      return {
        id: id.toString(),
        bidder: b.bidder,
        ethAmount: b.ethAmount,
        maxPrice: b.maxPrice,
        placedStep: Number(b.placedStep),
        effectiveStep: Number(b.effectiveStep),
        cancelled: b.cancelled,
        claimed: b.claimed,
      };
    })
  );

  const fromBlock = DEPLOYMENT.deployBlock ?? 0;
  const [placed, cancelled] = await Promise.all([
    c.queryFilter(c.filters.BidPlaced(), fromBlock, block.number),
    c.queryFilter(c.filters.BidCancelled(), fromBlock, block.number),
  ]);
  const cancelledIds = new Set(cancelled.map((e) => e.args.bidId.toString()));
  const feed = placed
    .map((e) => ({
      id: e.args.bidId.toString(),
      bidder: e.args.bidder,
      ethAmount: e.args.ethAmount,
      maxPrice: e.args.maxPrice,
      placedStep: Number(e.args.placedStep),
      effectiveStep: Number(e.args.effectiveStep),
      cancelled: cancelledIds.has(e.args.bidId.toString()),
    }))
    .reverse();

  const stepSec = Number(stepSeconds);
  return {
    fetchedAt,
    chainNow: Number(block.timestamp),
    nextBlockTime,
    // Active at the latest block, but the next block is at or past END (SPEC section 6, AC55).
    awaitingBlock: Number(state) === 1 && !ended && nextBlockTime >= Number(endTime),
    state: Number(state),
    startTime: Number(startTime),
    endTime: Number(endTime),
    stepCount: N,
    stepSeconds: stepSec,
    supply,
    cur: Number(cur),
    ended,
    soldOut,
    soldOutStep: Number(soldOutStep),
    owner,
    finalizedAt: Number(finalizedAt),
    claimDeadline: Number(claimDeadline),
    proceedsWithdrawn,
    reservePrice,
    minBidWei: minBid,
    // Every bid counts, cancelled ones included (SPEC §2.13), so compare with myBids.length.
    maxBidsPerAddress: Number(maxBidsPerAddress),
    clearing: {
      step: Number(clearing.step),
      price: clearing.price,
      tokensSold: clearing.tokensSold,
      proceeds: clearing.proceeds,
      earlyNum: clearing.earlyNum,
      earlyDen: clearing.earlyDen,
      joinNum: clearing.joinNum,
      joinDen: clearing.joinDen,
    },
    prices,
    demand,
    joins,
    myBids,
    feed,
  };
}

export function fmtEth(wei, digits = 4) {
  return Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtTokens(wei, digits = 4) {
  return fmtEth(wei, digits);
}

export function fmtDuration(seconds) {
  if (seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function fmtTime(unix) {
  return unix ? new Date(unix * 1000).toLocaleString() : "-";
}
