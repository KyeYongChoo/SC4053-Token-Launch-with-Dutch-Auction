# Review: PR #18, M1 contracts and tests

- **PR:** #18, `m1-contracts` into `main`
- **Scope:** `contracts/DutchAuction.sol`, `contracts/LaunchToken.sol`, `test/DutchAuction.test.js`, `hardhat.config.js`, `.github/workflows/ci.yml`
- **Verdict:** Changes requested for VULN-3 (SPEC mismatch) and VULN-1 (unbounded parameters). VULN-2 is owner-only. The auction logic itself has no bidder-loss issue found.

## Verification run
- `npx hardhat test` on this branch: **43 passing** (reproduced).
- `test/Vulnerabilities.test.js` (added in the review commit): **3 passing**. Each test asserts the current behaviour so the suite stays green. Flip the assertion when the finding is fixed.

## Vulnerabilities

### VULN-1: Low. Unbounded supply and prices overflow the sell-out check and brick the auction
- **Where:** `DutchAuction.sol:364` (`priceAt(k) * supply` in `_scan`), `:400` (`need = price * supply`), `:193` (`priceAt(cur) * supply` in `bid`). The constructor (`:108-113`) bounds only the step count and the price ordering, not `supply_` or the prices.
- **Failure:** with `supply = 2^200`, the first call that scans a step panics (0x11). `bid`, `cancelBid`, `finalize`, `claim` and `withdrawProceeds` all revert, the state stays Active, and `sweep` is unreachable.
- **Impact:** the launch never runs. No bidder ETH is at risk, because bids revert before taking ETH. The owner chooses the parameters, so this is Low.
- **Proof:** `test/Vulnerabilities.test.js`, "VULN-1".
- **Suggestion:** bound `supply_` and the prices in the constructor so that `price * supply` fits with margin. SPEC §2.1 says nothing about upper bounds, so SPEC should state the limits.

### VULN-2: Low. `renounceOwnership` is inherited and can lock the owner's proceeds
- **Where:** `DutchAuction.sol:14` inherits `Ownable`. `renounceOwnership` is public and not overridden.
- **Failure:** after `finalize`, the owner calls `renounceOwnership`. From then on `withdrawProceeds` and `sweep` revert for everyone, and the ETH stays in the contract.
- **Impact:** only the owner's proceeds and the post-deadline sweep are affected. Bidders can still claim.
- **Proof:** `test/Vulnerabilities.test.js`, "VULN-2".
- **Suggestion:** override `renounceOwnership` to revert. SPEC §1 defines no renounce path.

### VULN-3: Low, SPEC mismatch. `transferOwnership` is inherited, so the owner role can move
- **Where:** same inheritance as VULN-2.
- **SPEC:** §1 defines the owner as the deployer, with a fixed list of powers (`startAuction`, `withdrawProceeds`, `sweep`). AC1 says owner = deployer. Transferring the role is not listed.
- **Failure:** the owner calls `transferOwnership(alice)`. Alice can then `withdrawProceeds` and `sweep`, and the deployer can no longer do either.
- **Proof:** `test/Vulnerabilities.test.js`, "VULN-3".
- **Suggestion:** override `transferOwnership` to revert, or add the transfer to SPEC §1 if it is intended.

## Informational
- **I1:** Sweep after 30 days sends unclaimed bidder refunds to the owner and burns unclaimed tokens. This matches SPEC §2.15-16 and AC43-44. Bidders have 30 days to claim, and the UI shows the deadline.
- **I2:** AC16 (a bid reverts after a lazily detected sell-out) has no explicit test. The nearest is the AC20-21 test, "later bids revert". PLAN R2 should cite it, or add a dedicated test.
- **I3:** Event names differ from SPEC §4. SPEC says `Finalized` and `Swept`. The contract emits `AuctionFinalized` (`DutchAuction.sol:87`) and `AuctionSwept` (`:92`). An indexer built from the SPEC would miss these events.
- **I4:** `claim` gas grows with the caller's own bid count. `bid` credits `msg.sender`, so a third party cannot add bids to someone else's list. Not exploitable by others; relates to #21.

## SPEC.md contradictions
1. **Event names** (I3): SPEC §4 vs `DutchAuction.sol:87, :92`.
2. **Owner role** (VULN-2, VULN-3): inherited `renounceOwnership` and `transferOwnership` are not in SPEC §1.
3. **AC16 untested** (I2): a coverage gap, not a code contradiction.

Not a contradiction: `tokensSold` is set to `S` in the sold-out case (`:414`). SPEC §2.14 gives `floor(D_filled·1e18/price(c))`, and `D_filled = Need` exactly in that case, so the formula also yields `S`. Per-bid rounding dust is left for `sweep`, as SPEC §2.16 says.

## Checked and found correct
- **Constructor** (`:108-113`): `P0 > R > 0`, `S > 0`, `minBid > 0`, `1200 % Δ == 0`, `2 ≤ N ≤ 120`. Matches SPEC §2.1 and AC2.
- **Price schedule** (`:254-257`): `P0 - floor(k(P0-R)/(N-1))`, so price(0)=P0 and price(N-1)=R. Matches §2.2 and AC9.
- **Step clamp** (`:260-264`): `currentStep` clamps to N-1 at END. Matches AC6-8.
- **Snapping** (`:170-173`): `e = max(cur, smallest k with price(k) ≤ maxPrice)`. Matches §2.4-2.5 and AC12-14.
- **Live or standing** (`:190`): a bid is live exactly when `e == cur`. Matches §2.5.
- **Sell-out** (`:193`, `:364`): the `≥` comparison is inclusive and scaled by WAD. Matches §2.7 and AC18-19.
- **Lazy scan bookkeeping** (`:340-353`): live bids are added to `_runningDemand` once. `_scanned` advances to `cur+1`, so nothing is double-counted. A cancel only touches `_joinAmount[e]` for `e > cur`, which is never in the running total.
- **Tiers** (`:396-415`): the early branch gives joiners `f=0`, and the joiner branch uses `den = join*WAD`, which is non-zero because the sold-out condition forces `join > 0` in that branch. Matches §2.10 and AC23-25.
- **Per-bid settlement** (`:440-454`): tokens are rounded down and charges rounded up. Since `f ≤ 1`, `ethAmount - charged` cannot underflow. Matches §2.11.
- **Undersold** (`:390-396`): everyone is filled at `f=1` and the clearing price is R. Matches §2.9-2.10 and AC26.
- **Cancel** (`:203-216`): the state changes before the refund, and the rules match §2.12 and AC29-34.
- **Claim** (`:219-243`): `claimed` is set before the transfer, and it reverts when there is nothing to claim. Matches AC38-40.
- **Finalize and auto-finalize** (`:246-249`, `:431-437`): runs once, and a second call reverts. Matches AC36-37.
- **withdrawProceeds** (`:136-144`) and **sweep** (`:147-156`): each runs once, is restricted to the owner, and is `nonReentrant`. Matches AC42-44.
- **Solvency**: `Σcharged ≥ proceeds` and `Σtokens ≤ supply`, covered by AC28 and AC45.
- **Token** (`LaunchToken.sol`): the only mint is in the constructor, matching SPEC §4.
- **Views** (`:254-335`): every name in SPEC §4 exists.
- **Stale projection**: `previewClaim` before finalize uses the same `_quote`, so the preview and the claim agree.

## Not verified
- Block-timestamp drift (validators can shift `block.timestamp`) is not modelled. The window boundaries assume exact timestamps.
- Gas costs were not measured.
