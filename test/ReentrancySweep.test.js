const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Review test (PR #19). AC47 is titled "every ETH-sending path", but test/Reentrancy.test.js
// never re-enters sweep(), which also sends ETH. This closes that gap.
// Limit: sweep() sets state to Swept before paying, so this test would also pass without the
// guard. It shows the payout happens once. The guard itself is proven by test/ReentrancyGuard.test.js.

const ETH = (v) => ethers.parseEther(v);
const SUPPLY = ETH("100");
const START_PRICE = ETH("2.9");
const RESERVE = ETH("1");
const STEP = 60n;
const MIN_BID = ETH("0.01");
const WINDOW = 1200n;

async function fixture() {
  const [, bob] = await ethers.getSigners();
  const attacker = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
  await attacker.waitForDeployment();
  return { attacker, bob };
}

describe("Reentrancy: sweep path (review, PR #19)", function () {
  it("AC47 (sweep): re-entering sweep from the owner's receive() is rejected and the payout is made once", async function () {
    const { attacker, bob } = await loadFixture(fixture);
    await attacker.deployDutch("Launch", "LCH", SUPPLY, START_PRICE, RESERVE, STEP, MIN_BID);
    const auction = await ethers.getContractAt("DutchAuction", await attacker.victim());
    const attackerAddr = await attacker.getAddress();

    // The attacker is the owner, so the sweep payout lands in its receive().
    await attacker.execute(auction.interface.encodeFunctionData("startAuction"), 0);
    await auction.connect(bob).bid(START_PRICE, { value: ETH("30") }); // undersold at reserve: 30 tokens, 30 ETH proceeds
    await time.increaseTo((await auction.startTime()) + WINDOW);
    await auction.finalize();
    await time.increaseTo((await auction.claimDeadline()) + 1n);

    await attacker.arm(auction.interface.encodeFunctionData("sweep"), 2);
    await expect(
      attacker.execute(auction.interface.encodeFunctionData("sweep"), 0)
    ).to.changeEtherBalance(attackerAddr, ETH("30"));

    expect(await attacker.reentries()).to.equal(1n);
    expect(await attacker.lastReentryOk()).to.equal(false);
    expect(await auction.state()).to.equal(3n); // Swept
  });
});
