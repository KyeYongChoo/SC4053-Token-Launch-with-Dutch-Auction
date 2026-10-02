// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title DutchAuction
/// @notice Uniform-clearing-price Dutch auction for an ERC20 token launch.
///
/// Mechanics
/// - The price falls linearly from `startPrice` to `reservePrice` over `DURATION`
///   (20 minutes), computed from `block.timestamp` on every call.
/// - Bidders commit ETH. Demand at price p is `totalCommitted / p` tokens. The
///   auction clears as soon as demand covers `tokensForSale`, i.e. when
///   `totalCommitted >= p * tokensForSale`. That can happen inside a bid, or
///   silently as the price decays between transactions.
/// - Every bidder pays the same clearing price: `tokens = commitment / clearingPrice`.
///   Bidding early never costs more than bidding late.
/// - A bid that bridges the clearing threshold is only accepted up to the
///   remaining capacity; the surplus is credited as a refund.
/// - If the 20 minutes elapse without selling out, the auction settles at the
///   reserve price and the unsold tokens are burned.
///
/// Prices are wei per whole token (1e18 base units).
contract DutchAuction is Ownable, ReentrancyGuard {
    using SafeERC20 for ERC20Burnable;

    uint256 public constant DURATION = 20 minutes;
    uint256 private constant TOKEN_UNIT = 1e18;

    ERC20Burnable public immutable token;
    uint256 public immutable tokensForSale;
    uint256 public immutable startPrice;
    uint256 public immutable reservePrice;

    uint256 public startTime;
    uint256 public totalCommitted;
    uint256 public clearingPrice;
    uint256 public tokensSold;
    bool public finalized;
    bool public proceedsWithdrawn;

    mapping(address => uint256) public commitments;
    mapping(address => uint256) public refunds;

    event AuctionStarted(uint256 startTime, uint256 endTime);
    event BidPlaced(address indexed bidder, uint256 accepted, uint256 refundCredited, uint256 price);
    event AuctionFinalized(uint256 clearingPrice, uint256 tokensSold, uint256 tokensBurned);
    event Claimed(address indexed bidder, uint256 tokens, uint256 refund);
    event ProceedsWithdrawn(address indexed to, uint256 amount);

    error InvalidParameters();
    error AlreadyStarted();
    error NotStarted();
    error AuctionEnded();
    error AuctionStillActive();
    error AlreadyFinalized();
    error ZeroBid();
    error NothingToClaim();
    error ProceedsAlreadyWithdrawn();
    error EthTransferFailed();

    constructor(
        ERC20Burnable token_,
        uint256 tokensForSale_,
        uint256 startPrice_,
        uint256 reservePrice_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(token_) == address(0) ||
            tokensForSale_ == 0 ||
            reservePrice_ == 0 ||
            startPrice_ <= reservePrice_
        ) revert InvalidParameters();

        token = token_;
        tokensForSale = tokensForSale_;
        startPrice = startPrice_;
        reservePrice = reservePrice_;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function endTime() public view returns (uint256) {
        return startTime == 0 ? 0 : startTime + DURATION;
    }

    /// @notice Price implied by the decay curve at the current block timestamp.
    function currentPrice() public view returns (uint256) {
        if (startTime == 0) return startPrice;
        uint256 elapsed = block.timestamp - startTime;
        if (elapsed >= DURATION) return reservePrice;
        return startPrice - ((startPrice - reservePrice) * elapsed) / DURATION;
    }

    /// @notice ETH still needed to sell out at the current price (0 once cleared).
    function remainingCapacity() public view returns (uint256) {
        uint256 cap = _commitmentCap(currentPrice());
        return totalCommitted >= cap ? 0 : cap - totalCommitted;
    }

    /// @notice True while bids are accepted.
    function isActive() public view returns (bool) {
        return
            startTime != 0 &&
            !finalized &&
            block.timestamp < startTime + DURATION &&
            remainingCapacity() > 0;
    }

    /// @notice Tokens `bidder` would receive if the auction settled right now.
    function claimableTokens(address bidder) external view returns (uint256) {
        uint256 price = finalized ? clearingPrice : _settlementPrice();
        return (commitments[bidder] * TOKEN_UNIT) / price;
    }

    // ------------------------------------------------------------------
    // Auction lifecycle
    // ------------------------------------------------------------------

    /// @notice Pulls `tokensForSale` from the owner (requires approval) and starts the clock.
    function start() external onlyOwner {
        if (startTime != 0) revert AlreadyStarted();
        startTime = block.timestamp;
        token.safeTransferFrom(msg.sender, address(this), tokensForSale);
        emit AuctionStarted(block.timestamp, block.timestamp + DURATION);
    }

    /// @notice Commit ETH at the current price. Any amount above what is needed to
    ///         sell out is credited to `refunds` and paid out by `claim`.
    function bid() external payable nonReentrant {
        if (startTime == 0) revert NotStarted();
        if (msg.value == 0) revert ZeroBid();
        if (finalized || block.timestamp >= startTime + DURATION) revert AuctionEnded();

        uint256 price = currentPrice();
        uint256 cap = _commitmentCap(price);
        // Sold out by price decay since the last bid.
        if (totalCommitted >= cap) revert AuctionEnded();

        uint256 remaining = cap - totalCommitted;
        uint256 accepted = msg.value < remaining ? msg.value : remaining;
        uint256 surplus = msg.value - accepted;

        commitments[msg.sender] += accepted;
        totalCommitted += accepted;
        if (surplus > 0) refunds[msg.sender] += surplus;

        emit BidPlaced(msg.sender, accepted, surplus, price);

        if (accepted == remaining) _finalize();
    }

    /// @notice Settles the auction once it has sold out or the time is up. Callable by anyone.
    function finalize() external nonReentrant {
        if (finalized) revert AlreadyFinalized();
        _finalize();
    }

    /// @notice Sends the caller their tokens and any refund. Finalizes first if needed.
    function claim() external nonReentrant {
        if (!finalized) _finalize();

        uint256 commitment = commitments[msg.sender];
        uint256 refund = refunds[msg.sender];
        if (commitment == 0 && refund == 0) revert NothingToClaim();

        // Effects before interactions.
        commitments[msg.sender] = 0;
        refunds[msg.sender] = 0;

        uint256 tokens = (commitment * TOKEN_UNIT) / clearingPrice;
        emit Claimed(msg.sender, tokens, refund);

        if (tokens > 0) token.safeTransfer(msg.sender, tokens);
        if (refund > 0) _sendEth(msg.sender, refund);
    }

    /// @notice Sends the auction proceeds to the owner after settlement.
    function withdrawProceeds() external onlyOwner nonReentrant {
        if (!finalized) _finalize();
        if (proceedsWithdrawn) revert ProceedsAlreadyWithdrawn();
        proceedsWithdrawn = true;

        uint256 amount = totalCommitted;
        emit ProceedsWithdrawn(msg.sender, amount);
        if (amount > 0) _sendEth(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Maximum total ETH that can be committed at `price` without overselling.
    function _commitmentCap(uint256 price) private view returns (uint256) {
        return (price * tokensForSale) / TOKEN_UNIT;
    }

    /// @dev Price the auction would settle at now, whether or not it is over yet.
    function _settlementPrice() private view returns (uint256) {
        uint256 price = currentPrice();
        // Lowest price at which the committed ETH buys no more than the supply.
        // Rounded up so allocations can never exceed `tokensForSale`.
        uint256 soldOutPrice = Math.mulDiv(totalCommitted, TOKEN_UNIT, tokensForSale, Math.Rounding.Ceil);
        return soldOutPrice > price ? soldOutPrice : price;
    }

    function _finalize() private {
        if (startTime == 0) revert NotStarted();

        bool soldOut = totalCommitted >= _commitmentCap(currentPrice());
        if (!soldOut && block.timestamp < startTime + DURATION) revert AuctionStillActive();

        uint256 price = _settlementPrice();
        uint256 sold = (totalCommitted * TOKEN_UNIT) / price;
        uint256 unsold = tokensForSale - sold;

        finalized = true;
        clearingPrice = price;
        tokensSold = sold;

        emit AuctionFinalized(price, sold, unsold);

        if (unsold > 0) token.burn(unsold);
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
