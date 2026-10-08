# Review: PR #19, reentrancy demonstration and guard tests

- **PR:** #19, `m2-reentrancy` into `m1-contracts` (stacked on #18)
- **Scope:** `contracts/test/VulnerableAuction.sol`, `contracts/test/ReentrancyAttacker.sol`, `test/Reentrancy.test.js`. No change to `DutchAuction.sol`.
- **Verdict:** Changes requested for F1 (the AC47 tests do not prove the guards exist). F2 is a test gap. The rest is informational.

## Verification run
- `npx hardhat test test/Reentrancy.test.js`: 4 passing (reproduced).
- Full suite on the branch: 47 passing (reproduced).
- Added in the review commit: `test/ReentrancySweep.test.js` (1) and `test/ReentrancyGuard.test.js` (1). Full suite after the review commit: 49 passing.

## Findings

### F1: Medium, test quality. The AC47 tests pass with all four `nonReentrant` guards removed
- **Reproduced:** I removed `nonReentrant` from `withdrawProceeds`, `sweep`, `cancelBid` and `claim` in a scratch copy. All four existing AC47 tests still passed.
- **Cause:** checks-effects-interactions already blocks most re-entries. `claimed`, `cancelled`, `proceedsWithdrawn` and `Swept` are set before each ETH send. Re-entry into the same bid, claim or payout reverts for another reason ("nothing to claim", "already withdrawn"), so the test passes either way.
- **Why it matters:** SPEC §2.17 requires a guard on every ETH-sending function. Nothing detects its removal.
- **Fix in the branch:** `test/ReentrancyGuard.test.js` re-enters `cancelBid` for a *different* bid of the same bidder. That path is blocked only by the guard. With the guards: passes. Guards removed: fails, because the attacker receives 10 ETH instead of 5.
- **Suggestion:** keep the new test, and state in AC47 which protection each test relies on.

### F2: Low, test gap. `sweep` re-entry was not tested, although AC47 says "every ETH-sending path"
- **Fix in the branch:** `test/ReentrancySweep.test.js` re-enters `sweep` from the owner's `receive()`. It passes, and the payout happens once (30 ETH, `Swept`).
- **Limit:** this test also passes with the guard removed, because `sweep` sets `Swept` before sending. It shows there is no double payout. It does not show the guard exists. F1's test is the one that does that.

### F3: Info, test title overclaims
- The `withdrawProceeds` test title says "re-entering withdrawProceeds or claim", but only `withdrawProceeds` is armed (`arm(withdrawProceeds, 2)`). Re-entry into `claim` is never exercised.

### F4: Info, weak assertions
- `ReentrancyAttacker.receive()` ignores the result of the re-entrant call and stores only the last result in `lastReentryOk`. The tests check only that last result, and `reentries` is asserted in one test only. A re-entry that fails for an unrelated reason looks the same as a guard rejection. No test asserts the revert reason.

### F5: Info, deployment risk
- `VulnerableAuction` and `ReentrancyAttacker` compile into `artifacts/`. Nothing references them today: `scripts/deploy.js` and `hardhat.config.js` do not. CLAUDE.md says never deploy them. Keep it that way.

## SPEC.md
- AC46 and AC47 match SPEC §4 and §7. `VulnerableAuction` matches the §4 description: ETH is sent before the claimable balance is cleared, and there is no guard.
- The AC47 title ("every ETH-sending path") is wider than what the tests covered (F2). No contradiction in the contract.

## Checked and found correct
- `VulnerableAuction.claim` (`contracts/test/VulnerableAuction.sol`): the ETH call happens before `claimable` is zeroed, so the attack works as the test expects.
- AC46 arithmetic: 1 ETH deposited by the attacker, plus the initial claim and three re-entries, pays 4 ETH. Bob's 10 ETH drops by 3 ETH. The assertions match.
- `ReentrancyAttacker.execute` bubbles the victim's revert data correctly.
- Reentrancy tests and the new tests pass with the guards in place.
- No script imports the test-only contracts.

## Not verified
- A single attacker that is both owner and bidder at once (for example, owner `withdrawProceeds` plus bidder `claim` in one re-entry chain). Each test gives the attacker one role only.
