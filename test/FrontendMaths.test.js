const path = require("path");
const { pathToFileURL } = require("url");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// R11 (issue #15): the web app's quote and preview maths (frontend/src/maths.js) must agree with
// the chain. Each seed plays a random auction against the real contract: bids from five bidders
// at random steps, amounts and max prices, with some standing orders cancelled. previewBid is
// checked against every bid the contract places, and quoteBid against previewClaim and claim().
const ETH = (v) => ethers.parseEther(v);
const SUPPLY = ETH("100");
const START_PRICE = ETH("2.9");
const RESERVE = ETH("1");
const STEP = 60n;
const STEP_COUNT = 20;
const MIN_BID = ETH("0.01");
const WINDOW = 1200n;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]; // multiples of 4 are light-demand auctions

let maths;

/** Deterministic PRNG (mulberry32), so a failing seed can be replayed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The bid as the web app holds it (loadSnapshot in frontend/src/auction.js). */
async function appBid(auction, id) {
  const b = await auction.getBid(id);
  return {
    id: Number(id),
    ethAmount: b.ethAmount,
    maxPrice: b.maxPrice,
    placedStep: Number(b.placedStep),
    effectiveStep: Number(b.effectiveStep),
    cancelled: b.cancelled,
    claimed: b.claimed,
  };
}

/** The clearing result as the web app holds it. */
async function appClearing(auction) {
  const c = await auction.clearing();
  return {
    step: Number(c.step),
    price: c.price,
    tokensSold: c.tokensSold,
    proceeds: c.proceeds,
    earlyNum: c.earlyNum,
    earlyDen: c.earlyDen,
    joinNum: c.joinNum,
    joinDen: c.joinDen,
  };
}

/**
 * Plays one random auction to the end and finalizes it. Each bid is first previewed with the
 * app's previewBid, then compared with the step the contract assigned.
 */
async function playAuction(seed) {
  const rand = rng(seed);
  const light = seed % 4 === 0;
  const signers = await ethers.getSigners();
  const bidders = signers.slice(1, 6);
  const auction = await (await ethers.getContractFactory("DutchAuction")).deploy(
    "Launch Token", "LCH", SUPPLY, START_PRICE, RESERVE, STEP, MIN_BID
  );
  await auction.startAuction();
  const t0 = await auction.startTime();
  const prices = await Promise.all(Array.from({ length: STEP_COUNT }, (_, k) => auction.priceAt(k)));
  const snapAt = (cur) => ({ cur, stepCount: STEP_COUNT, prices, reservePrice: RESERVE });

  let previews = 0;
  let soldOutWhileBidding = false;
  for (let k = 0; k < STEP_COUNT && !soldOutWhileBidding; k++) {
    for (let i = 0; i < 2; i++) {
      const who = bidders[Math.floor(rand() * bidders.length)];
      // Plus odd wei, so the pro-rata fractions do not divide evenly. Light seeds bid 0.1-2 ETH
      // (at most 80 ETH in all, below the 100 ETH needed at reserve), so they end undersold.
      const whole = light ? ETH("0.1") * BigInt(1 + Math.floor(rand() * 20)) : ETH(String(1 + Math.floor(rand() * 30)));
      const value = whole + BigInt(Math.floor(rand() * 1e9));
      // A max price at a random step from now on, sometimes between steps, sometimes "any price".
      const j = k + Math.floor(rand() * (STEP_COUNT - k));
      const maxPrice = rand() < 0.2 ? START_PRICE : prices[j] + (rand() < 0.3 ? 1n : 0n);

      await time.setNextBlockTimestamp(t0 + BigInt(k) * STEP + BigInt(10 + i * 10)); // inside step k, after the start block
      const id = await auction.bidCount();
      try {
        await auction.connect(who).bid(maxPrice, { value });
      } catch (e) {
        expect(e.message).to.contain("sold out");
        soldOutWhileBidding = true;
        break;
      }

      const placed = await appBid(auction, id);
      const preview = maths.previewBid(snapAt(k), maxPrice);
      expect(placed.placedStep, `seed ${seed} bid ${id}`).to.equal(k);
      expect(preview.step, `seed ${seed} bid ${id}: previewBid step`).to.equal(placed.effectiveStep);
      expect(preview.live, `seed ${seed} bid ${id}: previewBid live`).to.equal(placed.effectiveStep === k);
      expect(preview.price).to.equal(prices[placed.effectiveStep]);
      previews++;

      // Cancel about one standing order in five while it is still cancellable.
      if (placed.effectiveStep > k && rand() < 0.2) {
        await time.setNextBlockTimestamp(t0 + BigInt(k) * STEP + BigInt(11 + i * 10));
        try {
          await auction.connect(who).cancelBid(id);
        } catch (e) {
          expect(e.message).to.contain("ended"); // the step's sell-out was recorded first
          soldOutWhileBidding = true;
          break;
        }
      }
    }
  }

  await time.increaseTo(t0 + WINDOW);
  await auction.finalize();
  return { auction, bidders, previews };
}

describe("Front-end maths against the chain (R11)", function () {
  const seen = { soldOut: 0, undersold: 0, early: 0, join: 0, later: 0, cancelled: 0, previews: 0 };

  before(async function () {
    // maths.js is an ES module (frontend/package.json sets "type": "module").
    maths = await import(pathToFileURL(path.join(__dirname, "..", "frontend", "src", "maths.js")).href);
  });

  for (const seed of SEEDS) {
    it(`AC50/AC51 (seed ${seed}): previewBid matches each bid's effective step; quoteBid matches previewClaim and claim`, async function () {
      const { auction, bidders, previews } = await playAuction(seed);
      seen.previews += previews;
      const cl = await appClearing(auction);
      if (await auction.soldOut()) seen.soldOut++;
      else seen.undersold++;

      for (const who of bidders) {
        const ids = await auction.bidsOf(who.address);
        if (ids.length === 0) continue;
        let tokens = 0n;
        let refund = 0n;
        for (const id of ids) {
          const b = await appBid(auction, id);
          if (b.cancelled) seen.cancelled++;
          else if (b.effectiveStep < cl.step) seen.early++;
          else if (b.effectiveStep === cl.step) seen.join++;
          else seen.later++;
          const q = maths.quoteBid(b, cl);
          tokens += q.tokens;
          refund += q.refund;
        }

        const [chainTokens, chainRefund] = await auction.previewClaim(who.address);
        expect(tokens, `seed ${seed}: tokens for ${who.address}`).to.equal(chainTokens);
        expect(refund, `seed ${seed}: refund for ${who.address}`).to.equal(chainRefund);

        // Only bidders with an uncancelled bid can claim.
        const claimable = (await Promise.all(ids.map((id) => auction.getBid(id)))).some((b) => !b.cancelled);
        if (!claimable) continue;
        await expect(auction.connect(who).claim()).to.emit(auction, "Claimed").withArgs(who.address, tokens, refund);
      }
    });
  }

  it("R11: the seeds reach every branch of quoteBid and previewBid", function () {
    // Guards the test itself: if the random auctions stop covering a branch, change the seeds.
    expect(seen.soldOut, "sold-out auctions").to.be.greaterThan(0);
    expect(seen.undersold, "undersold auctions").to.be.greaterThan(0);
    expect(seen.early, "bids before the clearing step").to.be.greaterThan(0);
    expect(seen.join, "bids joining at the clearing step").to.be.greaterThan(0);
    expect(seen.later, "standing orders after the clearing step").to.be.greaterThan(0);
    expect(seen.cancelled, "cancelled bids").to.be.greaterThan(0);
    expect(seen.previews).to.be.greaterThan(SEEDS.length * 10);
  });
});
