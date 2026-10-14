import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BidForm } from "./App.jsx";

// AC53 in the bid form: once the wallet's address has placed MAX_BIDS_PER_ADDRESS bids, the form
// says so and Bid is disabled, instead of sending a transaction that reverts with "bid limit".
const WAD = 10n ** 18n;
const snap = (bidCount) => ({
  cur: 0,
  stepCount: 20,
  prices: Array.from({ length: 20 }, (_, k) => (29n * WAD) / 10n - (BigInt(k) * WAD) / 10n),
  reservePrice: WAD,
  minBidWei: 10n ** 16n,
  maxBidsPerAddress: 100,
  myBids: Array.from({ length: bidCount }, (_, id) => ({ id, cancelled: id === 0 })),
});

afterEach(cleanup);

describe("BidForm bid cap (AC53)", function () {
  it("AC53: with 99 bids placed, the form still allows a bid", () => {
    render(<BidForm snap={snap(99)} disabled={false} onBid={() => {}} />);
    expect(screen.queryByText(/maximum of 100 bids/)).toBeNull();
    expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(false);
  });

  it("AC53: with 100 bids placed, cancelled ones included, the form explains the cap and Bid is disabled", () => {
    render(<BidForm snap={snap(100)} disabled={false} onBid={() => {}} />);
    expect(screen.getByText("This address has placed the maximum of 100 bids. Cancelled bids count too.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bid" }).disabled).toBe(true);
  });
});
