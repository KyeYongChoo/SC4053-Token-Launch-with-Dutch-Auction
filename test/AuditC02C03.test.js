const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ETH = ethers.parseEther;
const SUPPLY = ETH("100");
const START_PRICE = ETH("2.9");
const RESERVE = ETH("1");

async function contractOwnerFixture() {
  const [, bidder, newOwner] = await ethers.getSigners();
  const recipient = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
  await recipient.waitForDeployment();
  await recipient.deployDutch("Launch", "LCH", SUPPLY, START_PRICE, RESERVE, 60n, ETH("0.01"));
  const auction = await ethers.getContractAt("DutchAuction", await recipient.victim());
  await recipient.execute(auction.interface.encodeFunctionData("startAuction"), 0);
  await auction.connect(bidder).bid(START_PRICE, { value: ETH("30") });
  await time.increaseTo(await auction.endTime());
  return { auction, recipient, newOwner };
}

async function ordinaryOwnerFixture() {
  const [owner, bidder, newOwner] = await ethers.getSigners();
  const auction = await (await ethers.getContractFactory("DutchAuction")).deploy(
    "Launch", "LCH", SUPPLY, START_PRICE, RESERVE, 60n, ETH("0.01")
  );
  await auction.waitForDeployment();
  await auction.startAuction();
  await auction.connect(bidder).bid(START_PRICE, { value: ETH("30") });
  await time.increaseTo(await auction.endTime());
  return { auction, owner, newOwner };
}

function proceedsEvent(auction, receipt) {
  const events = receipt.logs
    .filter((log) => log.address.toLowerCase() === auction.target.toLowerCase())
    .map((log) => auction.interface.parseLog(log))
    .filter((event) => event && event.name === "ProceedsWithdrawn");
  expect(events).to.have.length(1);
  return events[0];
}

describe("Audit C02/C03 regression tests", function () {
  describe("C02: constructor enforces AC2/AC9 strictly decreasing integer prices", function () {
    for (const [steps, gap, label] of [
      [20n, 1n, "reported tiny spread"],
      [120n, 1n, "Yifan's 120-step example"],
      [20n, 18n, "one below the 20-step boundary"],
      [120n, 118n, "one below the 120-step boundary"],
    ]) {
      it(`AC2/C02: rejects ${label} (N=${steps}, gap=${gap})`, async function () {
        const factory = await ethers.getContractFactory("DutchAuction");
        await expect(factory.deploy("Launch", "LCH", ETH("1"), 1n + gap, 1n, 1200n / steps, 1n))
          .to.be.revertedWith("price spread");
      });
    }

    for (const steps of [2n, 20n, 120n]) {
      for (const gap of [steps - 1n, steps]) {
        it(`AC9/C02: accepts N=${steps}, gap=${gap} with exact endpoints and every step decreasing`, async function () {
          const startPrice = 1n + gap;
          const auction = await (await ethers.getContractFactory("DutchAuction"))
            .deploy("Launch", "LCH", ETH("1"), startPrice, 1n, 1200n / steps, 1n);
          await auction.waitForDeployment();
          expect(await auction.stepCount()).to.equal(steps);
          let previous;
          for (let k = 0n; k < steps; k++) {
            const price = await auction.priceAt(k);
            expect(price).to.equal(startPrice - (k * gap) / (steps - 1n));
            if (previous !== undefined) expect(price).to.be.lessThan(previous);
            if (k < steps - 1n) expect(price).to.be.greaterThan(1n);
            previous = price;
          }
          expect(await auction.priceAt(0)).to.equal(startPrice);
          expect(previous).to.equal(1n);
        });
      }
    }
  });

  describe("C03: AC42 payout events identify the actual ETH recipient", function () {
    for (const finalized of [true, false]) {
      it(`AC42/C03: ownership changes during ${finalized ? "finalized" : "auto-finalizing"} payout, event still names recipient`, async function () {
        const { auction, recipient, newOwner } = await loadFixture(contractOwnerFixture);
        if (finalized) await auction.finalize();
        const address = await recipient.getAddress();
        const recipientBefore = await ethers.provider.getBalance(address);
        const newOwnerBefore = await ethers.provider.getBalance(newOwner.address);
        const auctionBefore = await ethers.provider.getBalance(auction.target);
        await recipient.arm(auction.interface.encodeFunctionData("transferOwnership", [newOwner.address]), 1);
        const receipt = await (await recipient.execute(auction.interface.encodeFunctionData("withdrawProceeds"), 0)).wait();
        const amount = await auction.proceeds();
        expect(amount).to.equal(ETH("30"));
        expect(await ethers.provider.getBalance(address)).to.equal(recipientBefore + amount);
        expect(await ethers.provider.getBalance(newOwner.address)).to.equal(newOwnerBefore);
        expect(await ethers.provider.getBalance(auction.target)).to.equal(auctionBefore - amount);
        expect(await recipient.reentries()).to.equal(1n);
        expect(await recipient.lastReentryOk()).to.equal(true);
        expect(await auction.owner()).to.equal(newOwner.address);
        expect(await auction.proceedsWithdrawn()).to.equal(true);
        expect(await auction.state()).to.equal(2n);
        await expect(auction.connect(newOwner).withdrawProceeds()).to.be.revertedWith("already withdrawn");
        const event = proceedsEvent(auction, receipt);
        expect(event.args.amount).to.equal(amount);
        // Keep this last: balances, successful callback and once-only accounting are checked first.
        expect(event.args.owner).to.equal(address);
      });
    }

    it("AC42/C03: ordinary owner payout event and balance agree", async function () {
      const { auction, owner } = await loadFixture(ordinaryOwnerFixture);
      const tx = auction.withdrawProceeds();
      await expect(tx).to.changeEtherBalance(owner, ETH("30"));
      await expect(tx).to.emit(auction, "ProceedsWithdrawn").withArgs(owner.address, ETH("30"));
    });

    it("AC42/C03: ownership transferred before withdrawal pays and reports the new owner", async function () {
      const { auction, owner, newOwner } = await loadFixture(ordinaryOwnerFixture);
      await auction.transferOwnership(newOwner.address);
      await expect(auction.connect(owner).withdrawProceeds())
        .to.be.revertedWithCustomError(auction, "OwnableUnauthorizedAccount").withArgs(owner.address);
      const tx = auction.connect(newOwner).withdrawProceeds();
      await expect(tx).to.changeEtherBalance(newOwner, ETH("30"));
      await expect(tx).to.emit(auction, "ProceedsWithdrawn").withArgs(newOwner.address, ETH("30"));
      await expect(auction.connect(newOwner).withdrawProceeds()).to.be.revertedWith("already withdrawn");
    });

    it("AC42/C03: zero proceeds emit the owner and zero without invoking its callback", async function () {
      const [, newOwner] = await ethers.getSigners();
      const recipient = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
      await recipient.waitForDeployment();
      await recipient.deployDutch("Launch", "LCH", SUPPLY, START_PRICE, RESERVE, 60n, 1n);
      const auction = await ethers.getContractAt("DutchAuction", await recipient.victim());
      await recipient.execute(auction.interface.encodeFunctionData("startAuction"), 0);
      await time.increaseTo(await auction.endTime());
      await recipient.arm(auction.interface.encodeFunctionData("transferOwnership", [newOwner.address]), 1);
      const tx = recipient.execute(auction.interface.encodeFunctionData("withdrawProceeds"), 0);
      await expect(tx).to.emit(auction, "ProceedsWithdrawn").withArgs(await recipient.getAddress(), 0n);
      expect(await recipient.reentries()).to.equal(0n);
      expect(await auction.owner()).to.equal(await recipient.getAddress());
      expect(await auction.proceedsWithdrawn()).to.equal(true);
      await expect(recipient.execute(auction.interface.encodeFunctionData("withdrawProceeds"), 0))
        .to.be.revertedWith("already withdrawn");
    });
  });
});
