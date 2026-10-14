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

/** Reads everything the UI needs in one pass. */
export async function loadSnapshot(c, account) {
  const block = await readProvider.getBlock("latest");
  const fetchedAt = Date.now() / 1000;

  const [state, startTime, endTime, stepCount, stepSeconds, supply, cur, ended, soldOut, soldOutStep,
    owner, finalizedAt, proceedsWithdrawn, reservePrice, minBid, clearing, bidIds, claimDeadline] = await Promise.all([
    c.state(),
    c.startTime(),
    c.endTime(),
    c.stepCount(),
    c.stepDuration(),
    c.supply(),
    c.currentStep(),
    c.isEnded(),
    c.soldOut(),
    c.soldOutStep(),
    c.owner(),
    c.finalizedAt(),
    c.proceedsWithdrawn(),
    c.reservePrice(),
    c.minBid(),
    c.clearing(),
    account ? c.bidsOf(account) : Promise.resolve([]),
    c.claimDeadline(),
  ]);

  const N = Number(stepCount);
  const [prices, demand, joins] = await Promise.all([
    Promise.all(range(N).map((k) => c.priceAt(k))),
    Promise.all(range(N).map((k) => c.demandAt(k))),
    Promise.all(range(N).map((k) => c.stepJoinAmount(k))),
  ]);

  const myBids = await Promise.all(
    bidIds.map(async (id) => {
      const b = await c.getBid(id);
      return {
        id: Number(id),
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
    c.queryFilter(c.filters.BidPlaced(), fromBlock),
    c.queryFilter(c.filters.BidCancelled(), fromBlock),
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
