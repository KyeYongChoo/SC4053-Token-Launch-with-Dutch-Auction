const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Review tests (PR #18). Each test reproduces a finding in REVIEW.md and asserts the CURRENT,
// vulnerable behaviour so the suite stays green and documents the problem. When a finding is
// fixed, the matching assertion here will fail and should be flipped to the expected behaviour.

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
  describe("VULN-1: unbounded supply or price overflows the sell-out check and bricks the auction", function () {
    it("a supply of 2^200 token-wei is accepted, every bid reverts, and the auction can never finalize", async function () {
      const [owner, , bob] = await ethers.getSigners();
      const auction = await (
        await ethers.getContractFactory("DutchAuction")
      ).deploy("Launch", "LCH", 2n ** 200n, START_PRICE, RESERVE, STEP, MIN_BID);
      await auction.waitForDeployment();
      await auction.connect(owner).startAuction();

      // priceAt(0) * supply overflows uint256 inside _scan, so every call that advances the scan panics.
      await expect(auction.connect(bob).bid(START_PRICE, { value: MIN_BID })).to.be.revertedWithPanic(0x11);

      await time.increaseTo((await auction.endTime()) + 1n);
      await expect(auction.finalize()).to.be.revertedWithPanic(0x11);
      expect(await auction.state()).to.equal(1n); // still Active: sweep (which needs Finalized) is unreachable
    });
  });

  describe("VULN-2: owner can renounce ownership, locking proceeds with no recovery path", function () {
    it("after finalize, renouncing ownership makes withdrawProceeds and sweep permanently unreachable", async function () {
      const { auction, owner, bob } = await loadFixture(deployed);
      await auction.connect(owner).startAuction();
      await auction.connect(bob).bid(START_PRICE, { value: ETH("30") });
      await time.increaseTo((await auction.startTime()) + WINDOW);
      await auction.finalize();
      const proceeds = await auction.proceeds();

      await auction.connect(owner).renounceOwnership(); // inherited from Ownable; not restricted by the contract
      expect(await auction.owner()).to.equal(ethers.ZeroAddress);

      await expect(auction.connect(owner).withdrawProceeds()).to.be.revertedWithCustomError(
        auction,
        "OwnableUnauthorizedAccount"
      );
      await time.increaseTo((await auction.claimDeadline()) + 1n);
      await expect(auction.connect(owner).sweep()).to.be.revertedWithCustomError(auction, "OwnableUnauthorizedAccount");

      // Proceeds stay in the contract for good. Bidders can still claim, so only the owner's money is affected.
      expect(await ethers.provider.getBalance(await auction.getAddress())).to.be.greaterThanOrEqual(proceeds);
    });
  });

  describe("VULN-3: owner role is transferable through inherited Ownable, which SPEC.md does not allow", function () {
    it("the owner can hand withdrawProceeds and sweep to another address, and the deployer loses them", async function () {
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
