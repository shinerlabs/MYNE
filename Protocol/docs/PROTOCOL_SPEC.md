# MYNE protocol working specification

Status: **local feature implementation, not an audit or deployment approval**

This document distinguishes rules already represented by the frontend from decisions that still
need an explicit answer. The on-chain program must not silently inherit behavior from the old EVM
ABIs in `Frontend/src/deployments`.

## Confirmed product identity and launch state

- Network: Solana.
- Protocol/token name and ticker: MYNE.
- Launch is direct; there is no pre-mine phase.
- Genesis mint: 100 MYNE.
- Pre-existing burn-staked supply: 0 MYNE.
- Initial market/liquidity allocation: all 100 genesis MYNE.
- Current UI hard-cap promise: 2,000,000 MYNE.
- Wallet transfers are not charged the 4% liquidity-pool tax.

The mint decimals, metadata authority, freeze authority, and final mint-authority custody are not
yet confirmed. These must be fixed before mint creation.

## Mining rounds

Current UI contract:

- 25 tiles.
- Fixed 65-second slots: 60 seconds open, then 5 seconds displaying the signer-authorized
  on-chain result. Settlement becomes eligible at the bidding boundary; there is no resolving
  countdown.
- Minimum aggregate deployment: 0.05 SOL per round, regardless of selected tile count.
- One MYNE base emission per resolved round.
- Split and Solo settlement modes each occur with 50% probability.
- Split: miners on the winning tile receive SOL and MYNE pro rata by deployed SOL.
- Solo: SOL remains pro rata on the winning tile; one deployment-weighted miner receives MYNE.
- Motherlode: currently shown as 1-in-650 per round. It is the SOL payment pool; each round also
  accrues a 0.2 MYNE staking bonus that is paid with a hit and burned into winners' staking weight.

Implemented Solana account design:

- `ProtocolConfig` PDA: authorities, immutable economics, timing, pause state.
- `Round` PDA, seeds `[b"round", round_id]`: tile totals, fee totals, randomness request/result,
  mode, winning tile and claim aggregates.
- `BetReceipt` PDA, seeds `[b"bet", round_id, miner, nonce]`: one deployment receipt, selected tile
  amounts, Solo ticket ranges and claimed state.
- `Miner` PDA, seeds `[b"miner", wallet]`: permanent referrer, unclaimed MYNE accounting and reward
  index debt.
- SOL vault PDA: holds unresolved round principal and claimable protocol allocations.

Using one receipt per deployment avoids an unbounded on-chain bettor list. There is no protocol
maximum for bids or users; capacity grows across independent accounts rather than an impossible
unbounded vector inside one Solana account. Each receipt holds a cumulative ticket range per
selected tile, allowing a Solo winner to prove its random ticket without iterating every miner.

Local/devnet decisions:

1. A wallet may submit any number of separate receipt deployments in a round.
2. Integer division dust stays in the round account pending a permissionless dust-sweep milestone.
3. Local/devnet settlement uses the configured trusted randomness signer. Mainnet remains blocked
   until this is replaced by a verified oracle callback.
4. Unsettled receipts become fully refundable ten minutes after the normal settlement time.
5. The 0.2 MYNE staking bonus is virtual until a Motherlode hit and becomes non-transferable 5x
   staking weight when claimed alongside the SOL payment.

## Mining fee

The UI currently promises a 12% fee on deployed SOL:

| Destination | Basis points | Share of deployment |
| --- | ---: | ---: |
| Staker SOL rewards | 800 | 8% |
| MYNE buyback and burn | 200 | 2% |
| Motherlode | 200 | 2% |
| **Total** | **1,200** | **12%** |

All arithmetic must use checked integer math. Allocation remainders stay in the round vault until
settlement and are assigned by one documented dust rule; they must never become implicit operator
revenue. There is no administration allocation.

At settlement, the 2% Motherlode share moves from the round PDA into the program-owned config PDA
and increments its tracked SOL balance. A funded winning round that hits the Motherlode atomically
moves the full tracked balance—including that round's contribution—back into the round prize for
receipt-based claims. If no tile has a winning deployment, the unawarded 88% prize also rolls into
the same tracked balance instead of becoming operator revenue.

## Unclaimed MYNE and referrals

- A MYNE claim charges 10%.
- 9% is redistributed to remaining unclaimed MYNE balances.
- 1% accrues to the claimant's permanent referrer.
- Attribution is first-valid and permanent; self-referral and simple cycles are rejected.

The scalable model is a global reward-per-unclaimed accumulator. Every miner checkpoints before
their balance changes. This avoids iterating all unclaimed miners during a claim.

Open decision: the current inherited EVM behavior waives some claim fee when nobody else is
unclaimed. The public MYNE documentation says 10%; the Solana program should use the public rule
unless the product explicitly chooses the exception.

## Staking

- Standard stake: 1x reward weight; unstake request enters a 30-day queue.
- Burn stake: token principal is burned permanently for 5x reward weight.
- Rewards are SOL, funded by 8% of mining deployments and 3% of taxed pool trades.
- The Motherlode staking bonus enters a 5x permanent burn-stake position for each winner; the
  Motherlode SOL payment remains claimable.

Working accounts:

- `StakePool` PDA: total standard principal, total burn principal, total weight and SOL reward
  accumulator.
- `StakePosition` PDA per wallet: principal, burn principal, weight, reward debt, cooldown amount
  and unlock timestamp.
- staking SOL vault PDA.

Staking bonuses are represented as non-transferable reward weight and tracked separately from the
liquid SPL mint supply. They are always awarded with the Motherlode SOL payment.

## Meteora liquidity-pool fee

- 4% of MYNE/SOL buys and sells, collected in SOL.
- The operator manually claims the SOL-denominated pool fees to a designated wallet.
- The operator deposits the staking allocation through permissionless `fund_staking_rewards`.
- Any Motherlode allocation is managed as a separate operator reserve.
- Wallet-to-wallet MYNE transfers are unaffected.

Do **not** enable Token-2022 `TransferFeeConfig` for this rule: that extension applies its fee to
every token transfer, including wallet transfers. The MYNE program therefore does not implement a
swap router or token transfer tax. The configured Meteora pool is the enforcement boundary, and the
website uses Meteora's SDK once a concrete devnet pool address and fee authority are supplied. Until
then the swap capability remains fail-closed.

## Randomness and settlement

Recent blockhashes, timestamps and validator-controlled values are not acceptable randomness.
Mining should use a provider-neutral request record, but production deployment must pin one audited
oracle integration and verify callbacks against its program ID and request account.

Every request stores the round/roll identity before randomness exists. Fulfilment is one-shot.
Settlement derives domain-separated values for tile, Split/Solo mode, Solo ticket and Motherlode
hit so one draw is not reused ambiguously.

## Indexing

Solana programs do not offer EVM-style historical log scans through the frontend adapters. Emit
structured Anchor events for deployments, resolution, claims, referrals and staking. A
read-only indexer supplies history, leaderboards and charts; all balances and claim eligibility
remain verifiable against program accounts.

## Upgrade and operations policy — required before devnet

- Upgrade authority owner and custody method.
- Admin multisig addresses and signer threshold.
- Pause scope; pause must not block user withdrawals/claims unless strictly necessary.
- Oracle authority and recovery procedure.
- Treasury destinations and whether they are program vaults or multisigs.
- Timelock for economic changes. Launch economics should otherwise be immutable.
