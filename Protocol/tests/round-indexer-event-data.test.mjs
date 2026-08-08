import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeAnchorEventData,
  normalizeAnchorEventName,
} from '../scripts/anchor-event-data.mjs';

test('normalizes Anchor 1.0 snake_case event fields at the index boundary', () => {
  const decoded = normalizeAnchorEventData({
    round_id: 206n,
    rent_payer: 'payer',
    betting_ends_at: 123n,
    randomness_account: 'randomness',
  });
  assert.equal(decoded.roundId, 206n);
  assert.equal(decoded.rentPayer, 'payer');
  assert.equal(decoded.bettingEndsAt, 123n);
  assert.equal(decoded.randomnessAccount, 'randomness');
  assert.equal(decoded.round_id, 206n);
});

test('normalizes Program coder lower-camel event names to projection names', () => {
  assert.equal(normalizeAnchorEventName('roundOpened'), 'RoundOpened');
  assert.equal(normalizeAnchorEventName('claimFeeRoutedV2'), 'ClaimFeeRoutedV2');
  assert.equal(normalizeAnchorEventName('RoundSettled'), 'RoundSettled');
});

test('production indexer replays finalized signatures without moving the cursor', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  assert.match(source, /--replay-signature=/);
  assert.match(source, /processEvent\(event, signature, transaction\.slot, \{ canonicalReplay: true \}\)/);
  const replayBody = source.slice(
    source.indexOf('async function replayTransactions'),
    source.indexOf('async function signaturesSince'),
  );
  assert.doesNotMatch(replayBody, /mine_indexer_state|newest_signature/);
});

test('production indexer acquires an atomic lease before each tick', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  assert.match(source, /acquire_mine_keeper_lease/);
  assert.match(source, /round-indexer-lease-held-by-another-instance/);
  assert.match(source, /if \(!\(await acquireIndexerLease\(\)\)\)/);
});

test('historical gap watermarks can never be adopted as transaction cursors', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const adoption = source.slice(
    source.indexOf('async function state'),
    source.indexOf('async function registeredReferrer'),
  );
  assert.match(adoption, /!candidateId\.includes\(':historical-gaps:'\)/);
});

test('production indexer refuses a partially migrated round projection schema', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  assert.match(source, /async function requireIndexerSchema/);
  assert.match(source, /mine_worker_schema_capabilities\?select=release&release=eq\.round-projection-v2/);
  assert.match(source, /await requireIndexerSchema\(\)/);
  assert.match(source, /20260808134500_round_projection_completeness\.sql/);
});

test('recent and stale Round PDAs rebuild complete canonical history before cursor advancement', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const reconciliation = source.slice(
    source.indexOf('async function canonicalRoundSignatures'),
    source.indexOf('async function archiveReadyRounds'),
  );
  assert.match(reconciliation, /resolved=eq\.false/);
  assert.match(reconciliation, /settles_at=lte\.\$\{chainNow\}/);
  assert.match(reconciliation, /limit=32/);
  assert.match(reconciliation, /recentScheduledRoundIds\(currentRoundId, reconcileDepth\)/);
  assert.match(reconciliation, /historicalGapPlan\(currentRoundId\)/);
  assert.match(reconciliation, /advanceHistoricalGapCursor\(gapPlan\.next\)/);
  assert.match(reconciliation, /program\.account\.round\.fetchMultiple\(addresses\)/);
  assert.match(reconciliation, /getSignaturesForAddress\(address/);
  assert.match(reconciliation, /canonicalSignatureOrder\(gathered\)/);
  assert.match(reconciliation, /for \(const event of roundEvents\)[\s\S]*processEvent\(event, row\.signature, transaction\.slot, \{ canonicalReplay: true \}\)/);
  assert.match(reconciliation, /roundNeedsCanonicalReplay/);
  assert.match(reconciliation, /mine_round_projection_digest/);
  assert.match(reconciliation, /roundProjectionMatchesChain/);
  assert.match(reconciliation, /projection_complete/);
  assert.match(reconciliation, /chainRoundProjection\(roundId, state/);
  assert.match(reconciliation, /changedRoundProjection/);
  assert.match(source, /reconcileCanonicalRounds\(\);[\s\S]*const indexed = await indexTransactions\(\)/);
  assert.match(source, /indexed, reconciled, reconciliationFailures, archived, referralsIndexed, projectOnly/);
  assert.doesNotMatch(reconciliation, /getProgramAccounts|program\.account\.[A-Za-z]+\.all\s*\(/);
});

test('participant digest migration checks every tile without a PostgREST row cap', async () => {
  const migration = await readFile(
    new URL('../../supabase/migrations/20260808134500_round_projection_completeness.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /add column if not exists projection_complete boolean not null default false/);
  assert.match(migration, /add column if not exists projection_version smallint not null default 2/);
  assert.match(migration, /add column if not exists source_slot bigint/);
  assert.match(migration, /mine_round_projection_digest\(p_round_ids bigint\[\]\)/);
  assert.match(migration, /generate_series\(0, 24\)/);
  assert.match(migration, /sum\(b\.amount_wei\)/);
  assert.match(migration, /count\(distinct b\.receipt\)/);
  assert.match(migration, /enforce_mine_round_source_slot_monotonic/);
  assert.match(migration, /new\.source_slot < old\.source_slot/);
  assert.match(migration, /before update of source_slot/);
  assert.match(migration, /'round-projection-v2'/);
});

test('projection reconciliation does not impose a participant row ceiling', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const reconciliation = source.slice(
    source.indexOf('async function fetchProjectionDigests'),
    source.indexOf('async function archiveReadyRounds'),
  );
  assert.doesNotMatch(reconciliation, /mine_round_bets\?round_id=in/);
  assert.doesNotMatch(reconciliation, /maxPages:\s*16|16_000/);
  assert.match(source, /restImmutableRoundRows/);
});

test('projection-only mode keeps history live without reaching signer transactions', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  assert.match(source, /ROUND_INDEXER_PROJECT_ONLY/);
  assert.match(source, /const archived = projectOnly \? 0 : await archiveReadyRounds\(\)/);
  assert.match(source, /indexed, reconciled, reconciliationFailures, archived, referralsIndexed, projectOnly/);
});

test('observing RoundArchived never downgrades canonical archive verification', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const archivedCase = source.slice(
    source.indexOf("case 'RoundArchived'"),
    source.indexOf("case 'RoundClosed'"),
  );
  assert.match(archivedCase, /archive_hash:/);
  assert.doesNotMatch(archivedCase, /archive_verified:\s*false/);
});

test('DeploymentCreated only writes columns present in the immutable bet ledger', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const deploymentCase = source.slice(
    source.indexOf("case 'DeploymentCreated'"),
    source.indexOf("case 'AutoPlanConfigured'"),
  );
  assert.doesNotMatch(deploymentCase, /rent_payer|data\.rentPayer/);
  assert.ok(
    deploymentCase.indexOf('projection_complete=eq.true')
      < deploymentCase.indexOf("upsert('mine_round_bets'"),
    'projection health must be withdrawn before new participant rows are written',
  );
});

test('receipt settlement status is derived from the normalized Anchor event name', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const receiptCases = source.slice(
    source.indexOf("case 'ReceiptClaimed'"),
    source.indexOf("case 'BuybackCompleted'"),
  );
  assert.match(source, /const eventName = normalizeAnchorEventName\(event\.name\)/);
  assert.match(receiptCases, /case 'ReceiptRewardAccruedV1'/);
  assert.match(receiptCases, /eventName === 'ReceiptRewardAccruedV1'[\s\S]*'accrued'/);
  assert.match(receiptCases, /eventName === 'ReceiptClaimed'[\s\S]*'claimed'/);
  assert.match(receiptCases, /eventName === 'ReceiptRefunded'/);
  assert.match(receiptCases, /eventName === 'ReceiptClosed'/);
  assert.match(receiptCases, /fetchProjectionDigests\(\[BigInt\(roundId\)\]\)/);
  assert.match(receiptCases, /digest\.indexed_processed_receipts/);
  assert.match(receiptCases, /digest\.indexed_closed_receipts/);
  assert.doesNotMatch(receiptCases, /mine_receipt_settlements\?.*select=receipt/);
  assert.doesNotMatch(receiptCases, /event\.name ===/);
});

test('ensuring a round is insert-only and cannot churn updated_at on replay', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const ensure = source.slice(
    source.indexOf('async function ensureRound'),
    source.indexOf('async function sendMeasured'),
  );
  assert.match(ensure, /resolution=ignore-duplicates,return=minimal/);
  assert.doesNotMatch(ensure, /updated_at/);
});

test('receipt accrual migration preserves historical paid rows and adds the claim-vault status', async () => {
  const migration = await readFile(
    new URL('../../supabase/migrations/20260808120000_receipt_reward_accrual.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /'claimed', 'accrued', 'refunded', 'closed'/);
  assert.match(migration, /claimed = historical direct wallet payment/);
  assert.match(migration, /accrued = reward processed into the owner claim vault/);
});

test('refund-only archival follows finalized Solana time rather than the host clock', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const archiveBody = source.slice(
    source.indexOf('async function archiveReadyRounds'),
    source.indexOf('export async function indexerTick'),
  );
  assert.match(source, /const finalizedChainTimeSeconds = async \(\) =>/);
  assert.match(archiveBody, /const chainNow = await finalizedChainTimeSeconds\(\)/);
  assert.match(archiveBody, /Number\(round\.refund_at\) > chainNow/);
  assert.doesNotMatch(archiveBody, /Date\.now\(\)/);
});

test('server randomness events use distinct proof fields instead of legacy account and slot columns', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const serverCases = source.slice(
    source.indexOf("case 'RoundServerCommitmentBound'"),
    source.indexOf("case 'DeploymentCreated'"),
  );
  assert.match(serverCases, /randomness_provider_kind: SERVER_PROVIDER_KIND/);
  assert.match(serverCases, /randomness_commitment_hex:/);
  assert.match(serverCases, /randomness_reveal_hex:/);
  assert.match(serverCases, /randomness_target_slot:/);
  assert.match(serverCases, /randomness_entropy_slot:/);
  assert.match(serverCases, /randomness_entropy_hash_hex:/);
  assert.match(serverCases, /randomness_id: null/);
  assert.match(serverCases, /randomness_commit_slot: null/);
  assert.doesNotMatch(serverCases, /new PublicKey\(data\.commitment\)/);
});

test('settlement classifies the tagged server slot without persisting it as signed bigint', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const settledCase = source.slice(
    source.indexOf("case 'RoundSettled'"),
    source.indexOf("case 'ReceiptClaimed'"),
  );
  assert.match(settledCase, /rawCommitSlot & SERVER_RANDOMNESS_SLOT_FLAG/);
  assert.match(settledCase, /randomness_id: null/);
  assert.match(settledCase, /randomness_commit_slot: null/);
  assert.match(settledCase, /requireRoundRandomnessProof\(proof/);
  assert.match(settledCase, /new PublicKey\(data\.randomnessAccount\)\.toBase58\(\)/);
});

test('zero-bid settlement still indexes the published winning tile and zero economics', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const settledCase = source.slice(
    source.indexOf("case 'RoundSettled'"),
    source.indexOf("case 'ReceiptClaimed'"),
  );
  assert.match(settledCase, /const winnerTotal = BigInt\(asString\(roundState\.tileLamports\[winningSquare\]\)\)/);
  assert.match(settledCase, /winnerTotal > 0n \?[\s\S]*: 0n/);
  assert.match(settledCase, /resolved: true/);
  assert.match(settledCase, /winning_square: winningSquare/);
  assert.match(settledCase, /bullion_for_winners_wei: asString\(data\.baseEmission\)/);
  assert.match(settledCase, /total_receipts: asString\(data\.totalReceipts\)/);
  assert.doesNotMatch(settledCase, /if \(!bets\?\.length\)|if \(bets\?\.length/);
});

test('aggregate reward stats exclude empty-round Motherlode samples', async () => {
  const migration = await readFile(
    new URL('../../supabase/migrations/20260808123000_empty_round_stats.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /create or replace view public\.mine_round_stats[\s\S]*security_invoker = true/);
  assert.match(migration, /total_wager_wei > 0 and jackpot_hit/);
  assert.match(migration, /zero-bid resolved rounds publish outcomes but never count as mining or Motherlode awards/);
});

test('archive attestation fails closed until provider-specific randomness proof is complete', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const archiveBody = source.slice(
    source.indexOf('async function archiveReadyRounds'),
    source.indexOf('export async function indexerTick'),
  );
  assert.match(archiveBody, /requireRoundRandomnessProof\(indexedRound/);
  assert.match(archiveBody, /provider_kind: round\.randomness_provider_kind/);
  assert.match(archiveBody, /commitment_hex: round\.randomness_commitment_hex/);
  assert.match(archiveBody, /entropy_hash_hex: round\.randomness_entropy_hash_hex/);
});

test('server proof migration uses unsigned-safe numeric slots and preserves Switchboard columns', async () => {
  const migration = await readFile(
    new URL('../../supabase/migrations/20260808090000_server_randomness_proofs.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /randomness_provider_kind text/);
  assert.match(migration, /randomness_target_slot numeric\(20,0\)/);
  assert.match(migration, /randomness_entropy_slot numeric\(20,0\)/);
  assert.doesNotMatch(migration, /randomness_(?:target|entropy)_slot bigint/);
  assert.match(migration, /randomness_id is null and randomness_commit_slot is null/);
  assert.match(migration, /set randomness_provider_kind = 'switchboard'/);
  assert.match(migration, /provider_kind = 'switchboard'/);
  assert.match(migration, /mine_rounds_buyback_backlog_idx/);
});
