// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title LaunchToken
/// @notice Fixed-supply ERC-20 sold by DutchAuction. The whole supply is minted once, to the auction.
///         There is no other mint path; holders may burn their own balance.
contract LaunchToken is ERC20, ERC20Burnable {
    constructor(string memory name_, string memory symbol_, uint256 supply, address recipient)
        ERC20(name_, symbol_)
    {
        _mint(recipient, supply);
    }
}
