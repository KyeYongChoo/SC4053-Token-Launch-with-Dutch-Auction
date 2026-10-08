description of the core requirements, smart contract logic: 
Implement Ethereum smart contracts and a front-end web app for a token launch (STO/ICO)
where tokens are bid for using Ether and distributed via a Dutch auction over a 20-minute
window.
• ERC20Integration: Define project tokens using the ERC20 standard.
• Auction Engine: Implement Dutch auction mechanics in separate smart contract(s).
• Time-Bound Elapse: The auction runs for exactly 20 minutes. Tokens sell out at/above
reserve price, or unsold tokens are burned.
• Token Claims & Refunds: Distribute minted tokens and automatically process ETH
refunds for surplus bid amounts.
• (Bonus) Demonstrate reentrancy attack resistance (Guide / Practice Repo).

Requirements relating to Dutch Auction
• Descending Price Mechanism: Bidding opens at an intentionally high starting price and
descends automatically over time based on a predefined decay function.
• UniformClearing Price: Participants commit ETH capital. When total committed capital
meets total token supply, the auction clears.
• Fair Participant Equity: Every winning bidder pays the exact same final clearing price,
regardless of how high their initial bid was. Excess ETH is refunded.

UI features:
Have a bid button and a box to enter your bid.
have a line chart display of what the price is 

Spec md should contain e structural design, contract interfaces,
and state management 