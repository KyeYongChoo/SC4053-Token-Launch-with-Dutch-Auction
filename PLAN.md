# PLAN

The approved specification is [SPEC.md](SPEC.md). This file splits it into milestones, maps each milestone to GitHub issues and pull requests, and lists the risks with the test that covers each one.

## Milestones

| Milestone | Scope | Issues | Pull request |
|---|---|---|---|
| M1: Contracts and tests | Token, auction engine, settlement, AC1-AC45, CI for compile and test | #1-#9 | #18 (base `main`) |
| M2: Reentrancy demonstration | Test-only vulnerable contract, guard tests, AC46-AC47 | #10 | #19 (stacked on #18) |
| M3: Deploy script and web app | `scripts/deploy.js`, bid UI, price chart, owner panel, front-end CI job | #11-#14 (follow-up #15) | #20 (stacked on #19) |
| M4: Process and guardrails | This file, `CLAUDE.md`, Stop hook | #16-#17 | this PR (stacked on #20) |

Stacked pull requests: each one targets the branch of the milestone before it. Retarget to `main` in merge order (#18, then #19, #20, then this one). Issues close when a pull request lands on `main`.

Follow-up issues not yet in a milestone PR: #15 (automated tests for front-end maths), #21 (gas bound test), #22 (wrong-network test).

## Risk register

Each risk names the test that covers it. A risk with no test is marked **gap** and points at the issue that will close it.

| ID | Risk | Impact | Covering test(s) | Status |
|---|---|---|---|---|
| R1 | Rounding lets the auction pay out more than it holds | Insolvency | `AC28: rounding never overpays...`, `AC45 (solvency)...` | Covered |
| R2 | Sell-out is missed or counted twice at a step boundary | Wrong clearing price | `AC18: demand exactly equal...`, `AC19: one wei short...`, `AC20-21: demand active before a step boundary...`, `AC21: a standing order that joins at the boundary step...`, `a cancelled standing order does not count toward sell-out` | Covered |
| R3 | A bidder cancels a standing order after its price is reached | Bidder withdraws demand after the price was agreed | `AC30: a standing order cannot be cancelled at or after its step`, `AC31: a live bid cannot be cancelled` | Covered |
| R4 | Someone other than the owner or bidder moves funds | Theft | `AC32: only the bidder can cancel their bid`, `AC42: only the owner withdraws proceeds, once`, `AC43: sweep is blocked up to the deadline...` (non-owner sweep reverts) | Covered |
| R5 | Re-entry drains ETH on a refund or payout path | Drain | `AC46: VulnerableAuction (test-only) is drained...`, `AC47: claim refund...`, `AC47: cancelBid refund...`, `AC47: withdrawProceeds...` | Covered |
| R6 | Claims or sweep happen outside the claim window | Locked or seized funds | `AC40: claim succeeds exactly at finalizedAt + 30 days`, `AC40: claim reverts one second after the deadline`, `AC43: sweep is blocked up to the deadline...` | Covered |
| R7 | A claim or proceeds withdrawal is paid twice | Overpayment | `AC38: claim pays once; second claim reverts`, `AC42: only the owner withdraws proceeds, once` | Covered |
| R8 | Invalid constructor parameters produce an unusable auction | Divide-by-zero or a dead auction | `AC2: rejects invalid parameters` | Covered |
| R9 | Off-by-one at the window end or a step boundary | Wrong price for a bid | `AC6-8: placed step changes exactly at each step boundary...`, `AC15: bids accepted at END-1, rejected at END` | Covered |
| R10 | Auction finalizes before the window ends and nobody sold out | Early clearing | `AC35: finalize before the end reverts`, `AC41: claim reverts while the auction is still active` | Covered |
| R11 | Front end shows a quote that differs from the chain | Bidders misled | Manual check only: `quoteBid` vs `previewClaim` on a local chain (M3 PR). Automated test tracked in #15 | **Gap** (#15) |
| R12 | Wallet signs on the wrong network | Funds sent to the wrong chain | UI prompt only. Automated test tracked in #22 | **Gap** (#22) |
| R13 | Loops over steps and bids make finalize or claim too expensive | Settlement blocked at worst case | None yet. Gas bound test tracked in #21 | **Gap** (#21) |
| R14 | Owner shill-bids to distort the price | Unfair price discovery | None. Accepted risk: out of scope in SPEC.md section 8 | Accepted |
| R15 | Token dust remains in the auction after claims | Minor leftover balance | `AC28: rounding never overpays...` (token dust at most 3 token-wei), `AC45 (solvency)...` | Covered |

## Verification

- `npm ci`, `npm test`: contract acceptance tests (43) and reentrancy tests (4).
- `npm run frontend:build`: front-end build.
- CI runs both on every push and pull request (`.github/workflows/ci.yml`).
