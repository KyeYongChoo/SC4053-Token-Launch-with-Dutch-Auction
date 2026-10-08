# Review: PR #20, deploy script and web app

- **PR:** #20, `m3-frontend` into `m2-reentrancy` (stacked on #19)
- **Scope:** `scripts/deploy.js`, `frontend/` (React and Vite), `frontend/src/deployment.json`, the CI `frontend` job
- **Verdict:** Changes requested for F1 (the committed placeholder crashes the app) and F2 (SPEC §6 Finalize visibility). The rest is low or informational.

## Verification run
- `npm run build` in `frontend/`: passes (reproduced, 27 s).
- Not run: `scripts/deploy.js` against `hardhat node`. The PR body says it was run, and I did not repeat it.
- Not reproducible from the branch: the `quoteBid` vs `previewClaim` check. The PR body says it was a one-off script that is not in the repo (see F10).
- No contract tests were added. The frontend cannot be tested under `contracts/test/` (Solidity only), so there is no test for F1 to F7 in this review commit.

## Findings

### F1: Medium, bug. The committed placeholder `deployment.json` crashes the page instead of showing "No deployment found"
- **Where:** `frontend/src/App.jsx:34` calls `readContract()` inside `useMemo`. The guard `if (!DEPLOYMENT.address)` is at `App.jsx:117`, after it. `readContract()` (`auction.js:14-16`) passes `DEPLOYMENT.address` to `new Contract(...)`.
- **Reproduced:** the committed file has `address: null`. With ethers 6.13.4, the version this frontend pins, `new Contract(null, [], provider)` throws `invalid value for Contract target`.
- **Render path:** inferred from source order, not run in a browser. The throw happens during render, before the guard can return the message.
- **Impact:** on a fresh clone, or before `npm run deploy:local`, the app fails to render. The helpful message is unreachable.
- **Suggestion:** create the contract only after the guard, or make `readContract()` return null when there is no address.

### F2: Medium, SPEC mismatch. The Finalize button is hidden from visitors without a wallet
- **SPEC §6:** "A Finalize button is visible to everyone once the auction has ended."
- **Where:** the button is rendered inside `MyBids` (`App.jsx:366`). `MyBids` returns early when there is no account (`App.jsx:354`). Anyone who has not connected a wallet sees no Finalize button.
- **Suggestion:** render Finalize outside `MyBids`, in the status panel or the header, with no account requirement.

### F3: Low, SPEC mismatch. The network config is not taken from the environment
- **SPEC §6:** "network config from env".
- **Where:** the chain ID comes from `deployment.json` (`auction.js:7`, `App.jsx:89`, `App.jsx:96`). The environment only sets the RPC URL (`auction.js:8`).
- **Suggestion:** either change the SPEC wording, or read the chain ID from an env variable too.

### F4: Low, security. Wrong-network protection is UI-only and relies on a chain ID captured at connect
- **Where:** `chainId` is set once, in `connect()` (`App.jsx:77-83`). `wrongNetwork` is computed from it (`App.jsx:96`). `run()` signs with whatever chain the wallet is on when the transaction is sent (`App.jsx:99`, `:105`).
- **Mitigation:** the page reloads on `chainChanged` (`App.jsx:63-75`), which covers normal network switches.
- **Residual risk:** a wallet that changes chain without emitting `chainChanged` leaves `wrongNetwork` stale. This is the R12 gap. The contract cannot tell which chain the user meant.
- **Suggestion:** check `getNetwork()` immediately before sending, in `run()`.

### F5: Low, trust. Read data and previews come from the RPC, and nothing checks the RPC's chain
- **Where:** `auction.js:8` (`VITE_RPC_URL`) and `readProvider` at `auction.js:12`. Nothing compares the RPC's chain ID with `DEPLOYMENT.chainId`.
- **Impact:** a wrong or hostile RPC changes the displayed prices, quotes and status, but the wallet still signs the bid. The contract enforces the rules, so the risk is misled bidders, not theft. This is the R11 gap.

### F6: Low, bug. `connect()` has no error handling
- **Where:** `App.jsx:77-83`. Rejecting the MetaMask prompt throws inside `connect`, which is not caught. It appears as an unhandled promise rejection with no message to the user.

### F7: Low, SPEC mismatch. Step numbers are shown 1-based, but SPEC and the contract are 0-based
- **AC50:** "the form labels the bid 'standing order at step j, price X'". Step 0 is P0 (SPEC §2.2, AC6).
- **Where:** `App.jsx:341` shows `activates at step {preview.step + 1}`, and `App.jsx:399` shows `Standing from step ${b.effectiveStep + 1}`.
- **Impact:** a user comparing the label with `currentStep()` or the chart sees a number one higher.

### F8: Info. `deployment.json` is tracked and is overwritten by every deploy
- The committed placeholder has `chainId: 31337`, `deployBlock: 0` and an empty ABI. `deploy.js` rewrites it on each deploy. CLAUDE.md calls it generated, and it is committed. Either gitignore it or commit a deliberate copy.

### F9: Info. The event feed scans from block 0 when the deploy block is missing
- `auction.js:74` falls back to `0`. The placeholder has `deployBlock: 0`, so `queryFilter` scans from genesis. On Sepolia this is slow and may hit RPC limits.

### F10: Info. Unverified claim in the PR body
- The PR says the `quoteBid` vs `previewClaim` check passed with both test wallets. The script is not in the repo, so it cannot be re-run from this branch. This is the R11 gap.

## SPEC.md
- F2, F3 and F7 are contradictions with SPEC §6 and AC50.
- AC48 (wrong chain disables actions), AC49 (chart shows all N steps), AC51 (clearing marker, claimable amounts, deadline) and AC52 (owner panel hidden) are implemented, as described below.

## Checked and found correct
- **`quoteBid`** (`auction.js:131-149`) matches the contract's `_quote` (`DutchAuction.sol:440-454`). Charges round up, tokens round down, the early, join and late branches match, and cancelled or claimed bids return zero. Checked by reading.
- **`previewBid`** (`auction.js:152-158`) snaps the same way as `bid()` (`DutchAuction.sol:170-173`) and chooses live or standing the same way.
- **Demand overlay** (`App.jsx:251`) is `D(k)·1e18/S`, as SPEC §6 describes.
- **Owner panel** (`App.jsx:175`) is hidden for non-owners. This is UI only. The contract enforces `onlyOwner`, which covers AC52.
- **Bid button** (`App.jsx:172`) is disabled when the auction is ended or the state is not Active, and `canAct` disables actions on the wrong network (AC48).
- **Injection**: no `innerHTML`, `eval` or `dangerouslySetInnerHTML` anywhere in the frontend. React escapes all rendered text.
- **Listeners** are removed on unmount (`App.jsx:71-73`).
- **Concurrency**: `busy` blocks overlapping transactions (`run`, `App.jsx:101`).
- **Secrets**: `.env` is ignored by `.gitignore`, `frontend/.env.example` holds only a local RPC URL, and `hardhat.config.js` reads keys from the environment only.
- **Build**: `npm run build` passes (reproduced).

## Not verified
- Browser rendering, including the F1 crash.
- The deploy script run against `hardhat node`.
- Wallet behaviour beyond the events the code listens for.
