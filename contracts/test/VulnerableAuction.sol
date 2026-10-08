// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VulnerableAuction
/// @notice TEST ONLY. Shows the classic reentrancy bug in a refund/claim path:
///         ETH is sent before the claimable balance is cleared, and there is no guard.
///         Used by test/Reentrancy.test.js to demonstrate the attack. Never deploy.
contract VulnerableAuction {
    mapping(address => uint256) public claimable;

    function deposit() external payable {
        claimable[msg.sender] += msg.value;
    }

    function claim() external {
        uint256 amount = claimable[msg.sender];
        require(amount > 0, "nothing to claim");
        (bool ok, ) = msg.sender.call{value: amount}(""); // interaction before effect
        require(ok, "transfer failed");
        claimable[msg.sender] = 0;
    }
}
