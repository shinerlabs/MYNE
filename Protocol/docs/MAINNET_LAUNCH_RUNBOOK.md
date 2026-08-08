# Mainnet launch runbook

This is an ordered, controlled launch procedure—not an automatic deployment script. Stop on any mismatch. The read-only artifact preflight is:

```bash
./scripts/check-mainnet-readiness.sh
```

Mainnet must initialize fresh version-6 state. An existing version-5 config may use the reviewed
one-way paused migration, but an older Devnet layout is not a Mainnet migration source.

## 1. Prepare three continuously funded roles and one offline authority

1. **Admin-fee role:** direct SOL-fee receiver, fallback referral-fee owner and reserved Motherlode
   layout address. It receives the direct 1% round
   allocation plus 10% of the gross staking allocation (0.8% of volume), for 1.8% direct admin
   revenue before integer dust.
2. **Randomness role:** Switchboard authority, round rent payer, archive attestor, indexer and lifecycle keeper.
3. **Buyback role:** receives only the 1% allocations, performs the registered-pool swaps and burns, and marks completion.

The deployer remains a fourth, separate offline key for deployment, upgrades and protocol
administration. Fund it only for a reviewed administrative transaction, then return excess SOL to
controlled custody. The three continuously funded role addresses must be distinct, controlled and
verified before initialization; verify the SOL fee receivers are System Program accounts and
pre-create the admin fallback MYNE ATA. Use separate service credentials for Supabase/RPC. They are
not funded Solana roles and must never enter the repository.

Keep the operational mapping in an ignored local environment file. Set
`MAINNET_ADMIN_FEE_WALLET` to the reviewed fee recipient; the protocol intentionally uses that
same address as the no-referrer MYNE fallback owner. If
`MAINNET_REFERRAL_FALLBACK_WALLET` is supplied, the derivation script requires the values to match.
Run `pnpm addresses:mainnet` to derive the deterministic accounts before initialization.

Never send SOL directly to a derived PDA before its initialization transaction. A PDA has no
private key and cannot sign; pre-funding can create an account at the derived address and prevent
Anchor's `init` constraint from creating the intended program-owned account. Fund only the
reviewed transaction-payer signer, set it as `MAINNET_TRANSACTION_PAYER` for the derivation report,
and let `initialize_protocol` pay the PDA rent atomically.

## 2. Freeze and independently review the artifact

Start from a clean tree and run the complete default and `--features production` Rust/keeper suites.
Build the only eligible internal candidate with `pnpm build:mainnet`; do not use the default
`anchor build` output. This local candidate is preflight evidence and must not itself be deployed
even if the subsequent Docker verification build reproduces its hash; deploy only the Docker
output.
That release-build path invokes locked production-feature SBF and IDL builds, verifies the
`MYNE_PRODUCTION_ARTIFACT_V1` marker inside the binary, and synchronizes both IDLs. Then print the release
manifest with `pnpm release:manifest -- --print`, review it, and store it in signed/read-only release
evidence outside the Git worktree (putting the current commit inside a committed manifest would be
self-referential). Set `MAINNET_RELEASE_MANIFEST` to that frozen external file and rerun
`./scripts/check-mainnet-readiness.sh`; it fails if the Git commit, SBF/IDL/lockfile hashes, byte
length, toolchain, `buildProfile=production`, binary marker, or clean-worktree requirement differs.
Then stop rebuilding. Confirm the IDL contains the version-6
migration, `RoundFeesDistributed`, and the direct admin settlement account. Do not reuse any
version-5 artifact, hash or test report. Give the exact source and artifact to an unaffiliated Solana
reviewer using `INDEPENDENT_SECURITY_REVIEW_SCOPE.md`. Resolve every critical/high finding and
repeat the entire Rust, Anchor/local-validator, keeper-policy and frontend suite after any change.

The marker, manifest and local hash above are internal provenance evidence only. They are neither a
Solana verified build nor an independent security audit. After the final reviewed source is
committed and publicly reachable, perform the official deterministic-build sequence from the
`Protocol/` workspace using a recorded, pinned `solana-verify` version and Docker:

```bash
# Run these two commands from Protocol/. Build the production feature in Docker.
solana-verify build --library-name myne_protocol -- --features production
solana-verify get-executable-hash target/deploy/myne_protocol.so

# Deploy this exact file. Do not run anchor build, cargo build-sbf or build:mainnet afterward.
solana program deploy -u <MAINNET_RPC_URL> target/deploy/myne_protocol.so \
  --program-id D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e

# Compare the on-chain executable with the artifact just deployed.
solana-verify get-program-hash -u <MAINNET_RPC_URL> \
  D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e

# Reproduce it from the exact public commit and upload the verification record when prompted.
solana-verify verify-from-repo -u <MAINNET_RPC_URL> \
  --program-id D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e \
  https://github.com/shinerlabs/MYNE \
  --commit-hash <FULL_RELEASE_COMMIT_SHA> \
  --library-name myne_protocol --mount-path Protocol -- --features production

# After the verification PDA is uploaded, request independent remote reproduction.
solana-verify remote submit-job \
  --program-id D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e \
  --uploader <UPGRADE_AUTHORITY_ADDRESS>
```

Record the CLI version, Docker image/digest, full commit, feature arguments, executable hash,
on-chain hash, verification PDA, remote job ID and successful remote-verification result in
immutable release evidence. A local `verify-from-repo` match alone is not the final public
Explorer-status gate. If the
Docker-built executable differs from the locally manifested candidate, stop: update the external
manifest to the exact verified artifact, rerun all artifact checks against it, and repeat the
independent review as required. Never deploy a locally rebuilt substitute. The current Solana
procedure is maintained at <https://solana.com/docs/programs/verified-builds>; rehearse the exact
CLI version and command syntax before funding a Mainnet deployment.

## 3. Deploy while inactive

Deploy or upgrade to the recorded Docker-verified version-6 `.so` at the fixed program ID. Verify
ProgramData, upgrade authority and deployed bytecode hash. Keep the existing pre-launch protocol
paused. Create a fresh legacy SPL mint with 9 decimals, the reviewed admin temporarily acting as
mint authority and no freeze authority. Mint exactly 100 MYNE to the configured admin-fee/liquidity
wallet. Do not transfer mint authority yet: the Metaplex metadata instruction must be signed by the
current mint authority.

Generate the mint keypair outside the repository and record its public address. Run the guarded
atomic mint preparation first without `SUBMIT_MAINNET_MINT`; it verifies the Mainnet genesis hash,
simulates creation of the mint and destination ATA, and mints the entire genesis supply directly to
the reviewed liquidity wallet. Only repeat with `SUBMIT_MAINNET_MINT` equal to the exact mint
address after reviewing every printed address:

```bash
MAINNET_RPC_URL=<reviewed Mainnet RPC> \
ANCHOR_WALLET=<reviewed deployer keypair path> \
MYNE_MINT_KEYPAIR=<offline mint keypair path> \
MAINNET_LIQUIDITY_WALLET=<reviewed launch wallet> \
CONFIRM_SOLANA_GENESIS_HASH=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d \
CONFIRM_CREATE_MYNE_MINT=<reviewed mint address> \
CONFIRM_LIQUIDITY_DESTINATION=<reviewed launch wallet> \
pnpm prepare:mainnet-mint
```

Publish and independently fetch these exact release assets before creating metadata:

```text
https://www.myne.supply/token-metadata.json
https://www.myne.supply/myne-token-icon-1024.png
https://www.myne.supply/myne-token-icon.svg
```

The SVG is the authoritative artwork; the 1024×1024 PNG is its exact wallet-compatible render. The
JSON fixes the on-chain identity to name `MYNE`, symbol `MYNE`, zero seller fee, website
`https://www.myne.supply` and X account `https://x.com/myne_solana`. Run the guarded metadata
preparation from `Protocol/` first without the submit variable; it verifies Mainnet genesis, the
mint's 9 decimals/100 MYNE supply/no-freeze state, byte-for-byte hosted artwork, and simulates the
locally constructed Metaplex transaction:

```bash
MAINNET_RPC_URL=<reviewed Mainnet RPC> \
ANCHOR_WALLET=<reviewed file-backed admin keypair path> \
MYNE_MINT_ADDRESS=<reviewed mint> \
CONFIRM_SOLANA_GENESIS_HASH=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d \
CONFIRM_MAINNET_TOKEN_METADATA=<reviewed mint> \
pnpm prepare:mainnet-metadata
```

Review the simulation and derived metadata PDA. Only then repeat with
`SUBMIT_MAINNET_TOKEN_METADATA=<reviewed mint>`. Read the metadata account back and verify name,
symbol, URI, update authority and `TokenStandard::Fungible`. Metadata update authority is distinct
from SPL mint authority; retain it only until all permanent URLs are independently verified, then
make a separate documented immutability decision.

For the existing abandoned pre-launch configuration, do not initialize a second config. Instead,
run the guarded one-time migration first without `SUBMIT_MAINNET_MINT_MIGRATION`. It rechecks the
canonical Metaplex PDA, name `MYNE`, symbol `MYNE`, URI, fungible token standard and zero seller fee;
proves mining and staking are unused; verifies all 100 MYNE are in the configured admin-fee wallet;
and simulates one atomic transaction that transfers the new mint authority to the config PDA,
revokes the old mint authority and records the old/new pair:

```bash
MAINNET_RPC_URL=<reviewed Mainnet RPC> \
ANCHOR_WALLET=<reviewed protocol-admin keypair path> \
MAINNET_MINT_ADDRESS=<reviewed fresh mint> \
MAINNET_LIQUIDITY_WALLET=<configured admin-fee/liquidity wallet> \
CONFIRM_SOLANA_GENESIS_HASH=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d \
CONFIRM_MAINNET_CONFIG=<printed config PDA> \
CONFIRM_PRELAUNCH_MINT_MIGRATION=<printed migration PDA> \
CONFIRM_DEPRECATE_PREVIOUS_MINT=2NtsuCtsXCU1f5dwGcNPyBLnKx5tRHsCFfUt6py3dwWS \
CONFIRM_MAINNET_MINT=<reviewed fresh mint> \
CONFIRM_LIQUIDITY_DESTINATION=<configured admin-fee/liquidity wallet> \
pnpm migrate:mainnet-mint
```

Review the entire simulation and only then repeat with
`SUBMIT_MAINNET_MINT_MIGRATION=<reviewed fresh mint>`. Fetch both mints, the migration PDA and config
back. Verify the retired mint authority is `None`, the new mint authority/config mint are the config
PDA, the supply remains exactly 100 MYNE, the protocol remains paused, and the old CA is publicly
labelled deprecated rather than hidden. This read-back is a hard stop: the production-feature
binary accepts only the reviewed Switchboard Mainnet and server commit-reveal modes, and always
enforces the production liquidity gate.
Production keepers independently refuse a cluster/provider mismatch, and the administrator must
still refuse to proceed on any disagreement.

Run `pnpm prepare:admin-ata` with both the program-ID confirmation and
`CONFIRM_SOLANA_GENESIS_HASH=<mainnet-genesis-hash>` after the mint/config exist. Verify that this
creates exactly the canonical MYNE associated token account owned by the admin fallback role.

## 4. Start the production index before protocol activity

Apply and verify all production migrations in order:

```text
supabase/migrations/20260807090000_round_index.sql
supabase/migrations/20260807114500_round_fee_audit.sql
supabase/migrations/20260807130000_round_archive_verification.sql
supabase/migrations/20260807131500_keeper_leases.sql
supabase/migrations/20260807133000_referral_read_model_v1.sql
supabase/migrations/20260807140000_wallet_chat_hardening.sql
supabase/migrations/20260807141000_wallet_validator_lint_cleanup.sql
supabase/migrations/20260807142000_chat_admin_provisioning.sql
supabase/migrations/20260808090000_server_randomness_proofs.sql
supabase/migrations/20260808113000_burn_stats.sql
supabase/migrations/20260808120000_receipt_reward_accrual.sql
supabase/migrations/20260808123000_empty_round_stats.sql
supabase/migrations/20260808124500_keeper_lease_privileges.sql
supabase/migrations/20260808130000_round_realtime.sql
```

The final three migrations are part of the same release as the upgraded program
and indexer. `receipt_reward_accrual` distinguishes historical direct wallet
payments from rewards safely processed into the owner claim vault. The
`empty_round_stats` migration keeps every settled zero-bid winning tile in the
public ledger while excluding it from mined and Motherlode award totals. Do
not deploy the upgraded workers or frontend until all three migrations are present
and the PostgREST schema cache exposes their updated status/view contracts.
`keeper_lease_privileges` ensures only the service role can fence production
workers; the Supabase security advisor must report no public execution access.

Before deploying the frontend, query `public.mine_burn_stats` as the anonymous
role and require exactly one row with an integer
`completed_buyback_burn_base_units_text`. A missing view, denied read, multiple
rows, or malformed value is a release blocker; the browser deliberately leaves
the burned totals unavailable in all of those cases.

The wallet-chat cut-over invalidates old sessions and removes guest/null rows. After the final
migration, run `pnpm chat:admin` in dry-run mode with `CHAT_ADMIN_WALLET` set from the ignored
operational file. Apply only with `APPLY_CHAT_ADMIN=1`, the exact
`CONFIRM_CHAT_ADMIN_WALLET`, and server-only Supabase service-role credentials. The wallet address
must not be hardcoded in a migration or browser bundle. Sign a fresh wallet session afterward and
prove that the delete control appears only for the moderator while `chat-delete` still rejects a
non-admin wallet server-side.

Run the event indexer from a recorded start slot with finalized reads and service-role credentials.
Before activation, prove that a synthetic `RoundFeesDistributed` event persists every allocation
field. Confirm `archive_verified` remains false for an observed archive event until the canonical
snapshot exists and its hash matches the on-chain `Round.archive_hash`; only then may the lifecycle
keeper close receipts. For server commit-reveal, also prove the provider kind, commitment, reveal,
unflagged target slot, actual entropy slot/hash and all event transaction identities are present;
the archived reveal signature must be the settlement signature. Never place the tagged on-chain
u64 in `randomness_commit_slot` or expose commitment bytes as an Explorer account. Run the lifecycle
keeper with the same randomness role. Set:

```text
ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE=1
REFERRAL_INDEXER_START_SLOT=<program deployment slot>
RANDOMNESS_RETENTION_SECONDS=86400
```

The referral v1 cursor is intentionally independent from the existing round cursor. Keep its start
slot at or before the first `MinerRegistered` event so the finalized-log backfill can prove every
permanent attribution before it projects any legacy `MyneClaimed` credit.

Supervise all indexer/keeper processes with durable logs, restart policy and alerts. Confirm no production `getProgramAccounts` scan is made.
The live buyback keeper also requires the service-role-only database lease from the final migration;
its 10-minute default fence prevents overlapping replicas from spending the same allocation. Keep
its journal on one durable, backed-up volume and never bypass the lease during an unresolved swap.
The reviewed managed-host layout, standby checks, secret boundaries, one-replica rule and incident
procedure are defined in `WORKER_HOSTING.md`. Deploy and prove that service in standby while the
protocol is paused; do not use a laptop or browser tab as the production supervisor.

Switchboard also creates an auxiliary lookup table for each randomness request. `closeIx()` closes
the randomness account after the verification window, but later LUT rent recovery requires the
ephemeral request signer after Solana's lookup-table cooldown. Retain those ephemeral signers only
in the production secret manager and add a separately reviewed post-cooldown `closeLutIx()`
operation; never
write their private keys to the repository or an ordinary keeper journal.

## 5. Create and register the selected official Meteora pool

Create either a MYNE/WSOL DAMM v2 pool or a MYNE/WSOL DLMM pool through Meteora. Independently
verify the exact official owner program, pool address, discriminator/layout, both vault PDAs, mint
order, activation state and reserve thresholds. Register that exact gate while paused. The gate is
immutable for this initialization and is checked again at every settlement. “Any Meteora pool”
means either supported official pool type supplied for review; it never means an arbitrary program
or an unverified pool address.

Run `pnpm mainnet:register-liquidity` first without `SUBMIT_MAINNET_LIQUIDITY_GATE`. The guarded
script detects the exact official owner, decodes either the 1,112-byte DAMM v2 Pool or 904-byte DLMM
LbPair directly on-chain, derives both vault accounts,
verifies the MYNE/WSOL mint order and reserve balances, simulates the transaction and prints the
exact submission confirmation. Repeat only after independently reviewing every printed address and
threshold.

## 6. Rehearse randomness and buyback while paused/controlled

Run the exact Switchboard sequence with measured compute: atomically create/open/bind a fresh
uncommitted request; submit manual and Auto-round deployments with that bound account; wait for
betting to close; atomically commit and call `record_round_randomness_commit`; wait for the seed
slot; then atomically reveal and call `settle_round_verified`. Confirm early commit, missing/wrong
deployment randomness account, wrong owner/binding, stale commit, stale reveal, duplicate
settlement and missed-reveal paths fail safely. Run the buyback keeper in dry-run mode, then
authorize one tiny direct-pool canary. Verify swap and burn signatures appear in
`mine_buyback_executions`.

## 7. Activate once and observe one complete round

Only after all gates pass, run `pnpm mainnet:activate` without its submission flag. The activation
script repeats the exact DAMM v2/DLMM pool and vault checks, simulates `set_paused(false)`, and requires exact
acknowledgements for production service health and the independent security review. Repeat with the
printed `SUBMIT_MAINNET_ACTIVATE` value only when those statements are true. Save the config
snapshot and activation signature. Observe one complete low-volume round through:

1. receipt creation;
2. Switchboard settlement;
3. permissionless accumulated and auto-burn reward processing;
4. exact fee evidence: 8% gross staking split into 0.8% direct admin and 7.2% net stakers, 2%
   Motherlode, 1% swap/burn and 1% direct admin, with the complete 12% conserved;
5. deterministic archive commitment;
6. receipt closure with rent returned to users;
7. round closure with rent returned to the randomness role;
8. delayed Switchboard randomness closure.

If any counter, payout invariant, archive hash or evidence total disagrees, pause and investigate. Do not advertise until this sequence and the independent review are signed off.
