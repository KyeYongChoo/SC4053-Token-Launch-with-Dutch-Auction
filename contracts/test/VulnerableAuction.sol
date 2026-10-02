// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title VulnerableAuction
/// @notice TEST ONLY. A stripped-down sale with the same `bid`/`claim` surface as
///         DutchAuction but a deliberately broken refund path: it sends ETH before
///         clearing the refund balance and has no reentrancy guard. Used to show
///         that the attack in ReentrancyAttacker is real, and that DutchAuction
///         resists it.
contract VulnerableAuction {
    uint256 public immutable cap;
    uint256 public totalCommitted;

    mapping(address => uint256) public commitments;
    mapping(address => uint256) public refunds;

    constructor(uint256 cap_) {
        cap = cap_;
    }

    function bid() external payable {
        uint256 remaining = cap - totalCommitted;
        uint256 accepted = msg.value < remaining ? msg.value : remaining;

        commitments[msg.sender] += accepted;
        totalCommitted += accepted;
        refunds[msg.sender] += msg.value - accepted;
    }

    function claim() external {
        uint256 refund = refunds[msg.sender];
        require(refund > 0, "nothing to claim");

        // BUG: interaction before effect. The callee can re-enter while
        // refunds[msg.sender] is still non-zero.
        (bool ok, ) = msg.sender.call{value: refund}("");
        require(ok, "transfer failed");

        refunds[msg.sender] = 0;
    }
}
