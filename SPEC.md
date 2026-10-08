# SPEC: Token Launch via Stepped Dutch Auction

## Context
The brief in `README.md` asks for an ERC-20 token launch sold by a 20-minute Dutch auction with uniform clearing, refunds, burning of unsold tokens, a bid UI with a price chart, and an optional reentrancy demo. The previous implementation was discarded. This spec is the agreed result of the requirements interview.

Notation: `S` = token supply (token-wei, 18 decimals), `P0` = start price, `R` = reserve price (prices are wei per 1 whole token = 1e18 token-wei), `Δ` = step duration in seconds, `N = 1200 / Δ` = number of steps, `T0` = start timestamp, `END = T0 + 1200`.

---

## 1. Roles
| Role | Who | Powers |
|---|---|---|
| Owner | Deployer of the auction contract | `startAuction()` once; `withdrawProceeds()` once after finalization; `sweep()` after the claim deadline. No pause, cancel or parameter changes after deploy. May bid like anyone else (shill bidding is accepted as an off-chain trust issue). |
| Bidder | Any address, the owner included | `bid`, `cancelBid` (own standing orders only), `claim` |
| Anyone | Any address | `finalize()` once the auction has ended; all view functions |
| Token contract | ERC-20 deployed by the auction constructor | Mints `S` to the auction contract at deploy. Supports burn by holder. No further minting ever. |

## 2. Business rules
**Fixed choices:** Solidity smart contracts on the EVM; ERC-20 token; MetaMask wallet; local dev chain plus Sepolia. Frameworks and libraries are left to implementation (stack-agnostic).

1. **Parameters**: constructor args `tokenName, tokenSymbol, S, P0, R, Δ, minBid`, all immutable. Total duration is fixed at 1200 s and the claim period is fixed at 30 days. The constructor reverts unless `P0 > R > 0`, `S > 0`, `minBid > 0`, `1200 % Δ == 0`, and `2 ≤ N ≤ 120`.
2. **Price schedule (linear steps)**: `step(t) = floor((t − T0) / Δ)` for `T0 ≤ t < END`. `price(k) = P0 − floor(k·(P0 − R)/(N − 1))`, so `price(0) = P0` and `price(N−1) = R`, which is live for the final Δ seconds.
3. **Bid** = `(ethAmount = msg.value, maxPrice)`. Validation: auction Active and not ended; `msg.value ≥ minBid`; `maxPrice ≥ R`.
4. **Snapping**: `maxStep m` = the smallest k with `price(k) ≤ maxPrice` (the price rounds down to a step price). If `maxPrice ≥ P0` then `m = 0`.
5. **Effective step** `e = max(placedStep, m)`. If `e == placedStep` the bid is **live** and counts immediately. If `e > placedStep` it is a **standing order** and counts from the start of step `e`.
6. **Demand** `D(k)` = sum of `ethAmount` over non-cancelled bids with `e ≤ k`.
7. **Sell-out**: the auction sells out at the first step `c` where `D(c)·1e18 ≥ price(c)·S`, checked in step order. That can happen in two ways: (a) when a step begins, from bids that were already active plus standing orders joining at c; or (b) when a live bid is placed during step c. Sell-out is detected lazily. Every state-changing call first evaluates every step up to the current one.
8. **Auction end**: the auction ends at the earlier of sell-out or `END`. 20 minutes is the maximum. After the end, `bid` and `cancelBid` revert.
9. **Clearing price** = `price(c)`, where `c` is the sell-out step, or `c = N−1` if the auction never sold out. Every winner pays the same price, which is always a price on the curve.
10. **Allocation (tiers)**. Let `A = D(c−1)` (ETH from bids active before c, with `D(−1)=0`), `J = D(c) − A` (ETH from bids joining at c), and `Need = price(c)·S/1e18`.
    - Not sold out (undersold at reserve): every bid is filled in full. Fill fraction = 1.
    - Sold out with `A ≥ Need`: bids with `e < c` are filled pro-rata with `f = Need / A`. Bids with `e == c` get f = 0 and a full refund.
    - Sold out with `A < Need`: bids with `e < c` get f = 1. Bids with `e == c` get pro-rata `f = (Need − A) / J`.
11. **Per-bid settlement**: `tokens = floor(eth·f·1e18 / price(c))`. The ETH charged is `ceil(eth·f)`, so the bidder overpays by at most 1 wei. `refund = eth − charged`. Cancelled bids are excluded because they were already refunded.
12. **Cancel**: only the bidder who placed it, only while the auction has not ended, and only while `currentStep < e`. Live bids can never be cancelled. Cancelling refunds the full ETH immediately.
13. **Multiple bids**: an address may hold any number of bids, each with a unique incremental `bidId`.
14. **Finalize**: callable by anyone once the auction has ended, and only once. It is also run automatically by `claim` and `withdrawProceeds` if nobody has called it yet. It records `c`, `price(c)`, the tier fractions, `tokensSold = min(S, floor(D_filled·1e18/price(c)))`, `proceeds`, and `finalizedAt`. It burns `S − tokensSold`.
15. **Claim window**: `deadline = finalizedAt + 30 days`. `claim` is allowed while `now ≤ deadline`. `sweep` is allowed when `now > deadline`.
16. **Rounding dust**: token amounts round down and ETH charges round up. The contract can therefore always pay every claim and the owner's proceeds. Leftover token dust is burned at `sweep`, and leftover wei goes to the owner at `sweep`.
17. **Reentrancy**: every function that sends ETH follows checks-effects-interactions and has a reentrancy guard. All payouts are pull-based.

## 3. Money flows
| Flow | Trigger | From → To | Amount |
|---|---|---|---|
| Bid escrow | `bid` | bidder → auction | `msg.value` |
| Cancel refund | `cancelBid` | auction → bidder | full bid ETH |
| Tokens out | `claim` | auction → bidder | Σ tokens of caller's bids |
| Surplus refund | `claim` | auction → bidder | Σ (eth − charged) of caller's bids |
| Unsold burn | `finalize` | auction → burned | `S − tokensSold` |
| Proceeds | `withdrawProceeds` (owner, once) | auction → owner | `proceeds = floor(price(c)·tokensSold/1e18)` |
| Sweep | `sweep` (owner, after deadline, once) | auction → burned / owner | all remaining tokens burned, all remaining ETH to the owner |

ETH is never sent in a loop over bidders. Nobody can withdraw another party's ETH.

## 4. Public interface
**`LaunchToken` (ERC-20, 18 decimals)**: `constructor(name, symbol, supply, recipient)` mints `supply` to `recipient` (the auction). `burn(uint256 amount)` burns the caller's balance. There are no other mint paths.

**`DutchAuction`**
| Function | Caller | Notes |
|---|---|---|
| `constructor(string name, string symbol, uint256 supply, uint256 startPrice, uint256 reservePrice, uint256 stepDuration, uint256 minBid)` | deployer → owner | Deploys `LaunchToken` and validates the parameters (rule 1). |
| `startAuction()` | owner | Only in Created. Sets `T0 = block.timestamp`. |
| `bid(uint256 maxPrice) payable returns (uint256 bidId)` | anyone | Rules 3–7. If the bid causes a sell-out, the auction ends in the same tx. |
| `cancelBid(uint256 bidId)` | bid owner | Rule 12. |
| `finalize()` | anyone | Rule 14. |
| `claim()` | anyone with unclaimed bids | Settles all of the caller's uncancelled, unclaimed bids. Reverts if there is nothing to claim or if past the deadline. |
| `withdrawProceeds()` | owner | Once, after finalize (auto-finalizes). |
| `sweep()` | owner | Once, when `now > deadline`. |
| Views | anyone | `state()`, `token()`, `startTime()`, `endTime()`, `stepCount()`, `currentStep()`, `currentPrice()`, `priceAt(k)`, `stepJoinAmount(k)` (ETH joining at step k), `demandAt(k)`, `isEnded()`, `getBid(id)`, `bidsOf(addr)`, `previewClaim(addr) → (tokens, refund)` (exact after finalize, estimated before), `clearingStep()`, `clearingPrice()`, `tokensSold()`, `proceeds()`, `claimDeadline()`. |

**Events**: `AuctionStarted(startTime, endTime)`; `BidPlaced(bidId, bidder, ethAmount, maxPrice, placedStep, effectiveStep)`; `BidCancelled(bidId, bidder, refund)`; `SoldOut(step, price)`; `Finalized(clearingStep, clearingPrice, tokensSold, tokensBurned, soldOut)`; `Claimed(bidder, tokens, refund)`; `ProceedsWithdrawn(owner, amount)`; `Swept(tokensBurned, ethToOwner)`.

**Test-only (bonus)**: `VulnerableAuction` has the same claim logic but sends ETH before marking the claim done and has no guard. `ReentrancyAttacker` re-enters `claim` from `receive()`.

## 5. State machine
```
Created ──startAuction()──▶ Active ──(sell-out at step c  |  now ≥ END)──▶ Ended*
Ended ──finalize() / auto──▶ Finalized ──now > finalizedAt+30d, sweep()──▶ Swept
```
*Ended is derived lazily from time and demand. It is not stored until a state-changing call or finalize happens. Allowed calls per state:
- **Created**: `startAuction`, views.
- **Active**: `bid`, `cancelBid`, views.
- **Ended**: `finalize`, plus `claim` / `withdrawProceeds` (both auto-finalize).
- **Finalized**: `claim` (until deadline), `withdrawProceeds` (once), `sweep` (after deadline).
- **Swept**: views only.

## 6. Front end
- MetaMask connect. Works against the local chain and Sepolia, with network config from env. Shows a warning on the wrong chain.
- **Bid form**: an ETH amount box, a max-price box (with a "buy at any price" shortcut that sets it to P0), and a Bid button. Shows a live preview of the snapped step price and whether the bid is live or standing.
- **Price line chart**: the full stepped schedule P0 → R with a "now" marker; a demand overlay line (`D(k)·1e18/S`, the price at which current demand buys all supply); the standing-order ladder (ETH waiting at each future step); and the clearing point highlighted after finalize.
- **Status panel**: state, current price, countdown to the next step and to the end, ETH committed, % of supply covered at the current price.
- **My bids**: each bid with its status (live / standing / cancelled / claimed), a Cancel button where allowed, an estimated tokens and refund, and a Claim button after the end. Shows the claim deadline.
- **Owner panel** (owner only): Start, Withdraw proceeds, Sweep (enabled after the deadline). A Finalize button is visible to everyone once the auction has ended.
- **Public bid feed**: live list from events (bidder, ETH, max price, placed/effective step, cancelled).

## 7. Acceptance criteria
Example params where useful: `S = 1000e18`, `P0 = 1 ETH`, `R = 0.1 ETH`, `Δ = 30` (`N = 40`), `minBid = 0.01 ETH`.

**Deployment and start**
1. Given valid params, when deployed, then the token supply = S, held entirely by the auction, the owner = deployer, and state = Created.
2. Given `P0 ≤ R`, or `R = 0`, or `S = 0`, or `minBid = 0`, or `1200 % Δ ≠ 0`, or `N < 2`, or `N > 120`, when deployed, then it reverts.
3. Given Created, when a non-owner calls `startAuction`, then it reverts. When the owner calls it, then `T0 = block.timestamp`, `END = T0+1200`, state = Active, and `AuctionStarted` is emitted.
4. Given Active, when `startAuction` is called again, then it reverts.
5. Given Created, when `bid` is called, then it reverts.

**Price schedule**
6. Given Active, when `now = T0`, then `currentStep = 0` and `currentPrice = P0`.
7. Given Active, when `now = T0 + kΔ − 1`, then the step is k−1. When `now = T0 + kΔ`, then the step is k.
8. Given Active, when `now = END − 1`, then the step is N−1 and the price is exactly R.
9. For every k in [0, N−1], `priceAt(k) = P0 − floor(k(P0−R)/(N−1))`, the prices are strictly decreasing, and `priceAt(N−1) = R`.

**Bidding**
10. Given Active, when `msg.value = minBid`, then the bid is accepted. When `msg.value = minBid − 1`, then it reverts.
11. Given Active, when `maxPrice = R`, then it is accepted with `m = N−1`. When `maxPrice = R − 1`, then it reverts.
12. Given Active at step k, when `maxPrice ≥ currentPrice`, then `e = k` (live), it is counted in `D(k)` immediately, and it cannot be cancelled.
13. Given Active at step k, when `maxPrice = price(j)` for j > k, then `e = j` (standing). When `maxPrice = price(j) + 1` (and `< price(j−1)`), then `e = j` as well (snapped down).
14. Given `maxPrice > P0`, then `m = 0`.
15. Given `now = END − 1` and not sold out, when a valid bid is placed, then it is accepted. Given `now = END`, when a bid is placed, then it reverts.
16. Given the auction already sold out at an earlier step (detected lazily), when `bid` is called, then it reverts.
17. Each bid gets a unique incremental bidId. One address can hold several bids, and `bidsOf` returns all of them.

**Sell-out**
18. Given step c, when a live bid makes `D(c)·1e18 = price(c)·S` exactly, then the auction sells out at c (≥ is inclusive), `SoldOut(c, price(c))` is emitted, and later bids revert.
19. Given step c, when `D(c)·1e18 = price(c)·S − 1`, then it has not sold out.
20. Given bids totalling 115 ETH active at step 9 (price 1.2, S=100 tokens), and step 10 price 1.1, when step 10 begins, then the auction sells out at step 10 with no transaction. A bid attempted during step 10 reverts.
21. Given standing orders joining at step j whose ETH pushes `D(j)` to at least `price(j)·S`, when step j begins, then the auction sells out at j.
22. Given no sell-out by END, then the clearing step is N−1, the clearing price is R, and the auction is undersold.

**Allocation**
23. (Tipping bid) Given `A = 90 ETH` active before step c, `price(c)=1.2`, `S=100` tokens, when Alice places 40 ETH live at step c, then the clearing price is 1.2, the earlier bids are filled in full (75 tokens), Alice gets 25 tokens and a 10 ETH refund, and proceeds = 120 ETH.
24. (Pro-rata joiners) Given two bids join at step c with 20 and 20 ETH, `A = 90`, and `Need = 100`, then each is filled at f = 10/40 = 0.25 and gets a 15 ETH refund.
25. (Boundary oversubscription) Given the setup in #20 plus Eve's standing order joining at step 10, then earlier bids are filled at f = 110/115, Eve is filled at f = 0 with a full refund, the clearing price is 1.1, and total tokens ≤ 100.
26. (Undersold) Given 30 ETH of bids total, R = 0.5 ETH, S = 100 tokens, and no sell-out, then each bid gets eth/0.5 tokens, 60 are sold, 40 are burned at finalize, and there are no refunds besides rounding.
27. (No bids) Given zero bids, when finalized, then tokensSold = 0, S is burned, and proceeds = 0.
28. For every bidder, `tokens ≤ exact share`, `charged − exact cost ≤ 1 wei`, and Σtokens ≤ tokensSold ≤ S.

**Cancel**
29. Given a standing order with e = j, when the bidder cancels at step j−1, then they get a full ETH refund, `BidCancelled` is emitted, and the bid no longer counts toward D.
30. Given a standing order with e = j, when cancelled at step ≥ j, then it reverts.
31. Given a live bid, when cancelled, then it reverts.
32. Given a bid owned by Alice, when Bob cancels it, then it reverts.
33. Given the auction has ended (sold out or END), when cancel is called, then it reverts.
34. Given a cancelled bid, when cancelled again, then it reverts.

**Finalize and claim**
35. Given Active and not ended, when `finalize` is called, then it reverts.
36. Given ended, when anyone calls `finalize`, then the clearing data is recorded, `S − tokensSold` is burned, `finalizedAt = now`, and `Finalized` is emitted. A second call reverts.
37. Given ended but not finalized, when a bidder calls `claim`, then finalize runs first and the claim succeeds.
38. Given Finalized, when a bidder claims, then they receive Σtokens and Σrefund for all their uncancelled bids and `Claimed` is emitted. A second claim reverts.
39. Given an address with no bids, or only cancelled bids, when it claims, then it reverts.
40. Given `now = finalizedAt + 30 days`, when claiming, then it succeeds. Given `now = finalizedAt + 30 days + 1`, it reverts.
41. Given Created or Active (not ended), when `claim` is called, then it reverts.

**Owner payouts**
42. Given ended, when the owner calls `withdrawProceeds`, then it auto-finalizes and sends exactly `proceeds`. A second call reverts. A non-owner reverts.
43. Given Finalized, when the owner calls `sweep` at `now = finalizedAt + 30 days`, then it reverts. At `+1 s`, all remaining tokens are burned, the whole ETH balance goes to the owner, and state = Swept. A second sweep reverts. A non-owner reverts.
44. Given an owner who never withdrew proceeds, when sweeping, then the proceeds are included in the ETH sent.
45. After all claims and the withdrawal, the contract ETH balance is ≥ 0 and every claim succeeds (solvency), with any remainder ≤ 1 wei per bid.

**Reentrancy (bonus)**
46. Given `VulnerableAuction` and `ReentrancyAttacker` holding a bid, when the attacker claims, then it drains more ETH than its refund.
47. Given the real `DutchAuction`, when the attacker re-enters `claim`, `cancelBid`, `withdrawProceeds` or `sweep` from `receive()`, then the re-entrant call reverts and balances stay correct.

**Front end**
48. Given a wallet on the wrong chain, then the UI shows a switch-network prompt and disables actions.
49. Given Active, then the chart shows all N steps, a "now" marker, a demand line and a standing-order ladder, refreshed on new events or every step.
50. Given a max price entered below the current price, then the form labels the bid "standing order at step j, price X".
51. Given Finalized, then the chart marks the clearing point, My bids shows the exact claimable tokens and refund, and the deadline is displayed.
52. Given a non-owner wallet, then the owner panel is hidden.

## 8. Out of scope
KYC/whitelists; multiple or concurrent auctions per contract (factory); upgradeability/proxies; pause/emergency cancel; owner-bid restriction or anti-shill measures; vesting or lockups on claimed tokens; token trading or liquidity provision; mainnet deployment; continuous (per-second) or exponential price decay; ERC-20 tokens other than ETH as payment; gas sponsorship/meta-transactions; a backend server or indexer (the front end reads chain events directly); mobile-specific UI.

## 9. Open questions
None.
