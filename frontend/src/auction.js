import { formatEther } from "ethers";

export const DURATION = 20 * 60;
const UNIT = 10n ** 18n;

// Written by `npm run deploy:local`; absent until the contracts are deployed.
const found = import.meta.glob("./contracts/deployment.json", { eager: true });
export const deployment = Object.values(found)[0]?.default ?? null;

/** Mirrors DutchAuction.currentPrice() so the UI can tick between blocks. */
export function priceAt(state, nowSec) {
  if (!state.startTime) return state.startPrice;
  const elapsed = BigInt(Math.max(0, Math.floor(nowSec) - state.startTime));
  if (elapsed >= BigInt(DURATION)) return state.reservePrice;
  return state.startPrice - ((state.startPrice - state.reservePrice) * elapsed) / BigInt(DURATION);
}

/** Mirrors the contract's settlement price: the higher of the curve and the sold-out price. */
export function settlementPrice(state, nowSec) {
  if (state.finalized) return state.clearingPrice;
  const curve = priceAt(state, nowSec);
  const soldOut = (state.totalCommitted * UNIT + state.tokensForSale - 1n) / state.tokensForSale;
  return soldOut > curve ? soldOut : curve;
}

export function commitmentCap(state, price) {
  return (price * state.tokensForSale) / UNIT;
}

export function tokensFor(wei, price) {
  return price > 0n ? (wei * UNIT) / price : 0n;
}

/** NOT_STARTED | LIVE | SOLD_OUT | EXPIRED | FINALIZED */
export function phaseOf(state, nowSec) {
  if (!state.startTime) return "NOT_STARTED";
  if (state.finalized) return "FINALIZED";
  if (state.totalCommitted >= commitmentCap(state, priceAt(state, nowSec))) return "SOLD_OUT";
  if (nowSec >= state.startTime + DURATION) return "EXPIRED";
  return "LIVE";
}

export function fmt(wei, digits = 4) {
  const n = Number(formatEther(wei));
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function errorMessage(error) {
  if (error?.code === "ACTION_REJECTED") return "Transaction rejected in wallet.";
  return error?.revert?.name ?? error?.reason ?? error?.shortMessage ?? error?.message ?? "Transaction failed.";
}
