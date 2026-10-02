const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const SUPPLY = ethers.parseEther("1000");
const START_PRICE = ethers.parseEther("0.01");
const RESERVE_PRICE = ethers.parseEther("0.001");
const DURATION = 20 * 60;
const UNIT = 10n ** 18n;

const priceAt = (elapsed) =>
  START_PRICE - ((START_PRICE - RESERVE_PRICE) * BigInt(elapsed)) / BigInt(DURATION);

async function deployFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const token = await ethers.deployContract("LaunchToken", ["Launch Token", "LNCH", SUPPLY, owner.address]);
  const auction = await ethers.deployContract("DutchAuction", [
    token.target,
    SUPPLY,
    START_PRICE,
    RESERVE_PRICE,
    owner.address,
  ]);
  await token.approve(auction.target, SUPPLY);
  return { token, auction, owner, alice, bob, carol };
}

async function startedFixture() {
  const ctx = await deployFixture();
  await ctx.auction.start();
  const startTime = Number(await ctx.auction.startTime());
  return { ...ctx, startTime };
}

// Mines the next transaction exactly `elapsed` seconds after the auction start.
const bidAt = async (auction, startTime, bidder, elapsed, value) => {
  await time.setNextBlockTimestamp(startTime + elapsed);
  return auction.connect(bidder).bid({ value });
};

describe("DutchAuction", function () {
  describe("deployment and start", function () {
    it("rejects invalid parameters", async function () {
      const { token, owner } = await loadFixture(deployFixture);
      const Auction = await ethers.getContractFactory("DutchAuction");
      await expect(
        Auction.deploy(token.target, SUPPLY, RESERVE_PRICE, START_PRICE, owner.address)
      ).to.be.revertedWithCustomError(Auction, "InvalidParameters");
      await expect(
        Auction.deploy(token.target, 0, START_PRICE, RESERVE_PRICE, owner.address)
      ).to.be.revertedWithCustomError(Auction, "InvalidParameters");
    });

    it("only the owner can start, and only once", async function () {
      const { auction, token, alice } = await loadFixture(deployFixture);
      await expect(auction.connect(alice).start()).to.be.revertedWithCustomError(
        auction,
        "OwnableUnauthorizedAccount"
      );
      await auction.start();
      expect(await token.balanceOf(auction.target)).to.equal(SUPPLY);
      await expect(auction.start()).to.be.revertedWithCustomError(auction, "AlreadyStarted");
    });

    it("rejects bids before the start", async function () {
      const { auction, alice } = await loadFixture(deployFixture);
      await expect(auction.connect(alice).bid({ value: 1 })).to.be.revertedWithCustomError(auction, "NotStarted");
    });
  });

  describe("price decay", function () {
    it("falls linearly from start price to reserve price over 20 minutes", async function () {
      const { auction, startTime } = await loadFixture(startedFixture);
      expect(await auction.DURATION()).to.equal(DURATION);
      expect(await auction.currentPrice()).to.equal(START_PRICE);

      for (const elapsed of [1, 300, 600, 1199]) {
        await time.increaseTo(startTime + elapsed);
        expect(await auction.currentPrice()).to.equal(priceAt(elapsed));
      }
      await time.increaseTo(startTime + DURATION);
      expect(await auction.currentPrice()).to.equal(RESERVE_PRICE);
      await time.increaseTo(startTime + DURATION + 1000);
      expect(await auction.currentPrice()).to.equal(RESERVE_PRICE);
    });
  });

  describe("bidding", function () {
    it("records commitments and rejects zero bids", async function () {
      const { auction, alice, startTime } = await loadFixture(startedFixture);
      await expect(auction.connect(alice).bid({ value: 0 })).to.be.revertedWithCustomError(auction, "ZeroBid");

      const value = ethers.parseEther("1");
      await expect(bidAt(auction, startTime, alice, 60, value))
        .to.emit(auction, "BidPlaced")
        .withArgs(alice.address, value, 0, priceAt(60));
      expect(await auction.commitments(alice.address)).to.equal(value);
      expect(await auction.totalCommitted()).to.equal(value);
    });

    it("rejects bids once the 20 minutes are up", async function () {
      const { auction, alice, startTime } = await loadFixture(startedFixture);
      await expect(bidAt(auction, startTime, alice, DURATION, 1n)).to.be.revertedWithCustomError(
        auction,
        "AuctionEnded"
      );
    });

    it("cannot be finalized or claimed while still active", async function () {
      const { auction, alice, startTime } = await loadFixture(startedFixture);
      await bidAt(auction, startTime, alice, 60, ethers.parseEther("1"));
      await expect(auction.finalize()).to.be.revertedWithCustomError(auction, "AuctionStillActive");
      await expect(auction.connect(alice).claim()).to.be.revertedWithCustomError(auction, "AuctionStillActive");
    });
  });

  describe("sell-out by a bid that bridges the clearing threshold", function () {
    it("accepts only the remaining capacity, credits the surplus and clears at the current price", async function () {
      const { auction, token, owner, alice, bob, startTime } = await loadFixture(startedFixture);

      await bidAt(auction, startTime, alice, 100, ethers.parseEther("2"));

      const elapsed = 600;
      const price = priceAt(elapsed); // 0.0055 ETH
      const cap = (price * SUPPLY) / UNIT; // 5.5 ETH
      const bobBid = ethers.parseEther("5");
      const bobAccepted = cap - ethers.parseEther("2");
      const bobSurplus = bobBid - bobAccepted;

      await expect(bidAt(auction, startTime, bob, elapsed, bobBid))
        .to.emit(auction, "BidPlaced")
        .withArgs(bob.address, bobAccepted, bobSurplus, price)
        .and.to.emit(auction, "AuctionFinalized")
        .withArgs(price, SUPPLY, 0);

      expect(await auction.finalized()).to.equal(true);
      expect(await auction.clearingPrice()).to.equal(price);
      expect(await auction.refunds(bob.address)).to.equal(bobSurplus);
      expect(await auction.isActive()).to.equal(false);

      // Both pay the same clearing price even though Alice bid when it was higher.
      const aliceTokens = (ethers.parseEther("2") * UNIT) / price;
      const bobTokens = (bobAccepted * UNIT) / price;
      await expect(auction.connect(alice).claim()).to.changeTokenBalance(token, alice, aliceTokens);
      await expect(auction.connect(bob).claim()).to.changeEtherBalances(
        [bob, auction],
        [bobSurplus, -bobSurplus]
      );
      expect(await token.balanceOf(bob.address)).to.equal(bobTokens);

      // Whole supply distributed, bar rounding dust.
      expect(SUPPLY - aliceTokens - bobTokens).to.be.lessThan(2n);
      expect(await token.totalSupply()).to.equal(SUPPLY);

      await expect(auction.withdrawProceeds()).to.changeEtherBalances([owner, auction], [cap, -cap]);
      expect(await ethers.provider.getBalance(auction.target)).to.equal(0);

      await expect(bidAt(auction, startTime, alice, 700, 1n)).to.be.revertedWithCustomError(
        auction,
        "AuctionEnded"
      );
    });
  });

  describe("sell-out by price decay between bids", function () {
    it("clears at the price where demand met supply", async function () {
      const { auction, token, alice, bob, startTime } = await loadFixture(startedFixture);

      // 4 ETH committed => demand covers 1000 tokens once the price reaches 0.004 ETH.
      await bidAt(auction, startTime, alice, 100, ethers.parseEther("3"));
      await bidAt(auction, startTime, bob, 200, ethers.parseEther("1"));

      // By t=900 the curve is at 0.00325 ETH, below the 0.004 ETH clearing price.
      await time.increaseTo(startTime + 900);
      expect(await auction.isActive()).to.equal(false);
      expect(await auction.remainingCapacity()).to.equal(0);
      await expect(auction.connect(bob).bid({ value: 1 })).to.be.revertedWithCustomError(auction, "AuctionEnded");

      const expectedPrice = ethers.parseEther("0.004");
      await expect(auction.finalize()).to.emit(auction, "AuctionFinalized").withArgs(expectedPrice, SUPPLY, 0);
      await expect(auction.finalize()).to.be.revertedWithCustomError(auction, "AlreadyFinalized");

      await expect(auction.connect(alice).claim()).to.changeTokenBalance(token, alice, ethers.parseEther("750"));
      await expect(auction.connect(bob).claim()).to.changeTokenBalance(token, bob, ethers.parseEther("250"));
      expect(await token.balanceOf(auction.target)).to.equal(0);
    });
  });

  describe("time expiry without selling out", function () {
    it("settles at the reserve price and burns unsold tokens", async function () {
      const { auction, token, owner, alice, startTime } = await loadFixture(startedFixture);

      const value = ethers.parseEther("0.4"); // buys 400 tokens at the 0.001 reserve
      await bidAt(auction, startTime, alice, 1000, value);
      await time.increaseTo(startTime + DURATION);

      const sold = ethers.parseEther("400");
      const burned = SUPPLY - sold;
      // claim() finalizes on demand.
      await expect(auction.connect(alice).claim())
        .to.emit(auction, "AuctionFinalized")
        .withArgs(RESERVE_PRICE, sold, burned)
        .and.to.emit(auction, "Claimed")
        .withArgs(alice.address, sold, 0);

      expect(await token.balanceOf(alice.address)).to.equal(sold);
      expect(await token.totalSupply()).to.equal(sold);
      expect(await token.balanceOf(auction.target)).to.equal(0);
      await expect(auction.withdrawProceeds()).to.changeEtherBalance(owner, value);
    });

    it("burns the whole supply when nobody bids", async function () {
      const { auction, token, startTime } = await loadFixture(startedFixture);
      await time.increaseTo(startTime + DURATION);
      await auction.finalize();
      expect(await auction.tokensSold()).to.equal(0);
      expect(await token.totalSupply()).to.equal(0);
    });
  });

  describe("claims and proceeds", function () {
    it("prevents double claims and claims by non-bidders", async function () {
      const { auction, alice, carol, startTime } = await loadFixture(startedFixture);
      await bidAt(auction, startTime, alice, 10, ethers.parseEther("1"));
      await time.increaseTo(startTime + DURATION);

      await auction.connect(alice).claim();
      await expect(auction.connect(alice).claim()).to.be.revertedWithCustomError(auction, "NothingToClaim");
      await expect(auction.connect(carol).claim()).to.be.revertedWithCustomError(auction, "NothingToClaim");
    });

    it("only lets the owner withdraw proceeds, once, after the auction", async function () {
      const { auction, alice, startTime } = await loadFixture(startedFixture);
      await bidAt(auction, startTime, alice, 10, ethers.parseEther("1"));

      await expect(auction.withdrawProceeds()).to.be.revertedWithCustomError(auction, "AuctionStillActive");
      await time.increaseTo(startTime + DURATION);
      await expect(auction.connect(alice).withdrawProceeds()).to.be.revertedWithCustomError(
        auction,
        "OwnableUnauthorizedAccount"
      );
      await auction.withdrawProceeds();
      await expect(auction.withdrawProceeds()).to.be.revertedWithCustomError(auction, "ProceedsAlreadyWithdrawn");
    });

    it("never allocates more than the supply or pays out more ETH than it holds", async function () {
      const { auction, token, alice, bob, carol, startTime } = await loadFixture(startedFixture);

      // Awkward amounts to exercise rounding.
      await bidAt(auction, startTime, alice, 137, 1234567890123456789n);
      await bidAt(auction, startTime, bob, 421, 987654321098765433n);
      await bidAt(auction, startTime, carol, 777, 333333333333333337n);
      await time.increaseTo(startTime + DURATION);

      for (const bidder of [alice, bob, carol]) await auction.connect(bidder).claim();
      await auction.withdrawProceeds();

      const distributed =
        (await token.balanceOf(alice.address)) +
        (await token.balanceOf(bob.address)) +
        (await token.balanceOf(carol.address));
      expect(distributed).to.be.lessThanOrEqual(SUPPLY);
      expect(await token.totalSupply()).to.be.lessThanOrEqual(SUPPLY);
      expect(await ethers.provider.getBalance(auction.target)).to.equal(0);
    });
  });
});
