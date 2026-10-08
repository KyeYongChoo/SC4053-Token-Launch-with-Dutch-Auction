import { describe, expect, it } from "vitest";
import { fmtDuration, fmtEth, previewBid, quoteBid } from "./auction.js";

// Unit tests for the data-layer maths. The expected values match the on-chain check made during
// review: a 40 ETH and an 85 ETH bid, sold out at step 17 with a 1.2 ETH clearing price.
// quoteBid must equal the contract's previewClaim for the same clearing result.

const WAD = 10n ** 18n;
const ETH = (v) => BigInt(Math.round(v * 1e18));

// Clearing for the sold-out scenario: charged = eth * 120 / 125, tokens = eth / 1.2 * (120 / 125).
const soldOutClearing = {
  step: 17,
  price: ETH(1.2),
  tokensSold: 100n * WAD,
  proceeds: ETH(120),
  earlyNum: 120n * WAD * WAD, // need = price * supply, scaled by WAD
  earlyDen: 125n * WAD * WAD, // earlier demand * WAD
  joinNum: 0n,
  joinDen: 1n,
};

const bid = (overrides) => ({
  effectiveStep: 0,
  ethAmount: ETH(40),
  cancelled: false,
  claimed: false,
  ...overrides,
});

describe("quoteBid", () => {
  it("fills an earlier bid pro-rata and refunds the excess (contract: 32 tokens, 1.6 ETH)", () => {
    const q = quoteBid(bid({ ethAmount: ETH(40) }), soldOutClearing);
    expect(q.tokens).toBe(32n * WAD);
    expect(q.refund).toBe(ETH(1.6));
  });

  it("the 85 ETH bid gets 68 tokens and a 3.4 ETH refund", () => {
    const q = quoteBid(bid({ ethAmount: ETH(85) }), soldOutClearing);
    expect(q.tokens).toBe(68n * WAD);
    expect(q.refund).toBe(ETH(3.4));
  });

  it("a standing order that activates after the clearing step gets nothing and a full refund", () => {
    const q = quoteBid(bid({ effectiveStep: 18, ethAmount: ETH(10) }), soldOutClearing);
    expect(q).toEqual({ tokens: 0n, refund: ETH(10) });
  });

  it("a bid joining at the clearing step gets nothing when the earlier bids cover the sale", () => {
    const q = quoteBid(bid({ effectiveStep: 17, ethAmount: ETH(10) }), soldOutClearing);
    expect(q).toEqual({ tokens: 0n, refund: ETH(10) });
  });

  it("an undersold auction fills every bid in full at the reserve price", () => {
    const undersold = { step: 19, price: ETH(1), tokensSold: 30n * WAD, proceeds: ETH(30), earlyNum: 1n, earlyDen: 1n, joinNum: 1n, joinDen: 1n };
    expect(quoteBid(bid({ effectiveStep: 0, ethAmount: ETH(30) }), undersold)).toEqual({ tokens: 30n * WAD, refund: 0n });
  });

  it("cancelled and already-claimed bids quote zero", () => {
    expect(quoteBid(bid({ cancelled: true }), soldOutClearing)).toEqual({ tokens: 0n, refund: 0n });
    expect(quoteBid(bid({ claimed: true }), soldOutClearing)).toEqual({ tokens: 0n, refund: 0n });
  });

  it("returns null before finalization, when the clearing price is still zero", () => {
    const notFinalized = { ...soldOutClearing, price: 0n };
    expect(quoteBid(bid(), notFinalized)).toBeNull();
  });

  it("charges round up and tokens round down, so the bidder never pays less than the exact cost", () => {
    // 1 wei of ETH at a non-terminating ratio: charged must round up, tokens must round down.
    const cl = { ...soldOutClearing, earlyNum: 1n, earlyDen: 3n, price: 1n * WAD };
    const q = quoteBid(bid({ ethAmount: 10n }), cl);
    expect(q.refund).toBe(6n); // charged = ceil(10 / 3) = 4
    expect(q.tokens).toBe(3n); // floor(10 / 3)
  });
});

describe("previewBid", () => {
  const prices = Array.from({ length: 20 }, (_, k) => ETH(2.9) - (BigInt(k) * (ETH(2.9) - ETH(1))) / 19n);
  const snap = (cur) => ({ cur, stepCount: 20, prices, reservePrice: ETH(1) });

  it("a max price at or above the current price is a live bid", () => {
    expect(previewBid(snap(0), ETH(2.9))).toEqual({ step: 0, live: true, price: ETH(2.9) });
  });

  it("a lower max price activates at the first step whose price is affordable", () => {
    // price(14) = 1.5 is the first step at or below 1.5 when starting from step 0.
    const r = previewBid(snap(0), ETH(1.5));
    expect(r.step).toBe(14);
    expect(r.live).toBe(false);
  });

  it("a max price at or above the current price is live even mid-auction", () => {
    expect(previewBid(snap(18), ETH(1.5))).toEqual({ step: 18, live: true, price: prices[18] });
  });

  it("rejects a max price below the reserve", () => {
    expect(previewBid(snap(0), ETH(0.9)).error).toMatch(/reserve/);
  });
});

describe("formatting", () => {
  it("fmtDuration shows minutes and seconds", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(59)).toBe("59s");
    expect(fmtDuration(125)).toBe("2m 05s");
  });

  it("fmtEth formats wei as ETH", () => {
    expect(fmtEth(ETH(1.5))).toMatch(/^1\.5$/);
  });
});
