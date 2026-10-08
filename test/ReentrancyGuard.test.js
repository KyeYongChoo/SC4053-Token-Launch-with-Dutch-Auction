const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Review test (PR #19). checks-effects-interactions already blocks re-entry into the SAME bid,
// so the existing AC47 tests pass with nonReentrant removed. Re-entering cancelBid for a DIFFERENT
// bid of the same bidder is only blocked by the guard, so this test fails if the guard is removed.

const ETH = (v) => ethers.parseEther(v);
const SUPPLY = ETH("100");
const START_PRICE = ETH("2.9");
const RESERVE = ETH("1");
const STEP = 60n;
const MIN_BID = ETH("0.01");

async function fixture() {
  const [, bob] = await ethers.getSigners();
  const attacker = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
  await attacker.waitForDeployment();
  return { attacker, bob };
}

describe("Reentrancy guard: cross-bid re-entry (review, PR #19)", function () {
  it("AC47 (guard): re-entering cancelBid for another bid of the same bidder is rejected by nonReentrant", async function () {
    const { attacker, bob } = await loadFixture(fixture);
    await attacker.deployDutch("Launch", "LCH", SUPPLY, START_PRICE, RESERVE, STEP, MIN_BID);
    const auction = await ethers.getContractAt("DutchAuction", await attacker.victim());
    const attackerAddr = await attacker.getAddress();

    await attacker.execute(auction.interface.encodeFunctionData("startAuction"), 0);
    // Two standing orders from the attacker (max price 1.5 is below P0, so both join later steps).
    await attacker.execute(auction.interface.encodeFunctionData("bid", [ETH("1.5")]), ETH("5"), { value: ETH("5") });
    await attacker.execute(auction.interface.encodeFunctionData("bid", [ETH("1.5")]), ETH("5"), { value: ETH("5") });
    await auction.connect(bob).bid(START_PRICE, { value: MIN_BID }); // live, keeps the auction Active

    // Refund of bid 0 is sent to receive(), which then tries to cancel bid 1 (a different, untouched bid).
    await attacker.arm(auction.interface.encodeFunctionData("cancelBid", [1]), 1);
    await expect(
      attacker.execute(auction.interface.encodeFunctionData("cancelBid", [0]), 0)
    ).to.changeEtherBalance(attackerAddr, ETH("5")); // only bid 0 is refunded

    expect((await auction.getBid(1)).cancelled).to.equal(false);
    expect(await attacker.lastReentryOk()).to.equal(false);
  });
});
