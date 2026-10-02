const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const SUPPLY = ethers.parseEther("1000");
const START_PRICE = ethers.parseEther("0.01");
const RESERVE_PRICE = ethers.parseEther("0.001");
const UNIT = 10n ** 18n;

describe("Reentrancy resistance", function () {
  it("baseline: the attack drains a contract that refunds before updating state", async function () {
    const [, victim, attackerEoa] = await ethers.getSigners();
    const cap = ethers.parseEther("5");
    const vulnerable = await ethers.deployContract("VulnerableAuction", [cap]);
    const attacker = await ethers.deployContract("ReentrancyAttacker", [vulnerable.target]);

    // An honest bidder's ETH sits in the contract.
    await vulnerable.connect(victim).bid({ value: ethers.parseEther("4") });

    // Attacker is owed a 1 ETH refund (2 ETH bid, 1 ETH of capacity left).
    await attacker.connect(attackerEoa).attack({ value: ethers.parseEther("2") });

    expect(await attacker.reentrySuccesses()).to.be.greaterThan(0);
    // It walked away with far more than the 1 ETH it was owed.
    expect(await ethers.provider.getBalance(attacker.target)).to.equal(ethers.parseEther("6"));
    expect(await ethers.provider.getBalance(vulnerable.target)).to.equal(0);
  });

  it("DutchAuction: the same attack only ever receives the refund it is owed", async function () {
    const [owner, victim, attackerEoa] = await ethers.getSigners();
    const token = await ethers.deployContract("LaunchToken", ["Launch Token", "LNCH", SUPPLY, owner.address]);
    const auction = await ethers.deployContract("DutchAuction", [
      token.target,
      SUPPLY,
      START_PRICE,
      RESERVE_PRICE,
      owner.address,
    ]);
    await token.approve(auction.target, SUPPLY);
    await auction.start();
    const startTime = Number(await auction.startTime());
    const attacker = await ethers.deployContract("ReentrancyAttacker", [auction.target]);

    await time.setNextBlockTimestamp(startTime + 100);
    await auction.connect(victim).bid({ value: ethers.parseEther("4") });

    // At t=600 the price is 0.0055 ETH, so the cap is 5.5 ETH: 1.5 ETH of capacity left.
    // A 3 ETH bid sells the auction out and leaves the attacker owed 1.5 ETH.
    await time.setNextBlockTimestamp(startTime + 600);
    await attacker.connect(attackerEoa).attack({ value: ethers.parseEther("3") });

    const owed = ethers.parseEther("1.5");
    expect(await attacker.reentryAttempts()).to.equal(1);
    expect(await attacker.reentrySuccesses()).to.equal(0);
    expect(await ethers.provider.getBalance(attacker.target)).to.equal(owed);
    expect(await auction.refunds(attacker.target)).to.equal(0);

    // Its token allocation is exactly what it paid for.
    const price = await auction.clearingPrice();
    expect(await token.balanceOf(attacker.target)).to.equal((ethers.parseEther("1.5") * UNIT) / price);

    // Everyone else's funds are intact: the contract still holds the full proceeds.
    expect(await ethers.provider.getBalance(auction.target)).to.equal(ethers.parseEther("5.5"));
    await expect(auction.connect(victim).claim()).to.changeTokenBalance(
      token,
      victim,
      (ethers.parseEther("4") * UNIT) / price
    );
    await expect(auction.withdrawProceeds()).to.changeEtherBalance(owner, ethers.parseEther("5.5"));
  });
});
