# Review: PR #25, process and guardrails (PLAN.md, CLAUDE.md, Stop hook)

- **PR:** #25, `m2-process` into `m1-contracts` (stacked on #18). Replaces closed #23 and #24.
- **Scope:** `PLAN.md`, `CLAUDE.md`, `.claude/settings.json`
- **Verdict:** Changes requested for F1 (the hook does not enforce what CLAUDE.md says it does). F2 is a security note on committed hooks. F3 to F5 are doc fixes.

## Verification run
- Test counts in PLAN (43 acceptance, 4 reentrancy) match the branches (reproduced: 43 on M1, 47 on M2).
- Every test title cited in PLAN's risk register exists in the M1 or M2 test files, apart from the dash variants in F3. AC47's sweep path is not covered by its tests; see PR #19.
- The npm scripts in CLAUDE.md (`test`, `frontend:build`, `node`, `deploy:local`) exist in `package.json` on the M3 branch.
- Issue numbers #1 to #17, #21 and #22 exist, and their titles match the milestone scopes.
- PR numbers in PLAN match the open PRs: #18 (base `main`), #19 (on #18), #20 (on #19), and this one.
- Not run: the Stop hook. It runs the full suite after every turn, so I did not trigger it.

## Findings

### F1: Medium. The Stop hook does not enforce "must pass before a PR"
- **Where:** `CLAUDE.md:11` says `npm test` "must pass before a PR". The hook is `.claude/settings.json:8`, `npx hardhat test`.
- **Why:** a Stop hook blocks only on exit code 2. Any other failure is shown as a non-blocking error, so a failing suite does not stop anything.
- **What actually gates:** CI. `.github/workflows/ci.yml` runs compile and tests on every pull request, from #18 onward.
- **Cost:** the hook runs the full suite after every assistant turn.
- **Suggestion:** change `CLAUDE.md:11` to point at the CI check, or make CI a required status check. Decide whether the hook is worth its cost.

### F2: Low, security. A committed hook runs a shell command on any machine that opens this repo
- **Where:** `.claude/settings.json:8`.
- **Risk:** the command runs for anyone who opens the repo in Claude Code and stops a session. A PR that edits this file runs its command on the reviewer's machine. Review changes to `.claude/settings.json` the way you would review code.
- **Also:** if `hardhat` is not installed locally, `npx` can fetch packages from npm when the hook runs.

### F3: Low, doc. PLAN uses hyphens where the test titles use en dashes
- **Where:** `PLAN.md:25` (R2, `AC20-21`) and `PLAN.md:32` (R9, `AC6-8`).
- **Actual titles:** `AC20–21` and `AC6–8` (`test/DutchAuction.test.js`, M1 branch). An exact-text search for a PLAN entry does not find its test.
- **Suggestion:** use en dashes in PLAN.

### F4: Low, doc gap. Acceptance criteria 48 to 52 are not in PLAN or CLAUDE
- **Where:** `CLAUDE.md:17` says tests are named after AC1 to AC47.
- **Fact:** SPEC §7 has AC1 to AC52. AC48 to AC52 are the front-end criteria. No risk row cites them. R11 and R12 are the nearest, and both are gaps.
- **Suggestion:** extend the range in CLAUDE and add front-end rows to the PLAN risk register.

### F5: Low, coverage. AC16 is not listed anywhere in PLAN
- **AC16:** a bid reverts after a lazily detected sell-out.
- **Fact:** no test has this title. The nearest is the AC20-21 test, "later bids revert". PLAN R2 should cite it, or a dedicated test should be added.

### F6: Info. Commit messages on the stacked branches still use the old milestone numbers
- The PLAN now numbers reentrancy as M3 and the deploy app as M4. The commit on `m2-reentrancy` is titled "(M2)", and the one on `m3-frontend` is "(M3)". PR titles match the new PLAN. Cosmetic.

### F7: Info. Stale M4 branches are still on origin
- `m4-process` (closed #23) and `m4-process-main` (closed #24) both still exist. This PR replaces them. Delete them once this PR is merged, so only one M4 history remains.

## SPEC.md
- No direct contradiction. The PLAN's coverage gaps (F4, F5) are the only SPEC-related issues.
- R14 is accurate: SPEC §1 says shill bidding is accepted, and SPEC §8 lists anti-shill measures as out of scope.
- The R1 and R15 tolerance (at most 3 wei and 3 token-wei) matches the assertion in AC28 (`DutchAuction.test.js`, the `lessThanOrEqual(3n)` checks).

## Checked and found correct
- The dependency on #18 is accurate. The Stop hook has a Hardhat project once #18 is merged, which the PR body says.
- `CLAUDE.md` is 30 lines, under its own 40-line limit.
- The commit on this branch has the `Co-Authored-By` and `Claude-Session` trailers that CLAUDE.md requires.
- Every risk marked "Covered" names a test that exists (apart from F3 and F5).
- The gaps (R11, R12, R13) are marked as gaps and link to open issues.
- `CLAUDE.md` gotcha: the tests use `time.setNextBlockTimestamp`, which matches the advice.
- `.gitignore` covers `.env` and the generated build output, so secrets are not committed.

## Not verified
- Whether the hook's `npx` ever fetches from npm on contributors' machines. This depends on local setup and was not tested.
- Issue bodies were checked by title only.
