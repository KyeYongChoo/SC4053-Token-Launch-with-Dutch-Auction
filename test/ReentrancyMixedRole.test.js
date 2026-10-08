const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Review follow-up (PR #19): one attacker is both the owner and a bidder. The nonReentrant guard
// is shared by every ETH-sending function, so a re-entry from one role into the other must be
// rejected, and the bidder's own settlement must still happen exactly once.

const ETH = (v) => ethers.parseEther(v);
const SUPPLY = ETH("100");
const START_PRICE = ETH("2.9");
const RESERVE = ETH("1");
const STEP = 60n;
const MIN_BID = ETH("0.01");
const WINDOW = 1200n;

const GUARD_SELECTOR = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
const isGuardRevert = (data) => ethers.hexlify(data).slice(0, 10) === GUARD_SELECTOR;

// The attacker deploys the auction, so it is the owner. It also bids 40 ETH live at step 0.
// Bob bids 85 ETH, so the auction sells out at step 17 with no further transaction.
// Attacker's share: charged 38.4 ETH, refunded 1.6 ETH, 32 tokens. Proceeds: 120 ETH.
async function soldOutFixture() {
  const [, bob] = await ethers.getSigners();
  const attacker = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
  await attacker.waitForDeployment();
  await attacker.deployDutch("Launch", "LCH", SUPPLY, START_PRICE, RESERVE, STEP, MIN_BID);
  const auction = await ethers.getContractAt("DutchAuction", await attacker.victim());
  const token = await ethers.getContractAt("LaunchToken", await auction.token());
  const addr = await attacker.getAddress();

  await attacker.execute(auction.interface.encodeFunctionData("startAuction"), 0);
  const t0 = await auction.startTime();
  await attacker.execute(auction.interface.encodeFunctionData("bid", [START_PRICE]), ETH("40"), { value: ETH("40") });
  await auction.connect(bob).bid(START_PRICE, { value: ETH("85") });
  await time.increaseTo(t0 + WINDOW);
  return { attacker, auction, token, addr };
}

describe("Reentrancy: mixed-role attacker (owner and bidder)", function () {
  it("owner payout re-enters the bidder's claim: rejected by the guard, and the claim settles once afterwards", async function () {
    const { attacker, auction, token, addr } = await loadFixture(soldOutFixture);
    await auction.finalize();
    const proceeds = await auction.proceeds();
    expect(proceeds).to.equal(ETH("120"));

    // Paying the owner's proceeds sends ETH to receive(), which tries to claim as the bidder.
    await attacker.arm(auction.interface.encodeFunctionData("claim"), 2);
    await expect(
      attacker.execute(auction.interface.encodeFunctionData("withdrawProceeds"), 0)
    ).to.changeEtherBalance(addr, proceeds);
    expect(await attacker.reentries()).to.equal(1n);
    expect(await attacker.lastReentryOk()).to.equal(false);
    expect(isGuardRevert(await attacker.lastReentryReturn())).to.equal(true); // guard: nonReentrant on claim

    // Disarm, then claim normally: the bidder's settlement is intact and paid exactly once.
    await attacker.arm("0x", 0);
    await expect(
      attacker.execute(auction.interface.encodeFunctionData("claim"), 0)
    ).to.changeEtherBalance(addr, ETH("1.6"));
    expect(await token.balanceOf(addr)).to.equal(ETH("32"));
  });

  it("bidder refund re-enters the owner's withdrawProceeds: rejected by the guard, and proceeds are paid once afterwards", async function () {
    const { attacker, auction, token, addr } = await loadFixture(soldOutFixture);
    await auction.finalize();
    const proceeds = await auction.proceeds();

    // The refund sends ETH to receive(), which tries the owner-only withdrawal.
    await attacker.arm(auction.interface.encodeFunctionData("withdrawProceeds"), 2);
    await expect(
      attacker.execute(auction.interface.encodeFunctionData("claim"), 0)
    ).to.changeEtherBalance(addr, ETH("1.6"));
    expect(await attacker.reentries()).to.equal(1n);
    expect(await attacker.lastReentryOk()).to.equal(false);
    expect(isGuardRevert(await attacker.lastReentryReturn())).to.equal(true); // guard: nonReentrant on withdrawProceeds
    expect(await token.balanceOf(addr)).to.equal(ETH("32"));

    // Disarm, then withdraw normally: exactly the proceeds, once.
    await attacker.arm("0x", 0);
    await expect(
      attacker.execute(auction.interface.encodeFunctionData("withdrawProceeds"), 0)
    ).to.changeEtherBalance(addr, proceeds);
    await expect(
      attacker.execute(auction.interface.encodeFunctionData("withdrawProceeds"), 0)
    ).to.be.revertedWith("already withdrawn");
  });
});
