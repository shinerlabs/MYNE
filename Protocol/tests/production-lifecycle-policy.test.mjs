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
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /CONFIRM_SOLANA_GENESIS_HASH/);
    assert.match(source, /getGenesisHash\(\)/);
  }
});

test('Mainnet artifact provenance requires the production feature in the binary', async () => {
  const [build, manifest, preflight, workflow] = await Promise.all([
    readFile(new URL('../scripts/build-mainnet.sh', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/release-artifact-manifest.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/check-mainnet-readiness.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/protocol-safety.yml', import.meta.url), 'utf8'),
  ]);
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
  assert.match(workflow, /cargo check --workspace --all-targets --locked --features production/);
  assert.match(workflow, /cargo test --workspace --locked --features production/);
});
