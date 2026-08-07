# MYNE Mainnet readiness review

**Review date:** 2026-08-07
**Outcome:** version-6 source candidate; public Mainnet activation remains blocked until a fresh
artifact, hash, full test evidence, independent review and live-service gates below are complete.

No Mainnet transaction was authorized or submitted during this review.

The offline Mainnet preflight now requires a committed schema-v2 release manifest with
`buildProfile=production`, the production-only marker inside the SBF, and a clean worktree; a
self-reported hash printed from a default or uncommitted build is not release verification. The
only supported candidate build is `pnpm build:mainnet`. It runs a locked production-feature SBF
build and a separate locked production-feature IDL build to avoid Anchor 1.0.2's combined-build
argument-forwarding bug.

This project-specific marker and manifest establish internal provenance only. They do not satisfy
Solana's Docker-based verified-build process and do not constitute a security audit. The final
public commit must be built with `solana-verify`; that exact executable must be deployed; and its
on-chain hash must be reproduced by `verify-from-repo` from the same full commit and production
feature arguments. The ordered commands and evidence requirements are in
`MAINNET_LAUNCH_RUNBOOK.md`.

## Version-6 source controls requiring fresh verification

The following controls are represented in the version-6 source. They become verified launch
evidence only after the final clean artifact is built, hashed and exercised by the complete suite.

- Immutable version-6 12% mining allocation: 8% gross staking, split into 0.8% direct admin and
  7.2% net staker rewards; 2% Motherlode; 1% buyback/burn; and 1% direct admin. Total direct admin
  revenue is 1.8% before the documented integer-dust assignment.
- Exact cumulative-interval distribution of the full post-fee SOL prize. Integer rounding telescopes, so losing-tile SOL and all rounding units reach the winning-tile miners in proportion to their winning-tile contribution.
- Permissionless processing for accumulated and auto-burn receipts. The receipt PDA fixes the beneficiary and reward mode before the result; keepers cannot redirect SOL or MYNE.
- Per-round `total_receipts`, `processed_receipts` and `closed_receipts` counters. Processed receipts close only after archival, and rent returns to the immutable user beneficiary.
- A round can close only after every receipt is processed and closed, the 1% buyback is complete, and `claimed_lamports` exactly equals the prize plus any Motherlode SOL payout. Round rent returns only to its recorded payer.
- A production event index stores round, receipt, settlement, randomness and buyback transaction evidence. The randomness authority commits a deterministic SHA-256 snapshot on-chain before cleanup.
- The lifecycle keeper uses indexed receipt addresses, batched exact-account reads and measured transactions. It closes Switchboard randomness accounts only after the configured verification window (24 hours by default, never below one hour).
- The buyback keeper is dry-run by default, accepts only a direct Jupiter route through the registered Meteora DLMM pool, simulates swaps/burns, persists crash-recovery state and indexes each swap/burn signature before round archival.
- The web client, round keeper and lifecycle keeper no longer use production-wide program account scans. Indexed addresses are fetched in bounded batches and all identities are revalidated on-chain.
- A guarded script creates the one canonical fallback token account for the admin role after the Mainnet mint exists.
- A guarded atomic mint script simulates first, creates a 9-decimal mint with no freeze authority,
  and mints the entire 100 MYNE genesis supply directly to the exact confirmed liquidity wallet.
- Canonical Metaplex fungible-token metadata is prepared by a simulation-first guarded script. It
  requires the exact 9-decimal/100-MYNE/no-freeze mint state, publishes name and symbol `MYNE`, and
  verifies byte-for-byte hosted artwork plus `myne.supply` and `@myne_solana` links before submission.
- The Mainnet artifact embeds `MYNE_PRODUCTION_ARTIFACT_V1`; its compile-time policy rejects
  default/Devnet randomness and makes every settlement liquidity-gated. The manifest and preflight
  inspect the compiled SBF marker rather than trusting a source grep.
- The zero-byte Agave 3.1.10 syscall metadata was repaired from a version-locked repository file. A clean Anchor SBF build now emits neither the syscall warning nor the earlier stack-overflow warning.
- The operational model uses three distinct continuously funded roles: (1) admin-fee/fallback,
  (2) Switchboard/round/indexer/lifecycle and (3) buyback. The deployer/upgrade/admin key is a
  separate offline authority funded only for reviewed administrative transactions. Temporary-account
  closure and batching provide the savings; revenue and keeper roles are not aliased.
- Canonical PDAs are derived offline and created by their initialization instructions; they are
  never pre-funded. The configured admin-fee wallet is also the no-referrer MYNE fallback owner,
  is supplied through ignored launch configuration, and is intentionally omitted from the curated
  website address list (while remaining publicly discoverable from on-chain state).
- Chat moderation is wallet-scoped. A service-role-only provisioning RPC manages moderator rows,
  but every deletion is authorized again by the Edge Function; the browser role is only a UI hint.

## Superseded verification evidence

The evidence below was produced for the earlier version-5 artifact and is retained only as a
historical baseline. It must not be cited for version 6. Rebuild from a clean tree, synchronize both
IDLs, record a fresh SBF SHA-256 and byte length, and repeat every Rust, Anchor/local-validator,
keeper-policy and frontend test after the final source/dependency freeze.

- `cargo fmt`, `cargo check`, Clippy with warnings denied and 12 Rust tests pass.
- Clean Anchor SBF build passes; generated frontend IDL is synchronized.
- Isolated legacy validator integration passes 14 protocol scenarios, including rejected unauthorized actions, proportional rewards, both permissionless reward modes, refund failure paths, archive-before-close, receipt rent recovery and round closure.
- Six keeper/archive/dependency policy tests and 28 frontend tests pass.
- Frontend production build passes.
- Final reviewed local SBF SHA-256: `6431275770d1ab8e991f97924c2f71d3bc26fc46e4bea26b13f86d4e221019fc` (917,800 bytes).

## Remaining launch gates

1. **Verified production artifact.** Commit the final reviewed source to the public repository,
   run the Docker-based `solana-verify` production build, deploy only that exact executable, compare
   its on-chain hash, complete `verify-from-repo` against the full release commit, upload the
   verification PDA and obtain a successful remote verification job. Store the tool, image,
   feature arguments, hashes, PDA and remote job result with the external release evidence.
2. **Version-6 rehearsal.** Do not treat an older Devnet deployment as evidence for this candidate.
   Rehearse version 6 from fresh state or use only the reviewed paused v5-to-v6 semantic migration
   where the account layout is already compatible.
3. **Production services.** Apply and verify
   `20260807090000_round_index.sql`, `20260807114500_round_fee_audit.sql` and
   `20260807130000_round_archive_verification.sql`, plus
   `20260807131500_keeper_leases.sql`, `20260807133000_referral_read_model_v1.sql`,
   `20260807140000_wallet_chat_hardening.sql`,
   `20260807141000_wallet_validator_lint_cleanup.sql` and
   `20260807142000_chat_admin_provisioning.sql`. Deploy the indexer and all three supervised
   keepers with durable storage, alerts and restricted service-role credentials. Set
   `ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE=1` and set
   `REFERRAL_INDEXER_START_SLOT` to the program deployment slot in production.
4. **Switchboard/Meteora canary.** Exercise uncommitted create/open/bind, deployments carrying the
   bound account, post-close commit plus on-chain commit recording, seed-slot wait, atomic
   reveal/settle, early-commit rejection, missed reveal/refunds, archive/cleanup, delayed
   randomness close, a direct-pool quote, tiny swap and verified burn using the exact production
   configuration.
5. **Independent review.** An unaffiliated Solana/Anchor security reviewer must assess the exact artifact and the scope in `INDEPENDENT_SECURITY_REVIEW_SCOPE.md`. The project team’s own review cannot satisfy this gate.
6. **Legal review.** Paid chance-based mining and token rewards require jurisdiction-specific advice before public funds are accepted.
7. **Canonical mint identity.** Deploy the checked-in token metadata JSON, SVG master and 1024px PNG
   render, run the metadata script in simulation-only mode, then submit with the exact mint-address
   confirmation before transferring SPL mint authority to the config PDA. Read back and record the
   metadata PDA, name, symbol, URI, token standard, update authority and transaction signature.

Switchboard randomness accounts are closed by the implemented lifecycle keeper after the
verification window. Its auxiliary lookup-table rent is a separate residual operational item:
post-cooldown closure needs the ephemeral request signer retained in a production secret manager.
That secret-manager integration must be reviewed before public activation; private request keys
must not be placed in source control or a plain local journal.

Follow `MAINNET_LAUNCH_RUNBOOK.md`. “Deployment candidate” is not a guarantee of safety and is not approval to unpause Mainnet.
