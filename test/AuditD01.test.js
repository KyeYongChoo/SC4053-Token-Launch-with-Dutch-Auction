const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const W = 10n ** 18n;
const ceil = (a, b) => (a + b - 1n) / b;

describe("Audit D01: residual ETH accounting", function () {
  const cases = [
    { name: "original high-price zero-token counterexample", supply: W, start: 10n ** 24n, reserve: 5n * 10n ** 23n, bids: [[499999n]], counter: true },
    { name: "undersold aggregate token rounding", supply: 100n, bids: [[1n], [2n], [3n]], reserve: 3n * W + 1n },
    { name: "sold-out joiners with fractional fills", bids: [[40n], [110n]], branch: "join" },
    { name: "sold-out earlier tier with zero-fill joiner", bids: [[80n], [40n, 11n * W]], step: 9, branch: "early", withdrawFirst: true },
    { name: "sold-out mixed full early and fractional joining tiers", bids: [[30n], [100n, 10n * W]], step: 10, branch: "mixed" },
    { name: "cancelled and later ineligible bids excluded from charges", bids: [[40n, W, true], [40n, W], [150n]], branch: "join", withdrawFirst: true },
    { name: "multiple bids by one claimant and withdrawal first", supply: 100n, bids: [[1n], [2n], [3n]], sameAccount: true, withdrawFirst: true },
    { name: "zero bids", bids: [], supply: 100n },
  ];

  for (const s of cases) it(s.name, async function () {
    const [owner, ...users] = await ethers.getSigners();
    const start = s.start ?? 20n * W, reserve = s.reserve ?? W, supply = s.supply ?? 7n;
    const auction = await (await ethers.getContractFactory("DutchAuction")).deploy("Dust", "DST", supply, start, reserve, 60n, 1n);
    await auction.waitForDeployment(); await auction.startAuction();
    const records = [];
    for (let i = 0; i < s.bids.length; i++) {
      const [eth, max = start, cancel = false] = s.bids[i];
      const user = users[s.sameAccount ? 0 : i];
      await auction.connect(user).bid(max, { value: eth });
      const bid = await auction.getBid(i);
      records.push({ eth, user, step: bid.effectiveStep, cancel });
      if (cancel) await expect(auction.connect(user).cancelBid(i)).to.emit(auction, "BidCancelled").withArgs(i, user.address, eth);
    }
    await time.increaseTo(s.step !== undefined ? (await auction.startTime()) + BigInt(s.step) * 60n : await auction.endTime());
    await auction.finalize();
    const k = await auction.clearing();
    const active = records.filter(b => !b.cancel);
    const early = active.filter(b => b.step < k.step).reduce((v,b) => v+b.eth,0n);
    const join = active.filter(b => b.step === k.step).reduce((v,b) => v+b.eth,0n);
    const need = k.price * supply;
    if (s.branch === "early") { expect(k.soldOut).to.equal(true); expect(early*W >= need).to.equal(true); expect(join).to.be.greaterThan(0n); }
    if (s.branch === "mixed") { expect(k.soldOut).to.equal(true); expect(early).to.be.greaterThan(0n); expect(early*W < need).to.equal(true); }
    if (s.branch === "join") { expect(k.soldOut).to.equal(true); expect(early).to.equal(0n); }
    let charges = 0n, allocations = 0n;
    const totals = new Map();
    for (const b of active) {
      let num=1n, den=1n;
      if (b.step > k.step) num=0n;
      else if (k.soldOut) {
        if (early*W >= need) { num=b.step<k.step ? need : 0n; den=b.step<k.step ? early*W : 1n; }
        else if (b.step===k.step) { num=need-early*W; den=join*W; }
      }
      const charged=ceil(b.eth*num,den), tokens=b.eth*num*W/(den*k.price), refund=b.eth-charged;
      charges+=charged; allocations+=tokens;
      const t=totals.get(b.user.address) ?? { user:b.user,tokens:0n,refund:0n };
      t.tokens+=tokens; t.refund+=refund; totals.set(b.user.address,t);
    }
    expect(allocations).to.be.at.most(k.tokensSold);
    expect(k.proceeds).to.equal(k.price*k.tokensSold/W);
    expect(charges).to.be.at.least(k.proceeds);
    if (s.withdrawFirst) await auction.withdrawProceeds();
    for (const t of totals.values()) {
      const preview=await auction.previewClaim(t.user.address);
      expect(preview[0]).to.equal(t.tokens); expect(preview[1]).to.equal(t.refund);
      await expect(auction.connect(t.user).claim()).to.emit(auction,"Claimed").withArgs(t.user.address,t.tokens,t.refund);
      const token = await ethers.getContractAt("LaunchToken", await auction.token());
      expect(await token.balanceOf(t.user.address)).to.equal(t.tokens);
    }
    if (!s.withdrawFirst) await auction.withdrawProceeds();
    const residual=await ethers.provider.getBalance(auction.target);
    expect(residual).to.equal(charges-k.proceeds);
    if (s.counter) { expect(allocations).to.equal(0n); expect(charges).to.equal(499999n); expect(k.proceeds).to.equal(0n); expect(residual).to.equal(499999n); }
    const B=BigInt(active.length);
    expect(residual).to.be.lessThan(B+ceil(k.price,W));
    if (!k.soldOut) expect(residual).to.be.lessThan(ceil(k.price,W));
    else expect(residual).to.be.at.most(B);
    await time.increaseTo((await auction.claimDeadline())+1n);
    await expect(auction.sweep()).to.changeEtherBalance(owner,residual);
    expect(await ethers.provider.getBalance(auction.target)).to.equal(0n);
  });
});
