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
npm run frontend:test  # run the front-end tests
```

### Run it locally

In one terminal, start a local chain. In a second terminal, deploy the auction and start the web app:

```bash
npm run node
npm run deploy:local
npm --prefix frontend ci   # first time only
npm run frontend
```

Add the local chain to MetaMask (RPC `http://127.0.0.1:8545`, chain ID `31337`), then import one of the Hardhat test accounts that `npm run node` prints.

`deploy:local` takes its settings from the environment. The defaults match the demo: 100 tokens, a 2.9 ETH start price, a 1.0 ETH reserve, and 60-second steps. See `.env.example` for the full list.

### Deploy to Sepolia

Copy `.env.example` to `.env`, then set `SEPOLIA_RPC_URL` and `DEPLOYER_PRIVATE_KEY`. Keep `.env` out of version control.

```bash
npm run deploy:sepolia
```

The deploy script writes the chain ID and deploy block into `frontend/src/deployment.json`. The web app reads the chain ID from that file.

## Tests and CI

| Suite | Count | What it covers |
|---|---|---|
| Contract tests (`npm test`) | 75 | Acceptance criteria AC1–AC47 and AC53–AC54 (bid cap), review regressions, reentrancy, mixed-role attacker, gas bounds at 120 steps, and the front-end quote and preview maths checked against the contract (AC50/AC51) |
| Front-end tests (`npm run frontend:test`) | 28 | Quote and preview maths, AC48 wrong-network wallet (prompt, every action button, send-time chain check), bid-cap message in the bid form, render checks for the placeholder deployment, Finalize, RPC chain banner |

GitHub Actions runs the contract tests, the front-end tests and build, and Slither static analysis on every push and pull request (`.github/workflows/ci.yml`). Slither fails on any finding not reviewed in `slither.db.json`; PLAN.md explains each reviewed finding and how to run it locally.

The reentrancy demonstration is bonus work. `VulnerableAuction` is a simplified refund contract that shows the bug. `ReentrancyAttacker` shows that the real auction rejects re-entry from each ETH-sending function.

## Documentation

- [SPEC.md](SPEC.md): what the system must do, with numbered acceptance criteria.
- [PLAN.md](PLAN.md): how the work is split into milestones and issues, and which test covers each risk.
- [CLAUDE.md](CLAUDE.md): commands, layout and conventions for contributors.

## Status and known gaps

- Milestones M1–M4 and the follow-ups are merged into `main`, with no open issues. The follow-ups were #15 (front-end maths checked against the chain, #33), #21 (gas bounds at 120 steps, #31) and #22 (wrong-network test, #32). #21 led to a SPEC amendment (#30): each address may place at most 100 bids, so `claim` always fits in one transaction.
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
