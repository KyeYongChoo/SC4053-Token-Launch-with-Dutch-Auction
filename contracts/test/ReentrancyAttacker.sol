// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DutchAuction} from "../DutchAuction.sol";
import {VulnerableAuction} from "./VulnerableAuction.sol";

/// @title ReentrancyAttacker
/// @notice TEST ONLY. Deploys a victim, acts as its owner/bidder, and re-enters it from receive()
///         with a stored calldata payload. Used by test/Reentrancy.test.js.
contract ReentrancyAttacker {
    address public victim;
    bytes public callback;
    uint256 public maxReentries;
    uint256 public reentries;
    bool public lastReentryOk;

    function deployDutch(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        uint256 startPrice_,
        uint256 reservePrice_,
        uint256 stepDuration_,
        uint256 minBid_
    ) external returns (address) {
        victim = address(
            new DutchAuction(name_, symbol_, supply_, startPrice_, reservePrice_, stepDuration_, minBid_)
        );
        return victim;
    }

    function deployVulnerable() external returns (address) {
        victim = address(new VulnerableAuction());
        return victim;
    }

    /// @notice Arms the re-entry: on every ETH receipt, call `victim` with `data`, up to `max` times.
    function arm(bytes calldata data, uint256 max) external {
        callback = data;
        maxReentries = max;
        reentries = 0;
    }

    /// @notice Calls the victim as this contract (so it is msg.sender / owner there).
    function execute(bytes calldata data, uint256 value) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = victim.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {
        if (reentries < maxReentries && callback.length > 0) {
            reentries++;
            (bool ok, ) = victim.call(callback);
            lastReentryOk = ok;
        }
    }
}
