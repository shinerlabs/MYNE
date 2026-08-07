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
  accrues a 0.2 MYNE staking bonus. On a hit, both pools are shared by every participant in that
  round pro rata by total SOL deployed. The MYNE share is permanently burned and added to each
  recipient's 5x staking weight.

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
2. Integer rewards use cumulative interval allocation. Adjacent receipt intervals telescope, so
   the final receipt receives the rounding remainder and the entire SOL/MYNE pool is accounted for.
3. Local settlement alone may use the configured trusted signer. Devnet and Mainnet use a bound
   Switchboard commit/reveal account and verified settlement. Devnet does not require a Meteora
   pool; Mainnet remains pool-gated.
4. Unsettled receipts become fully refundable ten minutes after the normal settlement time.
5. The 0.2 MYNE staking bonus is virtual until a Motherlode hit. It is never a liquid or claimable
   token balance: each round participant receives SOL and virtual-burn MYNE pro rata by total SOL
   deployed, and that MYNE becomes non-transferable 5x staking weight.

## Mining fee

Protocol version 6 charges an exact 12% fee on deployed SOL:

| Destination | Basis points | Share of deployment |
| --- | ---: | ---: |
| Gross staking allocation | 800 | 8% |
| Direct admin share of gross staking | (80) | (0.8%) |
| **Net staker SOL rewards** | **720** | **7.2%** |
| Motherlode | 200 | 2% |
| MYNE buyback and burn | 100 | 1% |
| Direct mining admin | 100 | 1% |
| **Total** | **1,200** | **12%** |

The parenthesized staking-admin row is a carve-out of the 800-basis-point gross staking allocation,
not an additional fee. Ten percent of the rounded gross staking allocation is paid directly to the
configured admin wallet; the remainder is indexed for stakers. The direct mining-admin leg is the
exact total fee minus the independently rounded gross-staking, buyback and Motherlode legs, so it
receives the nominal 1% plus any basis-point rounding dust. Consequently every lamport is explicit,
the total charged fee remains exactly `floor(gross * 1,200 / 10,000)`, and total direct admin revenue
is nominally 1.8% of round volume. Admin allocations are transferred at settlement and never require
an admin claim.

At settlement, the 2% Motherlode share moves from the round PDA into the program-owned config PDA
and increments its tracked SOL balance. A funded winning round that hits the Motherlode atomically
moves the full tracked balance—including that round's contribution—back into the round prize for
receipt-based claims. If no tile has a winning deployment, the unawarded 88% prize also rolls into
the same tracked balance instead of becoming operator revenue.

## Launch liquidity gate

Initialization always leaves the protocol paused. On Mainnet, before the admin can unpause it, a
separate `LiquidityGate` PDA must be initialized with the exact official Meteora DAMM v2 or DLMM
pool address and its owner program. The program parses that pool type's exact discriminator and
layout, derives its canonical vault PDAs, verifies MYNE/WSOL orientation and active/enabled state,
and records the declared minimum SOL and MYNE thresholds. This prevents
miners or other users from substituting a competing pool before emissions begin. Devnet's
Switchboard provider mode deliberately bypasses this gate so mining and staking can be tested
without liquidity; the buyback keeper skips swaps until a pool is registered. The `config.paused`
flag remains the single activation latch: one successful unpause starts rounds, mining, staking,
referrals, emissions, and buyback accounting together. Mainnet unpause and settlement re-check
the exact registered pool and vault reserves. The gate accepts neither arbitrary DEX programs nor
an unregistered Meteora pool.
`claim_myne` also respects the pause flag, so an emergency pause cannot leave a token-minting
escape hatch.

## Unclaimed MYNE and referrals

- A MYNE claim charges 10%.
- 9% is redistributed to remaining unclaimed MYNE balances.
- 1% accrues to the claimant's permanent referrer; if no referrer is set, it is minted to
  the configured admin-fee wallet's pre-created canonical ATA in the same transaction. The admin
  never submits a separate claim for this fallback fee.
- Attribution is first-valid and permanent; self-referral and simple cycles are rejected.

The scalable implementation uses a global asset/share pool rather than an additive lazy reward
index. Passive fees add MYNE liability without issuing new shares, so every existing unclaimed
holder compounds pro rata. Later mining/referral credits receive shares at the current exchange
rate and cannot capture earlier fees. A claim burns all of that miner's shares; integer remainder
stays in the pool for the final holder, so sequential exits conserve the exact liability without
iterating every miner. If no eligible holder exists, the 9% is tracked as permanently unissued and
is never inherited by a future miner.

The 10% fee is always charged, including when no referrer is set. This keeps the fee split
deterministic and prevents an unlabelled referral share from silently inflating the passive pool.

## Staking

- Standard stake: 1x reward weight; unstake request enters a 30-day queue.
- Burn stake: token principal is burned permanently for 5x reward weight.
- Rewards are SOL, funded by the net 7.2% remaining from the 8% gross staking allocation after its
  direct 0.8% admin share.
- The Motherlode staking bonus enters a 5x permanent burn-stake position for every participant,
  pro rata by total SOL deployed; the matching Motherlode SOL share remains claimable.

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
8% gross staking (0.8% direct admin and 7.2% net stakers), 2% Motherlode, 1% buyback and burn, and
1% direct admin.

## Randomness and settlement

Recent blockhashes, timestamps and validator-controlled values are not sufficient by themselves.
Every production round records its provider kind and retains a provider-specific public proof.
Historical Switchboard On-Demand rounds remain unchanged: the keeper binds a fresh, uncommitted
request before bids, commits after betting closes and reveals immediately before verified
settlement.

The temporary server commit-reveal provider commits a secret before the first deployment. After
betting closes, anyone can lock a future target slot; settlement reveals the committed preimage and
mixes it with the smallest produced `SlotHashes` entry at or after that target. A missing or aged-out
slot fails closed into the existing refund path. The commitment and output are domain-separated by
the MYNE program, mint and round. The reveal and `RoundSettled` event must occur atomically in the
same transaction.

Every request stores the round/roll identity before randomness exists. Fulfilment is one-shot.
Settlement derives domain-separated values for tile, Split/Solo mode, Solo ticket and Motherlode
hit so one draw is not reused ambiguously.

## Indexing

The frontend performs scoped PDA/account reads for authoritative recent rounds, receipts, balances
and claim eligibility. Structured Anchor events permit a read-only indexer to accelerate long-term
history and charts without becoming a source of truth.

The archive index stores `provider_kind` and keeps provider evidence in distinct fields. A
Switchboard request remains an account address with a plain commit slot. A server commitment is
stored only as 32-byte hex; it is never linked as an Explorer account, and the on-chain high-bit
mode tag is never written into a signed PostgreSQL `bigint`. Server proof version 3 separately
commits the commitment, reveal, target slot, actual entropy slot and hash, output, and the three
event transaction identities. The indexer recomputes both domain-separated hashes and requires the
reveal and settlement transaction to match before attesting the archive. Switchboard archive
snapshots retain their existing version 2 shape and hash.

## Upgrade and operations policy — required before Mainnet

- Upgrade authority owner and custody method.
- Single-developer admin address, offline backup and rotation procedure.
- Pause scope; pause must not block user withdrawals/claims unless strictly necessary.
- Oracle authority and recovery procedure.
- Treasury destinations and whether they are program vaults or multisigs.
- Timelock for economic changes. Launch economics should otherwise be immutable.
