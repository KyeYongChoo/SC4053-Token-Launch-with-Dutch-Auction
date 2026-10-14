const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, mine, time } = require("@nomicfoundation/hardhat-network-helpers");

// R13 (issue #21): finalize() and previewClaim() walk up to MAX_STEPS = 120 steps, and claim()
// walks the caller's bids. These tests build the worst case for each loop and fail if the gas
// used exceeds the budget below. Budgets are the measured cost plus about 20% headroom.
//
// The step loops are bounded by MAX_STEPS. The bid loop in claim() is not: it grows with the
// caller's own bid count, so the per-bid budget caps how many bids one claim can settle in a
// transaction. Since Fusaka, EIP-7825 caps a transaction at 2^24 gas whatever the block size
// (Hardhat's 30M block is not the limit on Sepolia or mainnet): 2^24 / 37k is about 450 bids.
// Only the caller's own bids are walked, so nobody can grow another bidder's claim.
const TX_GAS_CAP = 16_777_216n; // EIP-7825
const BUDGET = {
  finalize: 860_000n, // measured 713k
  claim: 5_400_000n, // auto-finalize + 120 bids, measured 4.45M
  claimPerBid: 37_000n, // measured about 31k
  previewClaim: 2_100_000n, // measured 1.72M
};

// 10 s steps => N = 120, the most the constructor accepts (SPEC §2.1).
const ETH = (v) => ethers.parseEther(v);
const SUPPLY = ETH("100");
const START_PRICE = ETH("2.9");
const RESERVE = ETH("1");
const STEP = 10n;
const STEP_COUNT = 120;
const MIN_BID = ETH("0.01");
const WINDOW = 1200n;

/**
 * Started auction where bob holds one standing order joining at every step, all placed in the
 * first block. No call touches the auction afterwards, so finalize must scan all 120 steps.
 * `amountAt(k)` is the ETH joining at step k.
 */
async function worstCase(amountAt) {
  const [owner, bob] = await ethers.getSigners();
  const auction = await (await ethers.getContractFactory("DutchAuction")).deploy(
    "Launch Token", "LCH", SUPPLY, START_PRICE, RESERVE, STEP, MIN_BID
  );
  await auction.startAuction();
  const t0 = await auction.startTime();
  expect(await auction.stepCount()).to.equal(BigInt(STEP_COUNT));

  // One block for all 120 bids, so every bid is placed at step 0.
  await network.provider.send("evm_setAutomine", [false]);
  try {
    for (let k = 0; k < STEP_COUNT; k++) {
      await auction.connect(bob).bid(await auction.priceAt(k), { value: amountAt(k), gasLimit: 300_000 });
    }
    await mine();
  } finally {
    await network.provider.send("evm_setAutomine", [true]);
  }

  expect(await auction.bidCount()).to.equal(BigInt(STEP_COUNT));
  for (let k = 0; k < STEP_COUNT; k++) {
    expect(await auction.stepJoinAmount(k)).to.equal(amountAt(k));
  }
  return { auction, owner, bob, t0 };
}

// Undersold: 0.5 ETH joins at every step (60 ETH in total, below the 100 ETH reserve value).
const undersoldFixture = () => worstCase(() => ETH("0.5"));

// Sells out exactly at the last step: 0.5 ETH at steps 0-118, and 40.5 ETH at step 119, so that
// the total of 100 ETH equals reserve * supply.
const soldOutAtLastStepFixture = () => worstCase((k) => (k === STEP_COUNT - 1 ? ETH("40.5") : ETH("0.5")));

async function gasOf(txPromise) {
  return (await (await txPromise).wait()).gasUsed;
}

describe("Gas bounds at 120 steps (R13)", function () {
  for (const [name, fixture, soldOut] of [
    ["undersold", undersoldFixture, false],
    ["sold out at the last step", soldOutAtLastStepFixture, true],
  ]) {
    describe(name, function () {
      it(`R13: finalize scans all 120 steps within ${BUDGET.finalize} gas`, async function () {
        const { auction, t0 } = await loadFixture(fixture);
        await time.increaseTo(t0 + WINDOW);
        const gas = await gasOf(auction.finalize());
        expect(await auction.soldOut()).to.equal(soldOut);
        expect(await auction.clearingStep()).to.equal(BigInt(STEP_COUNT - 1));
        expect(gas).to.be.lte(BUDGET.finalize);
      });

      it(`R13: claim that auto-finalizes and settles 120 bids within ${BUDGET.claim} gas`, async function () {
        // claim() runs _ensureFinalized first, so this is the most one transaction can do.
        const { auction, bob, t0 } = await loadFixture(fixture);
        await time.increaseTo(t0 + WINDOW);
        const gas = await gasOf(auction.connect(bob).claim());
        expect(await auction.state()).to.equal(2n); // Finalized
        expect((await auction.getBid(STEP_COUNT - 1)).claimed).to.equal(true);
        expect(gas).to.be.lte(BUDGET.claim);
      });

      it(`R13: claim after finalize costs at most ${BUDGET.claimPerBid} gas per bid`, async function () {
        const { auction, bob, t0 } = await loadFixture(fixture);
        await time.increaseTo(t0 + WINDOW);
        await auction.finalize();
        const perBid = (await gasOf(auction.connect(bob).claim())) / BigInt(STEP_COUNT);
        // At this cost one claim settles about TX_GAS_CAP / claimPerBid bids.
        expect(perBid).to.be.lte(BUDGET.claimPerBid);
      });

      it(`R13: previewClaim over 120 bids and 120 steps within ${BUDGET.previewClaim} gas`, async function () {
        // Before finalize, previewClaim projects the clearing, which repeats the step scan.
        const { auction, bob, t0 } = await loadFixture(fixture);
        await time.increaseTo(t0 + WINDOW);
        const gas = await auction.previewClaim.estimateGas(bob.address);
        expect(gas).to.be.lte(BUDGET.previewClaim);
      });
    });
  }
});
