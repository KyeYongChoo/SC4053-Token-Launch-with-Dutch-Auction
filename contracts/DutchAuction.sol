// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LaunchToken} from "./LaunchToken.sol";

/// @title DutchAuction
/// @notice Stepped Dutch auction over a fixed 20-minute window with uniform clearing.
///         Every rule is defined in SPEC.md; section references are given inline.
/// @dev Sell-out is detected lazily: each state-changing call first scans the steps it has
///      not yet checked. Prices are in wei per whole token; token amounts are in token-wei.
contract DutchAuction is Ownable, ReentrancyGuard {
    uint256 public constant AUCTION_DURATION = 20 minutes; // SPEC §2.1
    uint256 public constant CLAIM_PERIOD = 30 days; // SPEC §2.15
    uint256 public constant MAX_STEPS = 120; // SPEC §2.1
    uint256 public constant MAX_SUPPLY = 1e30; // SPEC §2.1: 1e12 whole tokens, keeps price * supply * WAD inside uint256
    uint256 public constant MAX_START_PRICE = 1e24; // SPEC §2.1: 1e6 ETH per token
    uint256 private constant WAD = 1e18;

    enum State {
        Created,
        Active,
        Finalized,
        Swept
    }

    struct Bid {
        address bidder;
        uint256 ethAmount;
        uint256 maxPrice;
        uint256 placedStep;
        uint256 effectiveStep; // SPEC §2.5
        bool cancelled;
        bool claimed;
    }

    /// @dev Fill fractions are stored as num/den so that all rounding is exact (SPEC §2.10).
    struct Clearing {
        bool soldOut;
        uint256 step; // clearing step c
        uint256 price; // price(c)
        uint256 tokensSold;
        uint256 proceeds;
        uint256 earlyNum; // fraction for bids with effectiveStep < c
        uint256 earlyDen;
        uint256 joinNum; // fraction for bids with effectiveStep == c
        uint256 joinDen;
    }

    LaunchToken public immutable token;
    uint256 public immutable supply;
    uint256 public immutable startPrice;
    uint256 public immutable reservePrice;
    uint256 public immutable stepDuration;
    uint256 public immutable stepCount;
    uint256 public immutable minBid;

    State public state;
    uint256 public startTime;
    uint256 public endTime;
    bool public soldOut;
    uint256 public soldOutStep;
    uint256 public finalizedAt;
    bool public proceedsWithdrawn;
    Clearing public clearing;

    Bid[] private _bids;
    mapping(address => uint256[]) private _bidIdsOf;
    /// @dev ETH of non-cancelled bids whose effectiveStep equals the key.
    mapping(uint256 => uint256) private _joinAmount;
    /// @dev Steps [0, _scanned) have been checked for sell-out.
    uint256 private _scanned;
    /// @dev Cumulative demand over steps [0, _scanned).
    uint256 private _runningDemand;

    event AuctionStarted(uint256 start, uint256 end);
    event BidPlaced(
        uint256 indexed bidId,
        address indexed bidder,
        uint256 ethAmount,
        uint256 maxPrice,
        uint256 placedStep,
        uint256 effectiveStep
    );
    event BidCancelled(uint256 indexed bidId, address indexed bidder, uint256 refund);
    event SoldOut(uint256 step, uint256 price);
    event AuctionFinalized(
        uint256 clearingStep, uint256 clearingPrice, uint256 tokensSold, uint256 tokensBurned, bool soldOut
    );
    event Claimed(address indexed bidder, uint256 tokens, uint256 refund);
    event ProceedsWithdrawn(address indexed owner, uint256 amount);
    event AuctionSwept(uint256 tokensBurned, uint256 ethToOwner);

    /// @param supply_ Total token supply in token-wei (18 decimals).
    /// @param startPrice_ Price at step 0, wei per whole token.
    /// @param reservePrice_ Price at the final step, wei per whole token.
    /// @param stepDuration_ Seconds per step; must divide 1200 evenly (SPEC §2.1).
    /// @param minBid_ Smallest accepted bid, in wei.
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        uint256 startPrice_,
        uint256 reservePrice_,
        uint256 stepDuration_,
        uint256 minBid_
    ) Ownable(msg.sender) {
        require(supply_ > 0, "supply");
        require(supply_ <= MAX_SUPPLY, "supply too large");
        require(startPrice_ <= MAX_START_PRICE, "price too large");
        require(reservePrice_ > 0 && startPrice_ > reservePrice_, "prices");
        require(minBid_ > 0, "minBid");
        require(stepDuration_ > 0 && AUCTION_DURATION % stepDuration_ == 0, "stepDuration");
        uint256 n = AUCTION_DURATION / stepDuration_;
        require(n >= 2 && n <= MAX_STEPS, "stepCount");

        supply = supply_;
        startPrice = startPrice_;
        reservePrice = reservePrice_;
        stepDuration = stepDuration_;
        stepCount = n;
        minBid = minBid_;
        token = new LaunchToken(name_, symbol_, supply_, address(this));
    }

    // ───────────────────────── Owner ─────────────────────────

    /// @notice Renouncing is disabled: proceeds and the sweep need an owner (SPEC §1).
    function renounceOwnership() public pure override {
        revert("renounce disabled");
    }

    /// @notice Starts the clock. Only callable once (SPEC §4).
    function startAuction() external onlyOwner {
        require(state == State.Created, "already started");
        state = State.Active;
        startTime = block.timestamp;
        endTime = block.timestamp + AUCTION_DURATION;
        emit AuctionStarted(startTime, endTime);
    }

    /// @notice Pays out sale proceeds once. Auto-finalizes if needed (SPEC §2.14).
    function withdrawProceeds() external onlyOwner nonReentrant {
        _ensureFinalized();
        require(state == State.Finalized, "not finalized");
        require(!proceedsWithdrawn, "already withdrawn");
        proceedsWithdrawn = true;
        uint256 amount = clearing.proceeds;
        _sendEth(owner(), amount);
        emit ProceedsWithdrawn(owner(), amount);
    }

    /// @notice After the claim deadline, burns unclaimed tokens and sends all remaining ETH to the owner.
    function sweep() external onlyOwner nonReentrant {
        require(state == State.Finalized, "not finalized");
        require(block.timestamp > finalizedAt + CLAIM_PERIOD, "claim period open");
        state = State.Swept;
        uint256 tokensBurned = token.balanceOf(address(this));
        if (tokensBurned > 0) token.burn(tokensBurned);
        uint256 ethAmount = address(this).balance;
        _sendEth(owner(), ethAmount);
        emit AuctionSwept(tokensBurned, ethAmount);
    }

    // ───────────────────────── Bidders ─────────────────────────

    /// @notice Commits ETH with a maximum price (SPEC §2.3–2.7).
    /// @return bidId Incremental id of the new bid.
    function bid(uint256 maxPrice) external payable returns (uint256 bidId) {
        require(state == State.Active, "not active");
        require(block.timestamp < endTime, "ended");
        require(msg.value >= minBid, "below minBid");
        require(maxPrice >= reservePrice, "below reserve");
        _advance();
        require(!soldOut, "sold out");

        uint256 cur = currentStep();
        // Smallest step >= cur whose price is at or below maxPrice (SPEC §2.4–2.5).
        uint256 eff = cur;
        while (priceAt(eff) > maxPrice) eff++;

        bidId = _bids.length;
        _bids.push(
            Bid({
                bidder: msg.sender,
                ethAmount: msg.value,
                maxPrice: maxPrice,
                placedStep: cur,
                effectiveStep: eff,
                cancelled: false,
                claimed: false
            })
        );
        _bidIdsOf[msg.sender].push(bidId);
        _joinAmount[eff] += msg.value;

        if (eff == cur) {
            // Live bid: counts toward demand at the current step right away (SPEC §2.7b).
            _runningDemand += msg.value;
            if (_runningDemand * WAD >= priceAt(cur) * supply) {
                soldOut = true;
                soldOutStep = cur;
                emit SoldOut(cur, priceAt(cur));
            }
        }
        emit BidPlaced(bidId, msg.sender, msg.value, maxPrice, cur, eff);
    }

    /// @notice Withdraws a standing order before its price is reached (SPEC §2.12).
    function cancelBid(uint256 bidId) external nonReentrant {
        Bid storage b = _bids[bidId];
        require(b.bidder == msg.sender, "not your bid");
        require(!b.cancelled, "already cancelled");
        require(state == State.Active, "not active");
        _advance();
        require(!soldOut && block.timestamp < endTime, "ended");
        require(currentStep() < b.effectiveStep, "already live");

        b.cancelled = true;
        _joinAmount[b.effectiveStep] -= b.ethAmount;
        emit BidCancelled(bidId, msg.sender, b.ethAmount);
        _sendEth(msg.sender, b.ethAmount);
    }

    /// @notice Settles all of the caller's uncancelled, unclaimed bids (SPEC §2.11, §2.15).
    function claim() external nonReentrant {
        _ensureFinalized();
        require(state == State.Finalized, "not claimable");
        require(block.timestamp <= finalizedAt + CLAIM_PERIOD, "claim period over");

        Clearing memory k = clearing;
        uint256 totalTokens;
        uint256 totalRefund;
        uint256 count;
        uint256[] storage ids = _bidIdsOf[msg.sender];
        for (uint256 i = 0; i < ids.length; i++) {
            Bid storage b = _bids[ids[i]];
            if (b.cancelled || b.claimed) continue;
            (uint256 tokens, uint256 charged) = _quote(b, k);
            b.claimed = true;
            totalTokens += tokens;
            totalRefund += b.ethAmount - charged;
            count++;
        }
        require(count > 0, "nothing to claim");

        emit Claimed(msg.sender, totalTokens, totalRefund);
        if (totalTokens > 0) require(token.transfer(msg.sender, totalTokens), "token transfer");
        _sendEth(msg.sender, totalRefund);
    }

    /// @notice Ends the auction once it has sold out or 20 minutes have passed (SPEC §2.14).
    function finalize() external {
        require(state == State.Active, "not active");
        _ensureFinalized();
    }

    // ───────────────────────── Views ─────────────────────────

    /// @notice Price of a step, wei per whole token (SPEC §2.2).
    function priceAt(uint256 k) public view returns (uint256) {
        require(k < stepCount, "bad step");
        return startPrice - (k * (startPrice - reservePrice)) / (stepCount - 1);
    }

    /// @notice Step index at the current block time, clamped to the last step.
    function currentStep() public view returns (uint256) {
        if (state == State.Created) return 0;
        if (block.timestamp >= endTime) return stepCount - 1;
        return (block.timestamp - startTime) / stepDuration;
    }

    function currentPrice() external view returns (uint256) {
        return priceAt(currentStep());
    }

    /// @notice True once the auction has sold out, or 20 minutes have passed, or it was finalized.
    /// @dev Includes sell-outs that have not yet been recorded on-chain.
    function isEnded() public view returns (bool) {
        if (state == State.Finalized || state == State.Swept) return true;
        if (state == State.Created) return false;
        (bool sold, ) = _projectedSellOut();
        return sold || block.timestamp >= endTime;
    }

    /// @notice Cumulative ETH demanded by bids active at or before step k.
    function demandAt(uint256 k) external view returns (uint256) {
        return _demandUpTo(k);
    }

    /// @notice ETH of non-cancelled bids whose effective step is exactly k.
    function stepJoinAmount(uint256 k) external view returns (uint256) {
        return _joinAmount[k];
    }

    function getBid(uint256 bidId) external view returns (Bid memory) {
        return _bids[bidId];
    }

    function bidCount() external view returns (uint256) {
        return _bids.length;
    }

    function bidsOf(address who) external view returns (uint256[] memory) {
        return _bidIdsOf[who];
    }

    /// @notice Tokens and refund the address would receive from claim().
    /// @dev Exact after finalization; before finalization it projects the current state.
    function previewClaim(address who) external view returns (uint256 tokens, uint256 refund) {
        if (state == State.Created) return (0, 0);
        Clearing memory k = (state == State.Finalized || state == State.Swept) ? clearing : _computeClearing();
        uint256[] storage ids = _bidIdsOf[who];
        for (uint256 i = 0; i < ids.length; i++) {
            Bid storage b = _bids[ids[i]];
            if (b.cancelled || b.claimed) continue;
            (uint256 t, uint256 charged) = _quote(b, k);
            tokens += t;
            refund += b.ethAmount - charged;
        }
    }

    function clearingStep() external view returns (uint256) {
        return clearing.step;
    }

    function clearingPrice() external view returns (uint256) {
        return clearing.price;
    }

    function tokensSold() external view returns (uint256) {
        return clearing.tokensSold;
    }

    function proceeds() external view returns (uint256) {
        return clearing.proceeds;
    }

    function claimDeadline() external view returns (uint256) {
        if (state != State.Finalized && state != State.Swept) return 0;
        return finalizedAt + CLAIM_PERIOD;
    }

    // ───────────────────────── Internals ─────────────────────────

    /// @dev Checks every not-yet-scanned step up to the current one for sell-out, and records it.
    function _advance() internal {
        if (state != State.Active || soldOut) return;
        uint256 cur = currentStep();
        (bool sold, uint256 step, uint256 total) = _scan(_scanned, cur, _runningDemand);
        _runningDemand = total;
        if (sold) {
            soldOut = true;
            soldOutStep = step;
            _scanned = step + 1;
            emit SoldOut(step, priceAt(step));
        } else {
            _scanned = cur + 1;
        }
    }

    /// @dev Walks steps [from, to] accumulating demand; returns the first step where demand covers supply.
    function _scan(uint256 from, uint256 to, uint256 running)
        internal
        view
        returns (bool sold, uint256 step, uint256 total)
    {
        total = running;
        for (uint256 k = from; k <= to; k++) {
            total += _joinAmount[k];
            if (total * WAD >= priceAt(k) * supply) return (true, k, total);
        }
    }

    /// @dev Sell-out as it would be recorded by _advance, without writing.
    function _projectedSellOut() internal view returns (bool sold, uint256 step) {
        if (soldOut) return (true, soldOutStep);
        if (state != State.Active) return (false, 0);
        (sold, step, ) = _scan(_scanned, currentStep(), _runningDemand);
    }

    function _demandUpTo(uint256 k) internal view returns (uint256 total) {
        for (uint256 i = 0; i <= k; i++) {
            total += _joinAmount[i];
        }
    }

    /// @dev Clearing rules, SPEC §2.9–2.10 (computed from the projected state).
    function _computeClearing() internal view returns (Clearing memory k) {
        (bool sold, uint256 c) = _projectedSellOut();
        if (!sold) c = stepCount - 1;
        k.soldOut = sold;
        k.step = c;
        k.price = priceAt(c);

        uint256 demand = _demandUpTo(c);
        if (!sold) {
            // Undersold: everyone is filled in full at the reserve price (SPEC §2.9, §2.10).
            k.earlyNum = 1;
            k.earlyDen = 1;
            k.joinNum = 1;
            k.joinDen = 1;
            k.tokensSold = Math.min(supply, Math.mulDiv(demand, WAD, k.price));
        } else {
            uint256 join = _joinAmount[c];
            uint256 earlier = demand - join;
            uint256 need = k.price * supply; // wei * WAD
            if (earlier * WAD >= need) {
                // Earlier bids cover the whole sale; joiners at step c get nothing.
                k.earlyNum = need;
                k.earlyDen = earlier * WAD;
                k.joinNum = 0;
                k.joinDen = 1;
            } else {
                // Earlier bids are filled in full; joiners at step c share the remainder pro-rata.
                k.earlyNum = 1;
                k.earlyDen = 1;
                k.joinNum = need - earlier * WAD;
                k.joinDen = join * WAD;
            }
            k.tokensSold = supply;
        }
        k.proceeds = Math.mulDiv(k.price, k.tokensSold, WAD);
    }

    /// @dev Records the clearing result and burns unsold supply (SPEC §2.14).
    function _finalize() internal {
        Clearing memory k = _computeClearing();
        clearing = k;
        state = State.Finalized;
        finalizedAt = block.timestamp;
        uint256 burned = supply - k.tokensSold;
        if (burned > 0) token.burn(burned);
        emit AuctionFinalized(k.step, k.price, k.tokensSold, burned, k.soldOut);
    }

    /// @dev Finalizes if the auction has ended but nobody has finalized it yet.
    function _ensureFinalized() internal {
        if (state == State.Active) {
            _advance();
            require(soldOut || block.timestamp >= endTime, "not ended");
            _finalize();
        }
    }

    /// @dev Tokens and charged ETH for one bid under the clearing result (SPEC §2.11).
    function _quote(Bid storage b, Clearing memory k) internal view returns (uint256 tokens, uint256 charged) {
        uint256 num;
        uint256 den;
        if (b.effectiveStep < k.step) {
            num = k.earlyNum;
            den = k.earlyDen;
        } else if (b.effectiveStep == k.step) {
            num = k.joinNum;
            den = k.joinDen;
        } else {
            return (0, 0);
        }
        charged = Math.mulDiv(b.ethAmount, num, den, Math.Rounding.Ceil);
        tokens = Math.mulDiv(b.ethAmount, num * WAD, den * k.price);
    }

    function _sendEth(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "ETH transfer failed");
    }
}
