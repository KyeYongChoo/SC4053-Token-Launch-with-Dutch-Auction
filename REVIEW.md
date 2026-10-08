# Review: PR #24, M4 (PLAN.md, CLAUDE.md, Stop hook)

- **PR:** #24, `m4-process-main` into `main`, head `09c7038`
- **Scope:** `PLAN.md`, `CLAUDE.md`, `.claude/settings.json`
- **Verdict:** Request changes for finding 1. The rest are non-blocking.

## Findings

### 1. Stop hook lands on `main` before the project it tests exists (must fix before merge)
- `.claude/settings.json:8` runs `npx hardhat test` on every Stop event.
- `main` has no `package.json`, `hardhat.config.js` or `test/`, so the command should fail at every turn end for anyone working on `main` until #18 lands. This is not run here; it follows from the file tree.
- The PR body already warns about this, but nothing in the repo enforces it. Anyone who pulls `main` gets the failure.
- **Suggestion:** merge #24 after #18, or guard the command so it exits 0 when there is no `hardhat.config.js`.

### 2. The hook does not enforce "must pass before a PR"
- `CLAUDE.md:11` says `npm test` must pass before a PR. A Stop hook only blocks on exit code 2. A failing `npx hardhat test` (exit 1) is shown as a non-blocking error, so the hook does not gate anything.
- It also runs the full suite after every assistant turn, which adds latency and cost.
- The real gate is CI (`.github/workflows/ci.yml` runs `npx hardhat test` on every PR, from M1 onward).
- **Suggestion:** reword `CLAUDE.md:11` to point at the CI check, or make CI a required status check. Decide whether the Stop hook should stay at all.

### 3. Hook command and documented command differ
- The hook runs `npx hardhat test` (`.claude/settings.json:8`). `CLAUDE.md:11` and `PLAN.md:42` say `npm test`. `package.json` maps `test` to `hardhat test`, so the behaviour is the same, but the docs should name one command.

### 4. Test names in the risk register do not match the test titles exactly
- `PLAN.md:25` (R2) uses `AC20-21` and `PLAN.md:32` (R9) uses `AC6-8`, with hyphens.
- The test titles use en dashes: `AC20–21` and `AC6–8` (`test/DutchAuction.test.js`, M3 branch). An exact-text search for a name from the PLAN will miss.
- **Suggestion:** use en dashes in the PLAN.

### 5. Two divergent M4 branches
- `m4-process` (PR #23, closed, base `m3-frontend`) and `m4-process-main` (PR #24) carry the same commit message with different SHAs (`b67ffdb` and `09c7038`).
- The two `PLAN.md` files differ: #23 says "stacked on #20", #24 says "into main".
- **Suggestion:** delete the stale `m4-process` branch once #23 is confirmed closed for good, so only one M4 version remains.

### 6. Acceptance-criteria coverage is incomplete in the PLAN and CLAUDE
- SPEC §7 has 52 criteria. `PLAN.md` and `CLAUDE.md:14` only mention AC1–AC47. AC48–AC52 (front-end behaviour) are not mentioned, and the risk register does not cite them. R11 and R12 are the nearest entries, and both are gaps.
- AC16 (a bid after a lazily detected sell-out reverts) has no test title. The nearest match is "later bids revert" inside the AC20–21 test (`test/DutchAuction.test.js`, M3 branch). That test does not check the lazy-detection path by name.
- **Suggestion:** state in `PLAN.md` which AC numbers are in scope for each milestone, and either add an explicit AC16 test or cite the AC20–21 test as its coverage.

### 7. Cross-PR nit: `deployment.json` is described as generated but is tracked
- `CLAUDE.md:18` says `frontend/src/deployment.json` is generated and must not be edited by hand.
- The file is committed on the M3 branch and is not in `.gitignore`. Either document that it is committed on purpose, or ignore it. This belongs to the M3 PR, not this one.

## Verified (passed)
- PR numbers in `PLAN.md`: #18 (base `main`), #19 (on #18), #20 (on #19), #24 (into `main`). All match the GitHub API.
- Issue map: #1–#17, #21 and #22 exist and their titles match the PLAN's milestone scopes.
- Test counts: `DutchAuction.test.js` has 43 `it()` blocks and `Reentrancy.test.js` has 4, matching "43" and "4" in `PLAN.md:42`.
- Acceptance numbering: every SPEC §7 criterion from AC1–AC47 has a test title, except AC16 (finding 6). Some titles cover ranges: AC7 and AC8 sit in "AC6–8", and AC13 sits in "AC12–13".
- Risk-register test names exist (apart from the dash issue in finding 4). Each cited AC title was found on the M3 branch: AC2, AC6, AC15, AC18, AC19, AC21, AC28, AC30, AC31, AC32, AC35, AC38, AC40–AC43, AC45, AC46, and AC47 (three sub-titles).
- AC28 dust bound: the test asserts `≤ 3` wei and token-wei, matching R1 and R15.
- R14 (shill bidding) is accurate: `SPEC.md` §8 excludes "anti-shill measures", and the owner row says shill bidding is accepted.
- `CI` workflow exists and runs compile, test and front-end build.
- npm scripts named in `CLAUDE.md` exist: `npm test`, `frontend:build`, `node`, `deploy:local`.
- `scripts/deploy.js` writes `frontend/src/deployment.json`.
- Gotcha in `CLAUDE.md`: `time.setNextBlockTimestamp` is used in the tests. `CLAUDE.md` is 30 lines, under the 40-line limit.
- Commit `09c7038` has the `Co-Authored-By` and `Claude-Session` trailers that `CLAUDE.md:23` requires.

## Not verified
- The test suite was not run on this branch. The branch has no code; the test results come from reading the M3 branch.
- CI run status for #24 was not checked.
- Issue bodies were checked by title only.
- The `Stop` hook was not executed. Finding 1 is inferred from the file tree.
- The gotcha about `npm install` rewriting `package-lock.json` on Windows was not tested.
