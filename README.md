# SC4053 – Token Launch with Dutch Auction

An ERC20 token launch where the whole sale supply is distributed through a 20-minute Dutch auction with a uniform clearing price.

## Layout

| Path | What it is |
| --- | --- |
| `contracts/LaunchToken.sol` | Fixed-supply, burnable ERC20 |
| `contracts/DutchAuction.sol` | The auction engine |
| `contracts/test/` | Test-only contracts for the reentrancy demonstration |
| `test/` | Hardhat test suite |
| `scripts/deploy.js` | Deploys both contracts and writes the addresses/ABIs for the front end |
| `frontend/` | Vite + React + ethers v6 web app |

## How the auction works

- The price falls linearly from `startPrice` to `reservePrice` over exactly 20 minutes. It is recomputed from `block.timestamp` on every call, so there is no keeper or per-block update.
- Bidders commit ETH with `bid()`. At price `p`, the committed ETH demands `totalCommitted / p` tokens. The auction clears when that demand covers the supply, i.e. `totalCommitted >= p × tokensForSale`.
- Clearing can happen in two ways:
  - **Inside a bid.** A bid that bridges the threshold is accepted only up to the remaining capacity. The surplus is credited to `refunds` and the auction settles at the current price.
  - **By decay between bids.** The price falls until existing commitments cover the supply. The clearing price is then `totalCommitted / tokensForSale` (rounded up), and later bids revert.
- If the 20 minutes pass without selling out, the auction settles at the reserve price and the unsold tokens are burned, reducing `totalSupply`.
- Everyone pays the same clearing price: `tokens = commitment / clearingPrice`. `claim()` sends the tokens and any refund in one call.
- The owner collects the committed ETH with `withdrawProceeds()` after settlement.

Settlement is lazy: `claim()`, `withdrawProceeds()` and the public `finalize()` all settle the auction if it is over and has not been settled yet.

### Reentrancy

`claim()` and `withdrawProceeds()` zero their state before any external call, and every state-changing function is `nonReentrant`. `test/Reentrancy.test.js` runs the same attacker contract against a deliberately vulnerable sale (it is drained) and against `DutchAuction` (it receives exactly the refund it is owed).

### Rounding

Token amounts round down and the sold-out clearing price rounds up, so allocations can never exceed the supply. This can leave a few base units (wei-scale) of the token in the auction contract.

## Running locally

Requires Node.js 18+ and MetaMask.

```bash
npm install
npm --prefix frontend install

npm test                 # run the contract tests

npm run node             # terminal 1: local chain on http://127.0.0.1:8545
npm run deploy:local     # terminal 2: deploy + write frontend/src/contracts/deployment.json
npm run frontend         # terminal 2: start the web app
```

In MetaMask, add the network `http://127.0.0.1:8545` (chain ID 31337) and import one of the private keys printed by `npm run node`. Account #0 is the deployer and auction owner: connect with it and press **Start auction**. Use other accounts to bid.

Re-run `npm run deploy:local` whenever the local node is restarted. If MetaMask then reports a nonce error, clear the account's activity data in MetaMask's advanced settings.

Auction parameters (supply, start price, reserve price) are constants at the top of `scripts/deploy.js`.

## Deploying to Sepolia

Copy `.env.example` to `.env`, fill in `SEPOLIA_RPC_URL` and `PRIVATE_KEY`, then run `npm run deploy:sepolia`.
