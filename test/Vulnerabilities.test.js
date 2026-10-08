const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Regression tests for the review findings on PR #18. Each test asserts the FIXED behaviour
// agreed in the review: bounded supply and price (SPEC §2.1), renounce disabled and transfer
// allowed (SPEC §1).

const ETH = (v) => ethers.parseEther(v);
const SUPPLY = ETH("100");
const START_PRICE = ETH("2.9");
const RESERVE = ETH("1");
const STEP = 60n;
const MIN_BID = ETH("0.01");
const WINDOW = 1200n;

async function deployed() {
  const [owner, alice, bob] = await ethers.getSigners();
  const auction = await (
    await ethers.getContractFactory("DutchAuction")
  ).deploy("Launch", "LCH", SUPPLY, START_PRICE, RESERVE, STEP, MIN_BID);
  await auction.waitForDeployment();
  return { auction, owner, alice, bob };
}

describe("Review findings (PR #18)", function () {
  describe("VULN-1: supply and price are bounded so the sell-out check cannot overflow", function () {
    it("rejects a supply above MAX_SUPPLY (1e30 token-wei)", async function () {
      const F = await ethers.getContractFactory("DutchAuction");
      await expect(F.deploy("Launch", "LCH", 2n ** 200n, START_PRICE, RESERVE, STEP, MIN_BID)).to.be.revertedWith(
        "supply too large"
      );
      await expect(F.deploy("Launch", "LCH", 10n ** 30n + 1n, START_PRICE, RESERVE, STEP, MIN_BID)).to.be.revertedWith(
        "supply too large"
      );
    });

    it("rejects a start price above MAX_START_PRICE (1e24 wei)", async function () {
      const F = await ethers.getContractFactory("DutchAuction");
      await expect(F.deploy("Launch", "LCH", SUPPLY, 10n ** 24n + 1n, RESERVE, STEP, MIN_BID)).to.be.revertedWith(
        "price too large"
      );
    });

    it("accepts the maximum supply and price, and bids still settle at the bounds", async function () {
      const [owner, , bob] = await ethers.getSigners();
      const F = await ethers.getContractFactory("DutchAuction");
      const auction = await F.deploy("Launch", "LCH", 10n ** 30n, 10n ** 24n, 10n ** 23n, STEP, MIN_BID);
      await auction.waitForDeployment();
      await auction.connect(owner).startAuction();
      await expect(auction.connect(bob).bid(10n ** 24n, { value: MIN_BID })).to.not.be.reverted;
      await time.increaseTo((await auction.endTime()) + 1n);
      await expect(auction.finalize()).to.emit(auction, "AuctionFinalized");
    });
  });

  describe("VULN-2: owner cannot renounce ownership", function () {
    it("renounceOwnership reverts, so proceeds and the sweep always have an owner", async function () {
      const { auction, owner } = await loadFixture(deployed);
      await expect(auction.connect(owner).renounceOwnership()).to.be.revertedWith("renounce disabled");
      expect(await auction.owner()).to.equal(owner.address);
    });
  });

  describe("VULN-3: owner role can be transferred (SPEC §1 amended)", function () {
    it("transferOwnership moves withdrawProceeds and sweep to the new owner", async function () {
      const { auction, owner, alice, bob } = await loadFixture(deployed);
      await auction.connect(owner).startAuction();
      await auction.connect(bob).bid(START_PRICE, { value: ETH("30") });
      await time.increaseTo((await auction.startTime()) + WINDOW);
      await auction.finalize();
      const proceeds = await auction.proceeds();

      await auction.connect(owner).transferOwnership(alice.address);
      await expect(auction.connect(owner).withdrawProceeds()).to.be.revertedWithCustomError(
        auction,
        "OwnableUnauthorizedAccount"
      );
      await expect(auction.connect(alice).withdrawProceeds()).to.changeEtherBalance(alice, proceeds);
    });
  });
});
