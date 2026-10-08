import { Contract, JsonRpcProvider, formatEther } from "ethers";
import deployment from "./deployment.json";

// Data access and maths for the auction. Mirrors SPEC.md §2 so the UI can show per-bid
// estimates without an extra round trip. The contract remains the source of truth.

export const DEPLOYMENT = deployment;
export const RPC_URL = import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8545";
export const WAD = 10n ** 18n;
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

/** Per-bid tokens and refund under the clearing result (SPEC §2.11). Null before finalization. */
export function quoteBid(bid, cl) {
  if (cl.price === 0n) return null;
  if (bid.cancelled || bid.claimed) return { tokens: 0n, refund: 0n };
  let num;
  let den;
  if (bid.effectiveStep < cl.step) {
    num = cl.earlyNum;
    den = cl.earlyDen;
  } else if (bid.effectiveStep === cl.step) {
    num = cl.joinNum;
    den = cl.joinDen;
  } else {
    return { tokens: 0n, refund: bid.ethAmount };
  }
  const eth = bid.ethAmount;
  const charged = (eth * num + den - 1n) / den;
  const tokens = (eth * num * WAD) / (den * cl.price);
  return { tokens, refund: eth - charged };
}

/** Which step a bid placed now at `maxPrice` would take, given the current step. */
export function previewBid(snap, maxPrice) {
  if (maxPrice < snap.reservePrice) return { error: "Max price is below the reserve price." };
  for (let k = snap.cur; k < snap.stepCount; k++) {
    if (snap.prices[k] <= maxPrice) return { step: k, live: k === snap.cur, price: snap.prices[k] };
  }
  return { error: "No step reaches this max price." };
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
