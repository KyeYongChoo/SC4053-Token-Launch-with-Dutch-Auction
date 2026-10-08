# CLAUDE.md

Ethereum token launch: an ERC-20 sold by a 20-minute stepped Dutch auction with uniform clearing. Solidity 0.8.24, Hardhat, OpenZeppelin 5.0.2, React and Vite front end.

## Source of truth
- SPEC.md is the approved spec. Change behaviour only after the spec changes.
- PLAN.md lists milestones and the risk register. Each risk names its covering test.

## Commands
- `npm ci`: install (use this, not `npm install`, to match CI).
- `npm test`: contract tests (must pass before a PR).
- `npm run frontend:build`: front-end build.
- `npm run node`, then `npm run deploy:local`: local demo.

## Layout
- `contracts/`: `LaunchToken.sol`, `DutchAuction.sol`. `contracts/test/` is test-only; never deploy it.
- `test/`: tests named after acceptance criteria (AC1-AC47).
- `scripts/deploy.js`: writes `frontend/src/deployment.json`, which is generated. Do not edit it by hand.
- `frontend/`: React and Vite app.

## Conventions
- Never push to `main`. Work on a milestone branch and open a PR against its base.
- Commit messages end with the `Co-Authored-By` and `Claude-Session` trailers.
- Every behaviour change needs a test. Name new tests after their acceptance criterion.
- Prices are wei per whole token. Token amounts are token-wei (18 decimals).

## Gotchas
- Views read the latest block. For exact step boundaries, use `time.setNextBlockTimestamp`, not `time.increaseTo`.
- ethers v6 reserves `.target` for the contract address. Don't name contract getters `target`.
- `npm install` on Windows rewrites `package-lock.json`. Check the diff before committing.
