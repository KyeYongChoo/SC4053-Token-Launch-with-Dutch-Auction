// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IAuctionLike {
    function bid() external payable;

    function claim() external;
}

/// @title ReentrancyAttacker
/// @notice TEST ONLY. Over-bids so the auction owes it a refund, then re-enters
///         `claim` from its `receive` hook to try to collect that refund repeatedly.
contract ReentrancyAttacker {
    IAuctionLike public immutable target;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;

    constructor(IAuctionLike target_) {
        target = target_;
    }

    function attack() external payable {
        target.bid{value: msg.value}();
        target.claim();
    }

    receive() external payable {
        // Keep re-entering while there is still someone else's ETH to take.
        if (address(target).balance >= msg.value && reentryAttempts < 10) {
            reentryAttempts++;
            try target.claim() {
                reentrySuccesses++;
            } catch {}
        }
    }
}
