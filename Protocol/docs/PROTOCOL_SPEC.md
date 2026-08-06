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
- Trading fees are deferred and are not part of this protocol milestone. Wallet transfers remain
  ordinary SPL transfers.

The mint uses 9 decimals, has no freeze authority, and assigns mint authority to the protocol
config PDA after the 100 MYNE genesis mint. Metadata authority and the final upgrade-authority
custody remain deployment decisions; they must be recorded before mainnet.

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
  accrues a 0.2 MYNE staking bonus. On a hit, the bonus is paid alongside the SOL reward to the
  miners of that round, permanently burned, and added to each recipient's 5x staking weight.

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
5. The 0.2 MYNE staking bonus is virtual until a Motherlode hit. It is never a liquid or claimable
   token balance: when claimed alongside the SOL payment, it is permanently burned and becomes
   non-transferable 5x staking weight for each miner receiving the shared Motherlode reward.

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

## Launch liquidity gate

Initialization always leaves the protocol paused. Before the admin can unpause it, a separate
`LiquidityGate` PDA must be initialized with the exact official Meteora pool address and its owner
program. The gate records the declared minimum SOL and MYNE thresholds for the pool-registration
runbook and prevents miners or other users from substituting a competing pool before emissions
begin. The `config.paused` flag is the single protocol activation latch: one successful unpause
starts rounds, mining, staking, referrals, emissions, and buyback accounting together. Unpausing
checks that the exact registered account still exists and is owned by the registered Meteora
program; settlement repeats this check before moving the first round's 2% buyback/burn allocation.
Pool-specific reserve decoding remains a required deployment check.
`claim_myne` also respects the pause flag, so an emergency pause cannot leave a token-minting
escape hatch.

## Unclaimed MYNE and referrals

- A MYNE claim charges 10%.
- 9% is redistributed to remaining unclaimed MYNE balances.
- 1% accrues to the claimant's permanent referrer; if no referrer is set, it is minted to
  the configured admin-fee wallet.
- Attribution is first-valid and permanent; self-referral and simple cycles are rejected.

The scalable model is a global reward-per-unclaimed accumulator. Every miner checkpoints before
their balance changes. This avoids iterating all unclaimed miners during a claim.

The 10% fee is always charged, including when no referrer is set. This keeps the fee split
deterministic and prevents an unlabelled referral share from silently inflating the passive pool.

## Staking

- Standard stake: 1x reward weight; unstake request enters a 30-day queue.
- Burn stake: token principal is burned permanently for 5x reward weight.
- Rewards are SOL, funded by the 8% mining-deployment allocation.
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

## Future trading integration

Meteora trading and any pool-trade fee are intentionally deferred. No buy/sell tax is collected by
the MYNE program in this milestone. The current on-chain fee schedule is limited to mining rounds:
8% to staking rewards, 2% to the Motherlode, and 2% to buyback and burn.

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
