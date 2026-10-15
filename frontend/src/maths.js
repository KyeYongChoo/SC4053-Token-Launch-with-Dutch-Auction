// Quote and preview maths for the auction, with no imports, so the contract tests can load this
// file in Node and compare it with the chain (test/FrontendMaths.test.js). Mirrors SPEC.md §2.

export const WAD = 10n ** 18n;

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

/**
 * Displayed step at next-block time `t` (SPEC §6): min(floor((t − T0)/Δ), N − 1), never before the
 * latest block's step. Only an active, unended, unsold auction moves ahead of the latest block.
 */
export function displayedStep(snap, t) {
  if (snap.state !== 1 || snap.ended || snap.soldOut) return snap.cur;
  return Math.max(snap.cur, Math.min(Math.floor((t - snap.startTime) / snap.stepSeconds), snap.stepCount - 1));
}

/** Which step a bid placed now at `maxPrice` would take, given the current step. */
export function previewBid(snap, maxPrice) {
  if (maxPrice < snap.reservePrice) return { error: "Max price is below the reserve price." };
  for (let k = snap.cur; k < snap.stepCount; k++) {
    if (snap.prices[k] <= maxPrice) return { step: k, live: k === snap.cur, price: snap.prices[k] };
  }
  return { error: "No step reaches this max price." };
}
