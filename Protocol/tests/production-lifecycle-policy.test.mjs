import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('receipt and randomness cleanup require a verified canonical archive', async () => {
  const lifecycle = await readFile(
    new URL('../scripts/round-lifecycle-keeper.mjs', import.meta.url),
    'utf8',
  );
  assert.match(lifecycle, /indexedRound\.archive_verified === true/);
  assert.match(lifecycle, /archive_verified=eq\.true/);
  assert.match(lifecycle, /program\.methods\.closeReceipt/);
  assert.match(lifecycle, /program\.methods\.closeRound/);
  assert.match(lifecycle, /receipts\.length <= chainReceiptCount/);
  assert.match(lifecycle, /state: 'awaiting-indexed-receipts'/);
  assert.match(lifecycle, /Indexed receipt count exceeds the authoritative chain count/);
});

test('indexer compares canonical history to the on-chain archive attestation', async () => {
  const indexer = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  assert.match(indexer, /Buffer\.from\(attestedState\.archiveHash\)\.toString\('hex'\)/);
  assert.match(indexer, /archive_verified: true/);
  assert.match(indexer, /Mainnet indexer requires ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE=1/);
  assert.match(indexer, /createHash\('sha256'\)/);
  assert.doesNotMatch(indexer, /INDEXER_ID = `\$\{PROGRAM_ID\.toBase58\(\)\}:\$\{provider\.connection\.rpcEndpoint\}`/);
});

test('database distinguishes observed and verified archive hashes', async () => {
  const migration = await readFile(
    new URL('../../supabase/migrations/20260807130000_round_archive_verification.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /archive_verified boolean not null default false/);
  assert.match(migration, /mine_rounds_archive_verification_queue_idx/);
});

test('buyback inspects the serialized swap transaction before signing', async () => {
  const keeper = await readFile(new URL('../scripts/buyback-keeper.mjs', import.meta.url), 'utf8');
  assert.match(keeper, /numRequiredSignatures/);
  assert.match(keeper, /TransactionMessage\.decompile/);
  assert.match(keeper, /allowedPrograms/);
  assert.match(keeper, /MAX_SWAP_OVERHEAD_LAMPORTS/);
  assert.match(keeper, /minimumOutputBaseUnits/);
  assert.match(keeper, /pending-swap-status-ambiguous-manual-reconciliation-required/);
  assert.match(keeper, /CONFIRM_ABANDONED_BUYBACK/);
  assert.match(keeper, /acquire_mine_keeper_lease/);
  assert.match(keeper, /buyback-lease-held-by-another-instance/);
});

test('buyback singleton fencing is atomic and service-role only', async () => {
  const migration = await readFile(
    new URL('../../supabase/migrations/20260807131500_keeper_leases.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /on conflict \(lease_name\) do update/);
  assert.match(migration, /mine_keeper_leases\.expires_at <= now\(\)/);
  assert.match(migration, /revoke all on function .* from public/);
  assert.match(migration, /grant execute .* to service_role/);
});

test('administrative transaction scripts require an exact RPC genesis acknowledgement', async () => {
  for (const relative of [
    '../scripts/prepare-admin-fallback-ata.mjs',
    '../scripts/migrate-fee-schedule-v6.mjs',
    '../scripts/create-mainnet-mint.mjs',
    '../scripts/create-mainnet-token-metadata.mjs',
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /CONFIRM_SOLANA_GENESIS_HASH/);
    assert.match(source, /getGenesisHash\(\)/);
  }
});

test('MYNE metadata creation is fixed, hosted, simulated, and explicitly submitted', async () => {
  const source = await readFile(
    new URL('../scripts/create-mainnet-token-metadata.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /const TOKEN_NAME = 'MYNE'/);
  assert.match(source, /const TOKEN_SYMBOL = 'MYNE'/);
  assert.match(source, /https:\/\/www\.myne\.supply\/token-metadata\.json/);
  assert.match(source, /https:\/\/x\.com\/myne_solana/);
  assert.match(source, /TokenStandard\.Fungible/);
  assert.match(source, /sellerFeeBasisPoints: percentAmount\(0\)/);
  assert.match(source, /accountExists\(metadataPda\[0\]/);
  assert.match(source, /getLatestBlockhash\(\{ commitment: 'finalized' \}\)/);
  assert.match(source, /fetchMetadataFromSeeds[\s\S]*commitment: 'finalized'/);
  assert.match(source, /confirmTransaction[\s\S]*commitment: 'finalized'/);
  assert.match(source, /simulateTransaction/);
  assert.match(source, /SUBMIT_MAINNET_TOKEN_METADATA !== mintAddress/);
});

test('MYNE genesis mint is atomic, simulation-first, and exact-address guarded', async () => {
  const source = await readFile(
    new URL('../scripts/create-mainnet-mint.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /GENESIS_BASE_UNITS = 100_000_000_000n/);
  assert.match(source, /createInitializeMint2Instruction\([\s\S]*null,[\s\S]*TOKEN_PROGRAM_ID/);
  assert.match(source, /createAssociatedTokenAccountIdempotentInstruction/);
  assert.match(source, /createMintToCheckedInstruction/);
  assert.match(source, /CONFIRM_CREATE_MYNE_MINT/);
  assert.match(source, /CONFIRM_LIQUIDITY_DESTINATION/);
  assert.match(source, /SUBMIT_MAINNET_MINT/);
  assert.match(source, /simulateTransaction/);
  assert.match(source, /getGenesisHash/);
});

test('Mainnet initialization is atomic, paused, and exact-address guarded', async () => {
  const source = await readFile(
    new URL('../scripts/mainnet-initialize.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /createSetAuthorityInstruction/);
  assert.match(source, /initializeProtocol/);
  assert.match(source, /SWITCHBOARD_MAINNET_PROGRAM/);
  assert.match(source, /getGenesisHash\(\)/);
  assert.match(source, /simulateTransaction/);
  assert.match(source, /SUBMIT_MAINNET_INITIALIZE !== config\.toBase58\(\)/);
  assert.match(source, /confirmTransaction[\s\S]*'finalized'/);
  assert.match(source, /waitForInitialized/);
  assert.match(source, /state\.paused, true/);
  assert.match(source, /mintState\.mintAuthority\?\.equals\(config\)/);
});

test('Mainnet liquidity registration decodes Meteora and is simulation-first', async () => {
  const [policy, register, activate] = await Promise.all([
    readFile(new URL('../scripts/mainnet-liquidity-policy.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/mainnet-register-liquidity-gate.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/mainnet-activate.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(policy, /LB_PAIR_ACCOUNT_LEN = 904/);
  assert.match(policy, /LB_PAIR_DISCRIMINATOR/);
  assert.match(policy, /DAMM_V2_POOL_ACCOUNT_LEN = 1_112/);
  assert.match(policy, /METEORA_DAMM_V2_PROGRAM/);
  assert.match(policy, /decodeMeteoraDammV2Pool/);
  assert.match(policy, /reserveX/);
  assert.match(policy, /reserveY/);
  assert.match(register, /inspectMeteoraPool/);
  assert.match(register, /poolState\.poolProgram/);
  assert.match(register, /CONFIRM_METEORA_MYNE_VAULT/);
  assert.match(register, /CONFIRM_METEORA_SOL_VAULT/);
  assert.match(register, /simulateTransaction/);
  assert.match(register, /SUBMIT_MAINNET_LIQUIDITY_GATE/);
  assert.match(register, /confirmTransaction[\s\S]*'finalized'/);
  assert.match(activate, /CONFIRM_PRODUCTION_SERVICES_READY/);
  assert.match(activate, /CONFIRM_INDEPENDENT_SECURITY_REVIEW/);
  assert.match(activate, /simulateTransaction/);
  assert.match(activate, /SUBMIT_MAINNET_ACTIVATE/);
  assert.match(activate, /baseVault: poolState\.myneVault/);
  assert.match(activate, /quoteVault: poolState\.solVault/);
  assert.match(activate, /activeConfig\.paused, false/);
});

test('pre-launch mint recovery is single-use, metadata-gated and simulation-first', async () => {
  const [program, migration] = await Promise.all([
    readFile(new URL('../programs/myne_protocol/src/lib.rs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/migrate-mainnet-prelaunch-mint.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(program, /LEGACY_PRELAUNCH_MINT/);
  assert.match(program, /pub fn migrate_prelaunch_mint/);
  assert.match(program, /PrelaunchStateNotEmpty/);
  assert.match(program, /previous_mint\.reload\(\)/);
  assert.match(program, /PrelaunchMintMigrated/);
  assert.match(migration, /CONFIRM_DEPRECATE_PREVIOUS_MINT/);
  assert.match(migration, /fetchMetadataFromSeeds/);
  assert.match(migration, /TokenStandard\.Fungible/);
  assert.match(migration, /createSetAuthorityInstruction/);
  assert.match(migration, /simulateTransaction/);
  assert.match(migration, /SUBMIT_MAINNET_MINT_MIGRATION !== newMint\.toBase58\(\)/);
  assert.match(migration, /retiredMint\.mintAuthority, null/);
});

test('Mainnet deployer refund preserves the reviewed transaction-fee reserve', async () => {
  const source = await readFile(
    new URL('../scripts/refund-mainnet-deployer.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /EXPECTED_DEPLOYER/);
  assert.match(source, /DEFAULT_RESERVE_LAMPORTS = 50_000_000n/);
  assert.match(source, /getFeeForMessage/);
  assert.match(source, /simulateTransaction/);
  assert.match(source, /SUBMIT_MAINNET_REFUND/);
  assert.match(source, /confirmTransaction[\s\S]*'finalized'/);
  assert.match(source, /sourceAfter[\s\S]*reserveLamports/);
  assert.match(source, /destinationAfter[\s\S]*transferLamports/);
});

test('Mainnet artifact provenance requires the production feature in the binary', async () => {
  const [workspace, build, manifest, preflight, workflow] = await Promise.all([
    readFile(new URL('../Cargo.toml', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build-mainnet.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/release-artifact-manifest.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/check-mainnet-readiness.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/protocol-safety.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(workspace, /\[workspace\.metadata\.cli\][\s\S]*solana = "3\.1\.10"/);
  assert.match(build, /anchor build --no-idl -- --features production -- --locked/);
  assert.match(build, /anchor idl build -o target\/idl\/myne_protocol\.json -- --locked --features production/);
  assert.ok(
    build.indexOf('anchor idl build') < build.indexOf('anchor build --no-idl'),
    'the production SBF must be the final build product after IDL generation',
  );
  assert.match(build, /MYNE_PRODUCTION_ARTIFACT_V1/);
  assert.match(build, /MYNE_REHEARSAL_ARTIFACT_V1/);
  assert.match(build, /rotate_operational_wallets/);
  assert.match(manifest, /buildProfile: 'production'/);
  assert.match(manifest, /sbf\.includes\(Buffer\.from\(PRODUCTION_ARTIFACT_MARKER\)\)/);
  assert.match(manifest, /!sbf\.includes\(Buffer\.from\(REHEARSAL_ARTIFACT_MARKER\)\)/);
  assert.match(preflight, /grep -aFq 'MYNE_PRODUCTION_ARTIFACT_V1' target\/deploy\/myne_protocol\.so/);
  assert.match(preflight, /rotate_operational_wallets/);
  assert.match(preflight, /ClaimFeeRoutedV2/);
  assert.match(preflight, /SERVICE_ROLE_KEY[\s\S]*\{20,/);
  assert.match(workflow, /cargo check --workspace --all-targets --locked --features production/);
  assert.match(workflow, /cargo test --workspace --locked --features production/);
});
