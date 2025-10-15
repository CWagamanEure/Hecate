# Hecate: EVM Crossing Batch Auction Network 

Status: research prototype (not audited).

## What is Hecate?

Hecate is a crossing network for the EVM that clears orders in batches at a
reference mid-price with guardrails. The goal is to trade a bit of 
latency for lower information leakage, less sandwich exposure, and more
predictable execution under explicit constraints (oracle staleness/
deviation, bonds to deter griefing).


## What is a Crossing Network?

A Crossing Network is not a bridge to another blockchain. Rather, its a term coined in Centralized Finance. A Crossing Network is an alternative
exchange which derives its price from the continuous order flow of another exchange. As you may have guessed, these types of exchanges have been in 
the past very controversial, in that many people believe they are unfairly feeding off the hard work of someone elses orderflow. Most of the time, these exchanges
are used to hide orderflow from a standard exchange, used if a trader would rather sacrifice speed for discreteness.

## Research Project Goals:
- Create an alternative EVM dex, which sacrifices speed for more discrete orders and potentially better prices
- Commit and Reveal structure which avoids storing orders on-chain until trade execution 
- Bond collected to discourage order griefing
- Link pricing to oracle midPrice
- Create the "Darks Pools" for the EVM


## Contracts and Responsibilities

### CrossingManager
Orchestrates batch lifecycle (open -> reveal -> clear -> claim). Owns 
paramaters (batch window, max order size, fees). Talks to PriceGuard, 
OrderStore, BondVault, and MatchingEngine

### BondVault
Escrows bonds keyed by CommitId. Handles redunds and forfeits on the cancel
and reveal rules and after settlement. 

### OrderStore
Minimal storage. Holds commitments (hashes) and reveal metadata; emits
events. Supports commit, cancel, and reveal. Typed data via EIP-712
is recomended for off-chain signing.

### OrderMatchingEngine
Statless and isolated matching logic. Consumes the revealed orders
and a clearing mid-price and returns batch fills and settlement delta. 

### PriceGuard
Maintains baseAgg and quoteAgg feeds. Computes mid and enforces stalenessWindow,
maxDeviationBps.

## How it differs from other Market Microstructures
- vs AMMs: Price is exogenous (oracle mid) rather than endogenous like 
Curve. Lower continuous leakage, with discrete batches not continuous.
- vs CLOBs: simplier state, fewer cancels/amends on-chain; higher latency;
less precise price formation.

## Assumptions and Risks
- Oracle dependencies: price quality of oracle
- Batch latency: slower than AMMs
- Liquidity coordination: need enough revealed orders to make batches 
meaningful.
- Griefing bonds

## Roadmap
- Add TWAP mid and multi-feed quorom
- Intent style inclusion lists compatability
- Param governance
- Invariant suite
- Example subgraph

## License
MIT. This is experimental software. No mainnet use without professional 
audit and formal verification.



