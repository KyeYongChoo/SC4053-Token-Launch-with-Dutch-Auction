# Token Launch with Dutch Auction

An ERC-20 token sold through a 20-minute Dutch auction on Ethereum. Bidders commit ETH with a maximum price. The price falls in steps over the window. Every winner pays the same clearing price, and excess ETH is refunded. Unsold tokens are burned.

Built for SC4053. The approved specification is [SPEC.md](SPEC.md).

## How the auction works

- **Price:** starts at `P0` and falls in equal steps to the reserve price `R` at the last step. With 60-second steps there are 20 steps.
- **Bids:** each bid has an ETH amount and a maximum price. If the bid's maximum is at or above the current price, it is live. Otherwise it is a standing order that activates when the price falls to it. Standing orders can be cancelled before they activate.
- **Sell-out:** the auction clears at the first step where committed ETH covers the supply at that step's price. It can end before 20 minutes.
- **Clearing:** everyone pays the clearing price. Bids that were partly filled at the clearing step get the rest back. If the window ends with no sell-out, the auction clears at the reserve and the unsold tokens are burned.
- **Claims:** after the auction ends, each bidder calls `claim()` once to receive tokens and any refund. The owner withdraws proceeds once. Unclaimed tokens and ETH are swept by the owner after a 30-day claim window.

## Repository layout

| Path | What it is |
|---|---|
| `contracts/LaunchToken.sol` | Fixed-supply ERC-20, minted once to the auction |
| `contracts/DutchAuction.sol` | The auction: pricing, bidding, sell-out, clearing, claims, sweep |
| `contracts/test/` | Test-only contracts for the reentrancy demonstration. Never deploy these |
| `test/` | Contract tests, named after acceptance criteria in SPEC.md |
| `scripts/deploy.js` | Deploys the auction and writes `frontend/src/deployment.json` |
| `frontend/` | React and Vite web app: wallet connect, price chart, bid form, claims |
| `SPEC.md` | Approved specification: roles, rules, interfaces, acceptance criteria |
| `PLAN.md` | Milestones, issue and PR map, and the risk register |
| `CLAUDE.md` | Project conventions for contributors and Claude Code |

## Getting started

Requires Node.js 20 or later.

```bash
npm ci                 # install contract dependencies
npm test               # run the contract tests
npm run frontend:test  # run the front-end tests - if it fails, run npm --prefix frontend ci
```

### Run it locally

In one terminal, start a local chain. `npm run node` only starts the chain; it doesn't deploy anything. In a second terminal, deploy the auction and start the web app:

```bash
npm run node
START_AUCTION=false npm run deploy:local   # deploy without starting the auction
npm --prefix frontend ci   # after cloning, or if the front-end install breaks
npm run frontend
```

`START_AUCTION=false` leaves the auction unstarted so you can start it during a demo with **Start auction** in the app's **Owner** panel, connected as the deployer (Hardhat account #0). Leave it out to start the auction at deploy. That line is bash syntax (Git Bash, macOS, Linux). In PowerShell, run `$env:START_AUCTION="false"; npm run deploy:local` instead.

If `npm --prefix frontend ci` fails on Windows with `EPERM ... esbuild.exe`, a running Node process still has the file open. Stop `npm run node` and `npm run frontend`, then run it again.

Add the local chain to MetaMask (RPC `http://127.0.0.1:8545`, chain ID `31337`), then import one of the Hardhat test accounts that `npm run node` prints.

Each time you restart `npm run node`, the chain starts again from block 0 and every account's nonce resets. MetaMask still holds the old chain's activity for the same nonces, so it can show a successful transaction as failed or suggest a stale nonce. After each restart, clear MetaMask's activity and nonce data: in Settings → Advanced, choose **Clear activity tab data**. Some MetaMask versions clear only the selected account, so repeat it for each imported account. Redeploying (`npm run deploy:local`) on a node that is still running needs no reset. On Sepolia the chain is never reset, so this does not apply.

MetaMask can also keep token balances from a previous run in memory. After restarting `npm run node`, close and reopen the browser as well. Otherwise MetaMask may show balances from the old chain even though the transactions on the new chain are correct.

`deploy:local` takes its settings from the environment. The defaults match the demo: 100 tokens, a 2.9 ETH start price, a 1.0 ETH reserve, and 60-second steps. See `.env.example` for the full list.

#### Skip ahead in time

To demo later stages without waiting, move the local chain's clock forward. In a new terminal, open the Hardhat console:

```bash
npx hardhat console --network localhost
```

Then enter, in the console:

```js
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// time.increase(seconds) moves the clock forward and mines a block
await time.increase(5 * 60);            // skip 5 minutes (5 price steps)
await time.increase(20 * 60);           // skip 20 minutes: the auction has ended
await time.increase(30 * 24 * 60 * 60); // skip 30 days: the claim period is over, so the owner can sweep
```

The app picks up the new time on its next refresh.

### Deploy to Sepolia, step by step

Sepolia is a public Ethereum test network. Its ETH is free and worthless. Unlike the local chain it is shared, so everyone in the group can use the same auction from their own computer.

> **Local chain and Sepolia are separate.** `npm run node` only starts a private chain on your computer; it deploys nothing. The 20 accounts it prints, and any contract address from `npm run deploy:local`, exist only on that chain. None of them work on Sepolia. The private keys of those test accounts are published for everyone who uses Hardhat, so never send ETH to them on a public network: bots take it within seconds.

You will fill in two different `.env` files. Both are git-ignored; never commit them.

| File | Read by | What goes in it |
|---|---|---|
| `.env` (project root) | `npm run deploy:sepolia` | `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY` |
| `frontend/.env.local` | the web app (`npm run frontend`) | `VITE_RPC_URL` |

If you only want to bid on an auction a groupmate already deployed, skip to [Join a groupmate's auction](#join-a-groupmates-auction).

#### 1. Make a test-only MetaMask account

Use a new account that holds nothing of value, because step 4 copies its private key into a file. In MetaMask, open the account list and choose **Add account**. Then open the network list, turn on **Show test networks**, and select **Sepolia**.

#### 2. Get Sepolia ETH

Search for "Sepolia faucet" (for example, Google Cloud's Web3 faucet), and paste your account's **address**. Deploying and starting the auction cost about 0.02 Sepolia ETH in our test (it depends on Sepolia's gas price), and the minimum bid is 0.01 ETH. Get at least 0.05 Sepolia ETH before deploying. Faucets often give a small amount per day, so ask early. Everyone who wants to bid needs their own Sepolia ETH.

#### 3. Get an RPC URL for deploying

An RPC URL is the web address your computer uses to talk to Sepolia. Create a free account at [Alchemy](https://www.alchemy.com/) or [Infura](https://www.infura.io/), create an app or API key for **Ethereum Sepolia**, and copy its HTTPS URL. It looks like one of these:

```
https://eth-sepolia.g.alchemy.com/v2/<your key>
https://sepolia.infura.io/v3/<your key>
```

#### 4. Copy the account's private key, not its address

MetaMask shows two long hex strings for every account. The deploy script needs the private key.

| | What it looks like | Length | Share it? |
|---|---|---|---|
| Address | `0x` followed by 40 characters | 42 | Yes |
| Private key | 64 characters, sometimes with `0x` in front | 64 or 66 | **Never** |

To get the private key: in MetaMask, open the **⋮** menu → **Account details** → **Show private key**, and enter your MetaMask password. If the deploy later says the private key is too short, you pasted the address.

#### 5. Fill in the root `.env`

Copy the example file (`cp .env.example .env`, or `copy .env.example .env` in Windows Command Prompt), then fill in the two values. No quotes, and no spaces around `=`:

```
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<your key>
DEPLOYER_PRIVATE_KEY=<your 64-character private key>
```

**Decide when the 20 minutes start.** By default the deploy script also starts the auction, so the 20-minute window begins as soon as the deploy finishes. To start it yourself later from the web app, once the group is ready, also add:

```
START_AUCTION=false
```

#### 6. Deploy

```bash
npm run deploy:sepolia
```

This takes up to a minute, because it waits for Sepolia to include each transaction. You should see:

```
Deploying from 0x... on chain 11155111
DutchAuction: 0x...
LaunchToken:  0x...
Auction started at block timestamp ...      (only if START_AUCTION is not false)
Wrote frontend/src/deployment.json
```

The account in `DEPLOYER_PRIVATE_KEY` is the auction's owner. `frontend/src/deployment.json` now points the web app at your new contract. That file is generated, so don't edit it by hand.

#### 7. Point the web app at Sepolia

Create `frontend/.env.local` containing:

```
VITE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

An Infura URL also works. **Do not use a free-tier Alchemy URL here**, even though it works for deploying. The web app reads past bids with `eth_getLogs`, and Alchemy's free tier allows only a 10-block range, so the page shows "Could not read the chain: missing revert data" or "failed to fetch".

If `npm run frontend` is already running, stop it (Ctrl+C) and start it again. The web app reads `.env` files only when it starts; refreshing the browser is not enough.

#### 8. Use the auction

```bash
npm --prefix frontend ci   # first time only
npm run frontend
```

Open the URL it prints, click **Connect wallet**, and switch MetaMask to Sepolia if the page asks. The owner account shows "(owner)" and gets the owner panel.

1. If you deployed with `START_AUCTION=false`, the owner clicks **Start**.
2. Anyone with Sepolia ETH bids. The price drops every 60 seconds, and the auction ends after 20 minutes or when it sells out.
3. After the end, anyone clicks **Finalize**, each bidder clicks **Claim**, and the owner clicks **Withdraw proceeds**.

Sepolia makes a block about every 12 seconds, so each transaction takes a little while to confirm. Every transaction is visible at `https://sepolia.etherscan.io/address/<auction address>`.

#### Join a groupmate's auction

One person deploys (steps 1 to 6). Everyone else:

1. Gets `frontend/src/deployment.json` from the person who deployed, and replaces their own copy with it. The file holds only contract addresses and the ABI, so it is safe to share.
2. Does steps 1, 2 and 7 (a MetaMask account with Sepolia ETH, and `frontend/.env.local`). You do not need the root `.env`.
3. Runs `npm run frontend` and connects.

Git tracks `deployment.json` with an empty placeholder, so a real deployment shows up as a change. Don't commit it. To stop git listing it as changed, run `git update-index --skip-worktree frontend/src/deployment.json`; undo that with `--no-skip-worktree`.

#### Switch back to the local chain

1. Keep a copy of your Sepolia `deployment.json` somewhere outside the repo if you want to come back to that auction.
2. With `npm run node` running, run `npm run deploy:local`. This overwrites `deployment.json` with the local deployment.
3. Delete `frontend/.env.local`, or comment out its `VITE_RPC_URL` line. Without it the web app uses the local chain.
4. Restart `npm run frontend`, and switch MetaMask to the local network.

#### Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| Deploy fails: private key too short or invalid | `DEPLOYER_PRIVATE_KEY` holds the 42-character address | Step 4 |
| Deploy fails: `insufficient funds` | The deploying account has no Sepolia ETH | Step 2 |
| Deploy fails mentioning the URL or network | `SEPOLIA_RPC_URL` is empty or wrong, or `.env` is not in the project root | Step 5 |
| "No deployment found" | `deployment.json` is still the placeholder | Deploy (step 6) or get the file from a groupmate |
| "Could not read the chain: missing revert data" or "failed to fetch" | The web app's RPC is a free-tier Alchemy URL | Step 7 |
| "RPC network mismatch" or "Read-only RPC is on chain 31337" | The web app is still reading the local chain | Set `VITE_RPC_URL` (step 7) and restart `npm run frontend` |
| "Wrong network" banner | MetaMask is not on Sepolia | Click **Switch network** |
| Bid button disabled, or a bid fails | The auction hasn't started, or its 20 minutes are over | Owner clicks **Start**, or deploy a new auction |

## Tests and CI

| Suite | Count | What it covers |
|---|---|---|
| Contract tests (`npm test`) | 100 | Acceptance criteria AC1–AC47 and AC53–AC54 (bid cap), AC56 on the chain (gas limit across a step boundary), C02/C03 and D01 audit regressions, reentrancy, mixed-role attacker, gas bounds at 120 steps, and the front-end quote and preview maths checked against the contract (AC50/AC51) |
| Front-end tests (`npm run frontend:test`) | 121 | Quote and preview maths, AC48 wrong-network wallet, bid-cap message, U01–U04 status/deadline/network/snapshot regressions, exact bid IDs and stale-refresh protection, and AC55–AC61 (next-block price, gas limit, step-boundary notice, receipt step, zero-proceeds withdraw, readiness after an account change, slow refreshes) |

Counts checked locally on 1 November 2026 by running `npm test` (100 passing) and `npm run frontend:test` (121 passing). CI runs the same suites on every push. The configured Slither gate keeps 35 reviewed findings in the triage database (`slither.db.json`).

GitHub Actions runs the contract tests, the front-end tests and build, and Slither static analysis on every push and pull request (`.github/workflows/ci.yml`). Slither fails on any finding not reviewed in `slither.db.json`; PLAN.md explains each reviewed finding and how to run it locally.

The reentrancy demonstration is bonus work. `VulnerableAuction` is a simplified refund contract that shows the bug. `ReentrancyAttacker` shows that the real auction rejects re-entry from each ETH-sending function.

## Documentation

- [SPEC.md](SPEC.md): what the system must do, with numbered acceptance criteria.
- [PLAN.md](PLAN.md): how the work is split into milestones and issues, and which test covers each risk.
- [CLAUDE.md](CLAUDE.md): commands, layout and conventions for contributors.

## Status and known gaps

- Milestones M1–M4 and the follow-ups are merged into `main`, with no open issues. The follow-ups were #15 (front-end maths checked against the chain, #33), #21 (gas bounds at 120 steps, #31) and #22 (wrong-network test, #32). #21 led to a SPEC amendment (#30): each address may place at most 100 bids, bounding auction claim work; measured 120-step auto-finalizing claims fit the 4.6-million-gas local test budget.
- The audit findings C02/C03 and U01–U04 are fixed and merged. D01 is resolved by correcting SPEC's residual ETH bound and adding eight settlement regressions; contract settlement behavior is unchanged. Tiny bids can still be charged while receiving zero token-wei, as explicitly documented in SPEC.
- Front-end fixes since the audit (AC55–AC61) are merged: gas-limit headroom across a step boundary, step-boundary notices, no withdraw button when there are no proceeds, no button flicker on polls, refreshes slower than the poll interval, and the wallet chain read on an account change.
- The rendering parts of AC49–AC52 (chart, deadline display, owner panel visibility) are checked by hand.
- The contracts have not been audited. Do not deploy them to mainnet.
- Shill bidding by the owner is accepted, as SPEC.md section 8 puts anti-shill measures out of scope.

---

## Original brief

description of the core requirements, smart contract logic:
Implement Ethereum smart contracts and a front-end web app for a token launch (STO/ICO)
where tokens are bid for using Ether and distributed via a Dutch auction over a 20-minute
window.
• ERC20Integration: Define project tokens using the ERC20 standard.
• Auction Engine: Implement Dutch auction mechanics in separate smart contract(s).
• Time-Bound Elapse: The auction runs for exactly 20 minutes. Tokens sell out at/above
reserve price, or unsold tokens are burned.
• Token Claims & Refunds: Distribute minted tokens and automatically process ETH
refunds for surplus bid amounts.
• (Bonus) Demonstrate reentrancy attack resistance (Guide / Practice Repo).

Requirements relating to Dutch Auction
• Descending Price Mechanism: Bidding opens at an intentionally high starting price and
descends automatically over time based on a predefined decay function.
• UniformClearing Price: Participants commit ETH capital. When total committed capital
meets total token supply, the auction clears.
• Fair Participant Equity: Every winning bidder pays the exact same final clearing price,
regardless of how high their initial bid was. Excess ETH is refunded.

UI features:
Have a bid button and a box to enter your bid.
have a line chart display of what the price is

Spec md should contain e structural design, contract interfaces,
and state management
