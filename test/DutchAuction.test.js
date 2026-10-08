const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Parameters used throughout (SPEC §7 example, adjusted to 20 steps):
// S = 100 tokens, P0 = 2.9 ETH, R = 1.0 ETH, 60 s steps => N = 20, price(k) = 2.9 - 0.1k.
const ETH = (v) => ethers.parseEther(v);
const SUPPLY = ETH("100");
const START_PRICE = ETH("2.9");
const RESERVE = ETH("1");
const STEP = 60n;
const STEP_COUNT = 20n;
const MIN_BID = ETH("0.01");
const WINDOW = 1200n;
const DAY = 86400n;
const CLAIM_PERIOD = 30n * DAY;

const price = (k) => START_PRICE - (BigInt(k) * (START_PRICE - RESERVE)) / (STEP_COUNT - 1n);
const at = (t0, step, offset = 0n) => t0 + BigInt(step) * STEP + offset;

async function deployFixture() {
  const [owner, alice, bob, carol, dave, eve] = await ethers.getSigners();
  const auction = await (await ethers.getContractFactory("DutchAuction")).deploy(
    "Launch Token",
    "LCH",
    SUPPLY,
    START_PRICE,
    RESERVE,
    STEP,
    MIN_BID
  );
  await auction.waitForDeployment();
  return { auction, owner, alice, bob, carol, dave, eve };
}

async function startedFixture() {
  const f = await deployFixture();
  await f.auction.startAuction();
  f.t0 = await f.auction.startTime();
  return f;
}

/** Started auction where bob has 30 ETH live at step 0, then the window has closed. */
async function endedUndersoldFixture() {
  const f = await startedFixture();
  await f.auction.connect(f.bob).bid(START_PRICE, { value: ETH("30") });
  await time.increaseTo(f.t0 + WINDOW);
  return f;
}

async function finalizedUndersoldFixture() {
  const f = await endedUndersoldFixture();
  await f.auction.finalize();
  return f;
}

/** Places a bid whose block timestamp is exactly `ts` and returns its placed step. */
async function placedStepAt(auction, signer, ts, maxPrice, value) {
  const id = await auction.bidCount();
  await time.setNextBlockTimestamp(ts);
  await auction.connect(signer).bid(maxPrice, { value });
  return (await auction.getBid(id)).placedStep;
}

async function expectPreview(auction, who, tokens, refund) {
  const [t, r] = await auction.previewClaim(who.address);
  expect(t).to.equal(tokens);
  expect(r).to.equal(refund);
}

describe("DutchAuction", function () {
  // ───────────── Deployment and start (AC 1–5) ─────────────
  describe("deployment and start", function () {
    it("AC1: holds the full supply in the auction, owner is deployer, state is Created", async function () {
      const { auction, owner } = await loadFixture(deployFixture);
      const token = await ethers.getContractAt("LaunchToken", await auction.token());
      expect(await token.balanceOf(await auction.getAddress())).to.equal(SUPPLY);
      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await auction.owner()).to.equal(owner.address);
      expect(await auction.state()).to.equal(0); // Created
    });

    it("AC2: rejects invalid parameters", async function () {
      const F = await ethers.getContractFactory("DutchAuction");
      const cases = [
        [SUPPLY, RESERVE, RESERVE, STEP, MIN_BID, "prices"], // P0 == R
        [SUPPLY, START_PRICE, 0n, STEP, MIN_BID, "prices"], // R == 0
        [0n, START_PRICE, RESERVE, STEP, MIN_BID, "supply"],
        [SUPPLY, START_PRICE, RESERVE, STEP, 0n, "minBid"],
        [SUPPLY, START_PRICE, RESERVE, 7n, MIN_BID, "stepDuration"], // 1200 % 7 != 0
        [SUPPLY, START_PRICE, RESERVE, 0n, MIN_BID, "stepDuration"],
        [SUPPLY, START_PRICE, RESERVE, 1n, MIN_BID, "stepCount"], // 1200 steps > 120
        [SUPPLY, START_PRICE, RESERVE, 1200n, MIN_BID, "stepCount"], // 1 step < 2
      ];
      for (const [s, p0, r, d, m, reason] of cases) {
        await expect(F.deploy("T", "T", s, p0, r, d, m)).to.be.revertedWith(reason);
      }
    });

    it("AC3: only the owner can start; start sets the 20-minute window", async function () {
      const { auction, alice } = await loadFixture(deployFixture);
      await expect(auction.connect(alice).startAuction()).to.be.reverted;
      await expect(auction.startAuction()).to.emit(auction, "AuctionStarted");
      expect(await auction.state()).to.equal(1); // Active
      expect(await auction.endTime()).to.equal((await auction.startTime()) + WINDOW);
    });

    it("AC4: cannot start twice", async function () {
      const { auction } = await loadFixture(startedFixture);
      await expect(auction.startAuction()).to.be.revertedWith("already started");
    });

    it("AC5: bids are rejected before start", async function () {
      const { auction, alice } = await loadFixture(deployFixture);
      await expect(auction.connect(alice).bid(START_PRICE, { value: MIN_BID })).to.be.revertedWith("not active");
    });
  });

  // ───────────── Price schedule (AC 6–9) ─────────────
  describe("price schedule", function () {
    it("AC6–8: placed step changes exactly at each step boundary, and the last step is reached at END-1", async function () {
      const { auction, alice, t0 } = await loadFixture(startedFixture);
      expect(await placedStepAt(auction, alice, at(t0, 0, 1n), START_PRICE, MIN_BID)).to.equal(0);
      for (let k = 1n; k < STEP_COUNT; k++) {
        expect(await placedStepAt(auction, alice, at(t0, k, -1n), START_PRICE, MIN_BID)).to.equal(k - 1n);
        expect(await placedStepAt(auction, alice, at(t0, k), START_PRICE, MIN_BID)).to.equal(k);
      }
      // Pending view of the last step: END-1 is still step 19.
      expect(await placedStepAt(auction, alice, t0 + WINDOW - 1n, START_PRICE, MIN_BID)).to.equal(19);
    });

    it("AC9: schedule formula, strictly decreasing, last step equals reserve", async function () {
      const { auction } = await loadFixture(startedFixture);
      let prev = null;
      for (let k = 0n; k < STEP_COUNT; k++) {
        const p = await auction.priceAt(k);
        expect(p).to.equal(price(k));
        if (prev !== null) expect(p).to.be.lessThan(prev);
        prev = p;
      }
      expect(await auction.priceAt(STEP_COUNT - 1n)).to.equal(RESERVE);
    });
  });

  // ───────────── Bidding (AC 10–17) ─────────────
  describe("bidding", function () {
    it("AC10: enforces minBid", async function () {
      const { auction, alice } = await loadFixture(startedFixture);
      await expect(auction.connect(alice).bid(START_PRICE, { value: MIN_BID - 1n })).to.be.revertedWith(
        "below minBid"
      );
      await expect(auction.connect(alice).bid(START_PRICE, { value: MIN_BID })).to.not.be.reverted;
    });

    it("AC11: enforces maxPrice >= reserve", async function () {
      const { auction, alice } = await loadFixture(startedFixture);
      await expect(auction.connect(alice).bid(RESERVE - 1n, { value: MIN_BID })).to.be.revertedWith(
        "below reserve"
      );
      await expect(auction.connect(alice).bid(RESERVE, { value: MIN_BID })).to.not.be.reverted;
    });

    it("AC12–13: maxPrice at or above the current price is live; a lower maxPrice is a standing order snapped to the first affordable step", async function () {
      const { auction, alice, bob, t0 } = await loadFixture(startedFixture);
      await time.increaseTo(at(t0, 3, 5n));
      await auction.connect(alice).bid(price(3), { value: ETH("1") }); // live at step 3
      // price(10) = 1.9 > 1.85 and price(11) = 1.8 <= 1.85, so the standing order activates at step 11.
      await auction.connect(bob).bid(ETH("1.85"), { value: ETH("1") });
      expect((await auction.getBid(0)).effectiveStep).to.equal(3);
      expect((await auction.getBid(1)).effectiveStep).to.equal(11);
      expect(await auction.stepJoinAmount(3)).to.equal(ETH("1"));
      expect(await auction.stepJoinAmount(11)).to.equal(ETH("1"));
    });

    it("AC14: maxPrice above P0 is treated as step 0 (live)", async function () {
      const { auction, alice } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(ETH("50"), { value: MIN_BID });
      expect((await auction.getBid(0)).effectiveStep).to.equal(0);
    });

    it("AC15: bids accepted at END-1, rejected at END", async function () {
      const { auction, alice, t0 } = await loadFixture(startedFixture);
      await time.setNextBlockTimestamp(t0 + WINDOW - 1n);
      await expect(auction.connect(alice).bid(RESERVE, { value: MIN_BID })).to.not.be.reverted;
      await time.setNextBlockTimestamp(t0 + WINDOW);
      await expect(auction.connect(alice).bid(RESERVE, { value: MIN_BID })).to.be.revertedWith("ended");
    });

    it("AC17: one address holds several bids with incremental ids", async function () {
      const { auction, alice } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(START_PRICE, { value: MIN_BID });
      await auction.connect(alice).bid(RESERVE, { value: MIN_BID });
      expect(await auction.bidsOf(alice.address)).to.deep.equal([0n, 1n]);
    });
  });

  // ───────────── Sell-out (AC 18–22) ─────────────
  describe("sell-out", function () {
    it("AC18: demand exactly equal to price*supply sells out (inclusive)", async function () {
      const { auction, alice, t0 } = await loadFixture(startedFixture);
      // Step 19: price 1.0, supply 100 tokens => exactly 100 ETH.
      await time.increaseTo(at(t0, 19, 5n));
      await expect(auction.connect(alice).bid(RESERVE, { value: ETH("100") })).to.emit(auction, "SoldOut");
      expect(await auction.soldOut()).to.equal(true);
      expect(await auction.soldOutStep()).to.equal(19);
    });

    it("AC19: one wei short does not sell out", async function () {
      const { auction, alice, t0 } = await loadFixture(startedFixture);
      await time.increaseTo(at(t0, 19, 5n));
      await auction.connect(alice).bid(RESERVE, { value: ETH("100") - 1n });
      expect(await auction.soldOut()).to.equal(false);
    });

    it("AC20–21: demand active before a step boundary sells out with no transaction; later bids revert", async function () {
      const { auction, alice, eve, bob, t0 } = await loadFixture(startedFixture);
      // 115 ETH live at step 0. Need is 120 at step 17 (not met) and 110 at step 18 (met).
      await auction.connect(alice).bid(START_PRICE, { value: ETH("115") });
      await time.increaseTo(at(t0, 18, 1n));
      await expect(auction.connect(bob).bid(START_PRICE, { value: MIN_BID })).to.be.revertedWith("sold out");
      await auction.finalize();
      expect(await auction.soldOut()).to.equal(true);
      expect(await auction.clearingStep()).to.equal(18);
      expect(await auction.clearingPrice()).to.equal(ETH("1.1"));
    });

    it("AC21: a standing order that joins at the boundary step can complete the sell-out", async function () {
      const { auction, alice, eve, t0 } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(START_PRICE, { value: ETH("105") }); // not enough for step 18 alone
      await auction.connect(eve).bid(ETH("1.1"), { value: ETH("10") }); // standing at step 18
      expect((await auction.getBid(1)).effectiveStep).to.equal(18);
      await time.increaseTo(at(t0, 18, 1n));
      await auction.finalize();
      expect(await auction.soldOutStep()).to.equal(18);
    });

    it("AC22: no sell-out means clearing at reserve on the final step", async function () {
      const { auction } = await loadFixture(finalizedUndersoldFixture);
      expect(await auction.soldOut()).to.equal(false);
      expect(await auction.clearingStep()).to.equal(STEP_COUNT - 1n);
      expect(await auction.clearingPrice()).to.equal(RESERVE);
    });
  });

  // ───────────── Allocation (AC 23–28) ─────────────
  describe("allocation and clearing", function () {
    it("AC23: tipping bid is partially filled; everyone pays the same clearing price", async function () {
      const { auction, bob, carol, alice, t0 } = await loadFixture(startedFixture);
      await auction.connect(bob).bid(START_PRICE, { value: ETH("45") });
      await auction.connect(carol).bid(START_PRICE, { value: ETH("45") });
      await time.increaseTo(at(t0, 17, 5n)); // price 1.2, need 120
      await auction.connect(alice).bid(ETH("1.2"), { value: ETH("40") }); // D = 130 >= 120
      expect(await auction.soldOutStep()).to.equal(17);

      await time.increaseTo(t0 + WINDOW);
      await auction.finalize();
      expect(await auction.clearingPrice()).to.equal(ETH("1.2"));
      expect(await auction.tokensSold()).to.equal(SUPPLY);
      expect(await auction.proceeds()).to.equal(ETH("120"));

      const token = await ethers.getContractAt("LaunchToken", await auction.token());
      // Alice: 30 ETH used (25 tokens), 10 ETH refunded. Bob and carol: 37.5 tokens each.
      await expect(auction.connect(alice).claim()).to.changeEtherBalance(alice, ETH("10"));
      expect(await token.balanceOf(alice.address)).to.equal(ETH("25"));
      await auction.connect(bob).claim();
      expect(await token.balanceOf(bob.address)).to.equal(ETH("37.5"));
      await auction.connect(carol).claim();
      expect(await token.balanceOf(carol.address)).to.equal(ETH("37.5"));
    });

    it("AC24: joiners at the clearing step share the remainder pro-rata", async function () {
      const { auction, bob, carol, dave, t0 } = await loadFixture(startedFixture);
      await auction.connect(bob).bid(START_PRICE, { value: ETH("90") });
      await time.increaseTo(at(t0, 17, 5n));
      await auction.connect(carol).bid(ETH("1.2"), { value: ETH("20") }); // D = 110
      await auction.connect(dave).bid(ETH("1.2"), { value: ETH("20") }); // D = 130, sells out
      // A = 90, need = 120, f = 30/40 = 0.75 for each joiner: charged 15, refund 5, tokens 12.5.
      await expect(auction.connect(carol).claim()).to.changeEtherBalance(carol, ETH("5"));
      const token = await ethers.getContractAt("LaunchToken", await auction.token());
      expect(await token.balanceOf(carol.address)).to.equal(ETH("12.5"));
      await expectPreview(auction, dave, ETH("12.5"), ETH("5"));
    });

    it("AC25: boundary oversubscription: earlier bids fill at 110/115, later standing order gets nothing", async function () {
      const { auction, alice, eve, owner, t0 } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(START_PRICE, { value: ETH("115") });
      await auction.connect(eve).bid(ETH("1.1"), { value: ETH("10") }); // standing at step 18
      await time.increaseTo(at(t0, 18, 1n));
      await auction.finalize();
      expect(await auction.clearingPrice()).to.equal(ETH("1.1"));
      expect(await auction.tokensSold()).to.equal(SUPPLY);
      // Alice: charged 110, refund 5, tokens 100. Eve: charged 0, refund 10, tokens 0.
      await expectPreview(auction, alice, SUPPLY, ETH("5"));
      await expectPreview(auction, eve, 0n, ETH("10"));
      await expect(auction.connect(alice).claim()).to.changeEtherBalance(alice, ETH("5"));
      await expect(auction.connect(eve).claim()).to.changeEtherBalance(eve, ETH("10"));
      await expect(auction.connect(owner).withdrawProceeds()).to.changeEtherBalance(owner, ETH("110"));
    });

    it("AC26: undersold sale fills everyone at reserve and burns the rest", async function () {
      const { auction, bob } = await loadFixture(finalizedUndersoldFixture);
      const token = await ethers.getContractAt("LaunchToken", await auction.token());
      // 30 ETH at reserve 1.0 => 30 tokens sold, 70 burned.
      expect(await auction.tokensSold()).to.equal(ETH("30"));
      expect(await token.totalSupply()).to.equal(ETH("30"));
      expect(await auction.proceeds()).to.equal(ETH("30"));
      await auction.connect(bob).claim();
      expect(await token.balanceOf(bob.address)).to.equal(ETH("30"));
    });

    it("AC27: no bids => nothing sold, full supply burned, zero proceeds", async function () {
      const { auction, t0 } = await loadFixture(startedFixture);
      await time.increaseTo(t0 + WINDOW);
      await expect(auction.finalize())
        .to.emit(auction, "AuctionFinalized")
        .withArgs(STEP_COUNT - 1n, RESERVE, 0n, SUPPLY, false);
      expect(await auction.proceeds()).to.equal(0n);
      const token = await ethers.getContractAt("LaunchToken", await auction.token());
      expect(await token.totalSupply()).to.equal(0n);
    });

    it("AC28: rounding never overpays: tokens round down, charges round up, auction stays solvent", async function () {
      const { auction, owner, bob, alice, dave, t0 } = await loadFixture(startedFixture);
      await auction.connect(bob).bid(START_PRICE, { value: ETH("88") });
      await time.increaseTo(at(t0, 17, 5n));
      await auction.connect(alice).bid(ETH("1.2"), { value: ETH("13") }); // D = 101
      await auction.connect(dave).bid(ETH("1.2"), { value: ETH("20") }); // D = 121, sells out
      // f = 32/33 for both joiners: non-terminating, so rounding is exercised.
      await auction.finalize();
      const token = await ethers.getContractAt("LaunchToken", await auction.token());
      const addr = await auction.getAddress();

      await auction.connect(bob).claim();
      await auction.connect(alice).claim();
      await auction.connect(dave).claim();
      await auction.connect(owner).withdrawProceeds();

      // Each bidder rounds in the auction's favour by at most one wei (ETH) or one token-wei (tokens).
      expect(await ethers.provider.getBalance(addr)).to.be.lessThanOrEqual(3n);
      expect(await token.balanceOf(addr)).to.be.lessThanOrEqual(3n);
    });
  });

  // ───────────── Cancellation (AC 29–34) ─────────────
  describe("cancellation", function () {
    it("AC29: a standing order can be cancelled before its step, with a full refund", async function () {
      const { auction, alice } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(ETH("1.5"), { value: ETH("5") }); // standing at step 14
      expect((await auction.getBid(0)).effectiveStep).to.equal(14);
      await expect(auction.connect(alice).cancelBid(0))
        .to.emit(auction, "BidCancelled")
        .withArgs(0n, alice.address, ETH("5"));
      expect(await auction.stepJoinAmount(14)).to.equal(0n);
    });

    it("AC30: a standing order cannot be cancelled at or after its step", async function () {
      const { auction, alice, t0 } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(ETH("1.5"), { value: ETH("5") });
      await time.increaseTo(at(t0, 14, 5n));
      await expect(auction.connect(alice).cancelBid(0)).to.be.revertedWith("already live");
    });

    it("AC31: a live bid cannot be cancelled", async function () {
      const { auction, alice } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(START_PRICE, { value: MIN_BID });
      await expect(auction.connect(alice).cancelBid(0)).to.be.revertedWith("already live");
    });

    it("AC32: only the bidder can cancel their bid", async function () {
      const { auction, alice, bob } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(ETH("1.5"), { value: ETH("5") });
      await expect(auction.connect(bob).cancelBid(0)).to.be.revertedWith("not your bid");
    });

    it("AC33: cannot cancel after the auction has ended", async function () {
      const { auction, alice, t0 } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(ETH("1.5"), { value: ETH("5") });
      await time.increaseTo(t0 + WINDOW);
      await expect(auction.connect(alice).cancelBid(0)).to.be.revertedWith("ended");
    });

    it("AC34: cannot cancel twice", async function () {
      const { auction, alice } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(ETH("1.5"), { value: ETH("5") });
      await auction.connect(alice).cancelBid(0);
      await expect(auction.connect(alice).cancelBid(0)).to.be.revertedWith("already cancelled");
    });

    it("a cancelled standing order does not count toward sell-out", async function () {
      const { auction, alice, bob, t0 } = await loadFixture(startedFixture);
      // 95 live; need is 100 at step 19 (not met) and 110 at step 18.
      // With bob's 15 ETH standing order (e = 18) the total is 110, which would sell out at step 18.
      await auction.connect(alice).bid(START_PRICE, { value: ETH("95") });
      await auction.connect(bob).bid(ETH("1.1"), { value: ETH("15") });
      expect((await auction.getBid(1)).effectiveStep).to.equal(18);
      await auction.connect(bob).cancelBid(1); // 95 total: not enough at any step
      await time.increaseTo(t0 + WINDOW);
      await auction.finalize();
      expect(await auction.soldOut()).to.equal(false);
      expect(await auction.clearingStep()).to.equal(STEP_COUNT - 1n);
    });
  });

  // ───────────── Finalize and claim (AC 35–41) ─────────────
  describe("finalize and claim", function () {
    it("AC35: finalize before the end reverts", async function () {
      const { auction, alice } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(START_PRICE, { value: MIN_BID });
      await expect(auction.finalize()).to.be.revertedWith("not ended");
    });

    it("AC36: finalize records the result once; second call reverts", async function () {
      const { auction } = await loadFixture(finalizedUndersoldFixture);
      expect(await auction.finalizedAt()).to.be.greaterThan(0n);
      await expect(auction.finalize()).to.be.revertedWith("not active");
    });

    it("AC37: claim auto-finalizes when ended but not finalized", async function () {
      const { auction, bob } = await loadFixture(endedUndersoldFixture);
      await expect(auction.connect(bob).claim()).to.emit(auction, "AuctionFinalized");
      expect(await auction.state()).to.equal(2); // Finalized
    });

    it("AC38: claim pays once; second claim reverts", async function () {
      const { auction, bob } = await loadFixture(finalizedUndersoldFixture);
      await expect(auction.connect(bob).claim()).to.emit(auction, "Claimed");
      await expect(auction.connect(bob).claim()).to.be.revertedWith("nothing to claim");
    });

    it("AC39: an address with no bids cannot claim", async function () {
      const { auction, alice } = await loadFixture(finalizedUndersoldFixture);
      await expect(auction.connect(alice).claim()).to.be.revertedWith("nothing to claim");
    });

    it("AC40: claim succeeds exactly at finalizedAt + 30 days", async function () {
      const { auction, bob } = await loadFixture(finalizedUndersoldFixture);
      const deadline = (await auction.finalizedAt()) + CLAIM_PERIOD;
      expect(await auction.claimDeadline()).to.equal(deadline);
      await time.setNextBlockTimestamp(deadline);
      await expect(auction.connect(bob).claim()).to.emit(auction, "Claimed");
    });

    it("AC40: claim reverts one second after the deadline", async function () {
      const { auction, bob } = await loadFixture(finalizedUndersoldFixture);
      const deadline = (await auction.finalizedAt()) + CLAIM_PERIOD;
      await time.setNextBlockTimestamp(deadline + 1n);
      await expect(auction.connect(bob).claim()).to.be.revertedWith("claim period over");
    });

    it("AC41: claim reverts while the auction is still active", async function () {
      const { auction, alice } = await loadFixture(startedFixture);
      await auction.connect(alice).bid(START_PRICE, { value: MIN_BID });
      await expect(auction.connect(alice).claim()).to.be.revertedWith("not ended");
    });
  });

  // ───────────── Owner payouts (AC 42–45) ─────────────
  describe("owner payouts", function () {
    it("AC42: only the owner withdraws proceeds, once", async function () {
      const { auction, owner, alice } = await loadFixture(finalizedUndersoldFixture);
      await expect(auction.connect(alice).withdrawProceeds()).to.be.reverted;
      await expect(auction.connect(owner).withdrawProceeds()).to.changeEtherBalance(owner, ETH("30"));
      await expect(auction.connect(owner).withdrawProceeds()).to.be.revertedWith("already withdrawn");
    });

    it("AC43: sweep is blocked up to the deadline, then burns tokens and sends ETH to owner once", async function () {
      const { auction, owner, alice, bob } = await loadFixture(finalizedUndersoldFixture);
      const deadline = (await auction.finalizedAt()) + CLAIM_PERIOD;
      await time.setNextBlockTimestamp(deadline);
      await expect(auction.connect(owner).sweep()).to.be.revertedWith("claim period open");
      await time.setNextBlockTimestamp(deadline + 1n);
      await expect(auction.connect(alice).sweep()).to.be.reverted;

      const token = await ethers.getContractAt("LaunchToken", await auction.token());
      // Bob never claimed: his 30 tokens are burned, and the 30 ETH proceeds go to the owner.
      await expect(auction.connect(owner).sweep()).to.changeEtherBalance(owner, ETH("30"));
      expect(await token.totalSupply()).to.equal(0n);
      await expect(auction.connect(owner).sweep()).to.be.revertedWith("not finalized");
      await expect(auction.connect(bob).claim()).to.be.revertedWith("not claimable");
    });

    it("AC44: sweep includes proceeds that were never withdrawn", async function () {
      const { auction, owner } = await loadFixture(finalizedUndersoldFixture);
      await time.setNextBlockTimestamp((await auction.finalizedAt()) + CLAIM_PERIOD + 1n);
      const addr = await auction.getAddress();
      const before = await ethers.provider.getBalance(addr);
      expect(before).to.equal(ETH("30"));
      await expect(auction.connect(owner).sweep()).to.changeEtherBalance(owner, before);
    });

    it("AC45 (solvency): after all claims and withdrawal, contract ETH is never negative and leftover is dust", async function () {
      const { auction, owner, alice, bob, carol, t0 } = await loadFixture(startedFixture);
      await auction.connect(bob).bid(START_PRICE, { value: ETH("88") });
      await auction.connect(carol).bid(START_PRICE, { value: ETH("0.5") });
      await time.increaseTo(at(t0, 17, 5n));
      await auction.connect(alice).bid(ETH("1.2"), { value: ETH("13") });
      await auction.connect(alice).bid(ETH("1.2"), { value: ETH("20") });
      await auction.connect(owner).withdrawProceeds();
      for (const s of [bob, carol, alice]) {
        await auction.connect(s).claim();
      }
      expect(await ethers.provider.getBalance(await auction.getAddress())).to.be.lessThanOrEqual(3n);
    });
  });
});
