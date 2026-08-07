# MYNE Mainnet readiness review

**Review date:** 2026-08-07
**Outcome:** code-complete deployment candidate; public Mainnet activation remains blocked by the independent review and live-service gates below.

No Mainnet transaction was authorized or submitted during this review.

## Implemented and verified

- Immutable 12% mining allocation: 8% to stakers, 2% to buyback/burn and 2% to the Motherlode.
- Exact cumulative-interval distribution of the full post-fee SOL prize. Integer rounding telescopes, so losing-tile SOL and all rounding units reach the winning-tile miners in proportion to their winning-tile contribution.
- Permissionless processing for accumulated and auto-burn receipts. The receipt PDA fixes the beneficiary and reward mode before the result; keepers cannot redirect SOL or MYNE.
- Per-round `total_receipts`, `processed_receipts` and `closed_receipts` counters. Processed receipts close only after archival, and rent returns to the immutable user beneficiary.
- A round can close only after every receipt is processed and closed, the 2% buyback is complete, and `claimed_lamports` exactly equals the prize plus any Motherlode SOL payout. Round rent returns only to its recorded payer.
- A production event index stores round, receipt, settlement, randomness and buyback transaction evidence. The randomness authority commits a deterministic SHA-256 snapshot on-chain before cleanup.
- The lifecycle keeper uses indexed receipt addresses, batched exact-account reads and measured transactions. It closes Switchboard randomness accounts only after the configured verification window (24 hours by default, never below one hour).
- The buyback keeper is dry-run by default, accepts only a direct Jupiter route through the registered Meteora DLMM pool, simulates swaps/burns, persists crash-recovery state and indexes each swap/burn signature before round archival.
- The web client, round keeper and lifecycle keeper no longer use production-wide program account scans. Indexed addresses are fetched in bounded batches and all identities are revalidated on-chain.
- A guarded script creates the one canonical fallback token account for the admin role after the Mainnet mint exists.
- The zero-byte Agave 3.1.10 syscall metadata was repaired from a version-locked repository file. A clean Anchor SBF build now emits neither the syscall warning nor the earlier stack-overflow warning.
- The operational model remains three funded roles: (1) deployer/upgrade/admin/fallback, (2) Switchboard/round/indexer/lifecycle, and (3) buyback. Temporary-account closure and batching provide the savings; keys are not consolidated further.

## Verification evidence

- `cargo fmt`, `cargo check`, Clippy with warnings denied and 12 Rust tests pass.
- Clean Anchor SBF build passes; generated frontend IDL is synchronized.
- Isolated legacy validator integration passes 14 protocol scenarios, including rejected unauthorized actions, proportional rewards, both permissionless reward modes, refund failure paths, archive-before-close, receipt rent recovery and round closure.
- Six keeper/archive/dependency policy tests and 28 frontend tests pass.
- Frontend production build passes.
- Final reviewed local SBF SHA-256: `6431275770d1ab8e991f97924c2f71d3bc26fc46e4bea26b13f86d4e221019fc` (917,800 bytes).

## Remaining launch gates

1. **Devnet v5 rehearsal.** The current Devnet deployment is version 3, unpaused and configured to a non-Switchboard randomness program. Do not treat it as evidence for this candidate. Pause it and use a reviewed migration, or rehearse version 5 from fresh state, before Mainnet.
2. **Production services.** Apply the round-index migration, deploy the indexer and all three supervised keepers with durable storage, alerts and restricted service-role credentials. Set `ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE=1` in production.
3. **Switchboard/Meteora canary.** Exercise commit/bind/reveal/settle, missed reveal/refunds, archive/cleanup, delayed randomness close, a direct-pool quote, tiny swap and verified burn using the exact production configuration.
4. **Independent review.** An unaffiliated Solana/Anchor security reviewer must assess the exact artifact and the scope in `INDEPENDENT_SECURITY_REVIEW_SCOPE.md`. The project team’s own review cannot satisfy this gate.
5. **Legal review.** Paid chance-based mining and token rewards require jurisdiction-specific advice before public funds are accepted.

Switchboard randomness accounts are closed by the implemented lifecycle keeper after the
verification window. Its auxiliary lookup-table rent is a separate residual operational item:
post-cooldown closure needs the ephemeral request signer retained in a production secret manager.
That secret-manager integration must be reviewed before public activation; private request keys
must not be placed in source control or a plain local journal.

Follow `MAINNET_LAUNCH_RUNBOOK.md`. “Deployment candidate” is not a guarantee of safety and is not approval to unpause Mainnet.
