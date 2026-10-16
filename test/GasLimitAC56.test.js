const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, takeSnapshot, time } = require("@nomicfoundation/hardhat-network-helpers");
const path = require("path");
const { pathToFileURL } = require("url");

// AC56 (issue #40): bid work grows with each step since the last sell-out check, so an exact
// estimate made in step k runs out of gas in step k+1. The web app's limit, gasLimitFor from
// frontend/src/maths.js, must cover that step.
const ETH = (v) => ethers.parseEther(v);
const STEP = 60n;

async function startedFixture() {
  const [owner, alice] = await ethers.getSigners();
  const auction = await (await ethers.getContractFactory("DutchAuction")).deploy(
    "Launch Token", "LCH", ETH("100"), ETH("2.9"), ETH("1"), STEP, ETH("0.01")
  );
  await auction.startAuction();
  return { auction, alice, t0: await auction.startTime() };
}

describe("AC56: gas limit headroom across a step boundary", function () {
  let gasLimitFor;
  before(async function () {
    ({ gasLimitFor } = await import(pathToFileURL(path.join(__dirname, "..", "frontend", "src", "maths.js")).href));
  });

  for (const k of [0, 4]) {
    it(`a bid estimated against the pending block in step ${k} and mined in step ${k + 1} succeeds with ceil(G x 1.25)`, async function () {
      const { auction, alice, t0 } = await loadFixture(startedFixture);
      const tx = await auction.connect(alice).bid.populateTransaction(ETH("2.9"), { value: ETH("1") });
      await time.setNextBlockTimestamp(t0 + BigInt(k) * STEP + 1n);
      const rpcTx = { from: alice.address, to: tx.to, data: tx.data, value: ethers.toQuantity(tx.value) };
      const estimate = BigInt(await ethers.provider.send("eth_estimateGas", [rpcTx, "pending"]));

      const before = await takeSnapshot();
      await time.setNextBlockTimestamp(t0 + BigInt(k + 1) * STEP + 1n);
      await expect(alice.sendTransaction({ ...tx, gasLimit: estimate })).to.be.reverted; // the exact estimate is stale
      await before.restore();

      await time.setNextBlockTimestamp(t0 + BigInt(k + 1) * STEP + 1n);
      const receipt = await (await alice.sendTransaction({ ...tx, gasLimit: gasLimitFor(estimate) })).wait();
      expect(receipt.status).to.equal(1);
      expect(receipt.gasUsed).to.be.greaterThan(estimate);
      expect(await auction.currentStep()).to.equal(BigInt(k + 1));
    });
  }
});
