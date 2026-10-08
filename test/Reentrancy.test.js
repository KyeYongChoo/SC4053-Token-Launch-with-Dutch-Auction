const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Bonus: reentrancy demonstration (SPEC §4 test-only contracts, §7 AC 46–47).
const ETH = (v) => ethers.parseEther(v);
const SUPPLY = ETH("100");
const START_PRICE = ETH("2.9");
const RESERVE = ETH("1");
const STEP = 60n;
const MIN_BID = ETH("0.01");
const WINDOW = 1200n;

async function fixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const attacker = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
  await attacker.waitForDeployment();
  return { attacker, owner, alice, bob, carol };
}

describe("Reentrancy", function () {
  describe("AC46: VulnerableAuction (test-only) is drained by re-entering claim", function () {
    it("attacker receives its deposit many times over, taking honest funds", async function () {
      const { attacker, bob } = await loadFixture(fixture);
      await attacker.deployVulnerable();
      const vulnAddr = await attacker.victim();
      const vuln = await ethers.getContractAt("VulnerableAuction", vulnAddr);

      await vuln.connect(bob).deposit({ value: ETH("10") }); // honest depositor
      await attacker.execute(vuln.interface.encodeFunctionData("deposit"), ETH("1"), { value: ETH("1") });

      const claimData = vuln.interface.encodeFunctionData("claim");
      await attacker.arm(claimData, 3); // re-enter three more times
      const attackerAddr = await attacker.getAddress();

      // 1 ETH deposited, claim + 3 re-entries pay out 4 ETH.
      await expect(attacker.execute(claimData, 0)).to.changeEtherBalance(attackerAddr, ETH("4"));
      expect(await ethers.provider.getBalance(vulnAddr)).to.equal(ETH("7")); // bob's 10 ETH lost 3 ETH
    });
  });

  describe("AC47: DutchAuction resists re-entry through every ETH-sending path", function () {
    it("claim refund: re-entering claim is rejected and the refund is exact", async function () {
      const { attacker, owner, bob } = await loadFixture(fixture);
      await attacker.deployDutch("Launch", "LCH", SUPPLY, START_PRICE, RESERVE, STEP, MIN_BID);
      const auction = await ethers.getContractAt("DutchAuction", await attacker.victim());
      const attackerAddr = await attacker.getAddress();

      await attacker.execute(auction.interface.encodeFunctionData("startAuction"), 0);
      const t0 = await auction.startTime();
      // 125 ETH live at step 0. Need is 130 at step 16 (not met) and 120 at step 17 (met),
      // so the auction sells out at step 17 with no further transaction.
      await attacker.execute(auction.interface.encodeFunctionData("bid", [START_PRICE]), ETH("40"), { value: ETH("40") });
      await auction.connect(bob).bid(START_PRICE, { value: ETH("85") });
      // Attacker's share: f = 120/125, so it is charged 38.4 ETH and refunded 1.6 ETH.

      await attacker.arm(auction.interface.encodeFunctionData("claim"), 3);
      await time.increaseTo(t0 + WINDOW);
      const [, expectedRefund] = await auction.previewClaim(attackerAddr);
      expect(expectedRefund).to.be.greaterThan(0n);
      await expect(attacker.execute(auction.interface.encodeFunctionData("claim"), 0)).to.changeEtherBalance(
        attackerAddr,
        expectedRefund
      );
      expect(await attacker.reentries()).to.equal(1n);
      expect(await attacker.lastReentryOk()).to.equal(false);
    });

    it("cancelBid refund: re-entering cancelBid is rejected; refund paid once", async function () {
      const { attacker, bob } = await loadFixture(fixture);
      await attacker.deployDutch("Launch", "LCH", SUPPLY, START_PRICE, RESERVE, STEP, MIN_BID);
      const auction = await ethers.getContractAt("DutchAuction", await attacker.victim());
      const attackerAddr = await attacker.getAddress();
      await attacker.execute(auction.interface.encodeFunctionData("startAuction"), 0);
      await attacker.execute(auction.interface.encodeFunctionData("bid", [ETH("1.5")]), ETH("5"), { value: ETH("5") }); // standing
      await auction.connect(bob).bid(START_PRICE, { value: MIN_BID });

      await attacker.arm(auction.interface.encodeFunctionData("cancelBid", [0]), 2);
      await expect(attacker.execute(auction.interface.encodeFunctionData("cancelBid", [0]), 0)).to.changeEtherBalance(
        attackerAddr,
        ETH("5")
      );
      expect(await attacker.lastReentryOk()).to.equal(false);
    });

    it("withdrawProceeds: re-entering withdrawProceeds or claim from the owner's receive() is rejected", async function () {
      const { attacker, bob } = await loadFixture(fixture);
      await attacker.deployDutch("Launch", "LCH", SUPPLY, START_PRICE, RESERVE, STEP, MIN_BID);
      const auction = await ethers.getContractAt("DutchAuction", await attacker.victim());
      const attackerAddr = await attacker.getAddress();
      await attacker.execute(auction.interface.encodeFunctionData("startAuction"), 0);
      await attacker.execute(auction.interface.encodeFunctionData("bid", [START_PRICE]), ETH("2"), { value: ETH("2") });
      await auction.connect(bob).bid(START_PRICE, { value: ETH("30") });
      await time.increaseTo((await auction.startTime()) + WINDOW);
      await auction.finalize();
      const proceeds = await auction.proceeds(); // 32 ETH: undersold at reserve 1.0 for 32 tokens

      // The attacker is the owner, so the proceeds payment sends ETH to its receive().
      await attacker.arm(auction.interface.encodeFunctionData("withdrawProceeds"), 2);
      await expect(
        attacker.execute(auction.interface.encodeFunctionData("withdrawProceeds"), 0)
      ).to.changeEtherBalance(attackerAddr, proceeds);
      expect(await attacker.lastReentryOk()).to.equal(false);
    });
  });
});
