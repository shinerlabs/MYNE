import assert from 'node:assert/strict';

import {
  archiveHash,
  requireRoundFeeAudit,
  requireRoundRandomnessProof,
  SERVER_PROVIDER_KIND,
  SWITCHBOARD_PROVIDER_KIND,
} from './round-archive-policy.mjs';

export const SERVER_RANDOMNESS_SLOT_FLAG = 1n << 63n;

const asBigInt = (value) => BigInt(value?.toString?.() ?? value ?? 0);

const projectionVector = (value) => Array.isArray(value) ? value.map(asBigInt) : [];
const ARCHIVE_HASH = /^[0-9a-f]{64}$/;
const ARCHIVE_SETTLEMENT_STATUSES = new Set(['claimed', 'accrued', 'refunded']);
const RECEIPT_SETTLEMENT_STATUSES = new Set([
  ...ARCHIVE_SETTLEMENT_STATUSES,
  'closed',
]);
const DEFAULT_CLOSED_PROOF_MAX_ROWS = 100_000;
const HEX_32 = /^[0-9a-f]{64}$/;

function requiredNonNegativeBigInt(value, label) {
  assert.ok(value !== null && value !== undefined && value !== '', `${label} is missing`);
  const parsed = asBigInt(value);
  assert.ok(parsed >= 0n, `${label} must be non-negative`);
  return parsed;
}

function requiredCanonicalNumeric(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  assert.equal(typeof value, 'string', `${label} must be a canonical numeric string`);
  assert.match(value, /^(?:0|[1-9][0-9]*)$/, `${label} is invalid`);
  return value;
}

function requiredCanonicalText(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  assert.ok(typeof value === 'string' && value.length > 0, `${label} is missing`);
  return value;
}

function requiredCanonicalHex(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  assert.ok(typeof value === 'string' && HEX_32.test(value), `${label} is invalid`);
  return value;
}

function requiredCanonicalBoolean(value, label) {
  assert.equal(typeof value, 'boolean', `${label} must be boolean`);
  return value;
}

function requiredCanonicalSquare(value, resolved) {
  if (!resolved) {
    assert.equal(value, null, 'Unresolved archive winning_square must be null');
    return null;
  }
  assert.ok(Number.isInteger(value) && value >= 0 && value < 25,
    'Resolved archive winning_square is invalid');
  return value;
}

/** Map a normalized Anchor lifecycle event to its durable projection status. */
export function receiptSettlementStatus(eventName) {
  switch (eventName) {
    case 'ReceiptClaimed': return 'claimed';
    case 'ReceiptRewardAccruedV1': return 'accrued';
    case 'ReceiptRefunded': return 'refunded';
    case 'ReceiptClosed': return 'closed';
    default: return null;
  }
}

const settlementStatusKey = (row) => JSON.stringify([
  String(row.receipt),
  String(row.status),
]);

const settlementTransactionKey = (row) => JSON.stringify([
  String(row.receipt),
  String(row.signature),
  asBigInt(row.slot).toString(),
]);

function requireSettlementEvidenceRow(row, roundId, label) {
  assert.ok(row && typeof row === 'object' && !Array.isArray(row), `${label} is invalid`);
  assert.equal(String(row.round_id), roundId, `${label} belongs to a different round`);
  assert.ok(String(row.receipt || ''), `${label} receipt is missing`);
  assert.ok(RECEIPT_SETTLEMENT_STATUSES.has(String(row.status || '')),
    `${label} status is invalid`);
  assert.ok(String(row.signature || ''), `${label} signature is missing`);
  requiredNonNegativeBigInt(row.slot, `${label} slot`);
}

/**
 * Select stale lifecycle rows that a complete finalized Round-PDA replay has
 * disproved. A row is eligible only when the exact receipt/signature/slot
 * decoded to another canonical status in that same transaction. This narrow
 * proof repairs the historical raw-vs-normalized event-name bug without ever
 * treating a missing RPC transaction or an aggregate-count mismatch as proof
 * that a genuine claimed/accrued/refunded/closed event did not happen.
 */
export function staleReceiptSettlementRows({
  roundId,
  indexedRows = [],
  canonicalRows = [],
  finalizedHistoryComplete = false,
  maxRows = 10_000,
  maxDeletes = 256,
} = {}) {
  if (!finalizedHistoryComplete) return [];
  const expectedRoundId = String(roundId ?? '');
  assert.match(expectedRoundId, /^(?:0|[1-9][0-9]*)$/, 'Settlement repair round id is invalid');
  assert.ok(Number.isInteger(maxRows) && maxRows > 0 && maxRows <= 250_000,
    'Settlement repair row bound must be 1..250000');
  assert.ok(Number.isInteger(maxDeletes) && maxDeletes > 0 && maxDeletes <= maxRows,
    'Settlement repair delete bound must be within the row bound');
  assert.ok(Array.isArray(indexedRows) && indexedRows.length <= maxRows,
    'Indexed settlement rows exceed the reviewed repair bound');
  assert.ok(Array.isArray(canonicalRows) && canonicalRows.length <= maxRows,
    'Canonical settlement rows exceed the reviewed repair bound');

  const canonicalStatuses = new Set();
  const decodedTransactions = new Set();
  for (const row of canonicalRows) {
    requireSettlementEvidenceRow(row, expectedRoundId, 'Canonical settlement row');
    canonicalStatuses.add(settlementStatusKey(row));
    decodedTransactions.add(settlementTransactionKey(row));
  }

  const stale = [];
  for (const row of indexedRows) {
    requireSettlementEvidenceRow(row, expectedRoundId, 'Indexed settlement row');
    if (canonicalStatuses.has(settlementStatusKey(row))) continue;
    if (!decodedTransactions.has(settlementTransactionKey(row))) continue;
    stale.push(row);
    if (stale.length === maxDeletes) break;
  }
  return stale;
}

/** Absence is never proof; only a verified archive may enter closed-PDA replay. */
export function closedRoundNeedsCanonicalReplay({
  indexedRound,
  projectionMatchesProof = false,
} = {}) {
  return indexedRound?.archive_verified === true
    && (!indexedRound.closed_signature || !projectionMatchesProof);
}

/**
 * Validate and project every user-visible round fact committed by an archive
 * snapshot. The provider kind is encoded by the snapshot version; v3's full
 * server proof is restored into its dedicated database columns.
 */
export function archivedSnapshotRoundProjection(
  snapshot,
  {
    programId,
    expectedRoundId,
    programIdBytes,
    mintBytes,
  } = {},
) {
  assert.ok(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot),
    'Archive snapshot must be an object');
  assert.ok(snapshot.version === 2 || snapshot.version === 3,
    'Archive snapshot version is unsupported');
  assert.equal(snapshot.program, programId, 'Archive snapshot program is invalid');
  const round = snapshot.round;
  assert.ok(round && typeof round === 'object' && !Array.isArray(round),
    'Archive snapshot round is missing');
  const roundId = requiredCanonicalNumeric(round.round_id, 'Archive round round_id');
  assert.equal(roundId, String(expectedRoundId), 'Archive snapshot round id is invalid');
  const resolved = requiredCanonicalBoolean(round.resolved, 'Archive round resolved');
  const projection = {
    round_id: roundId,
    rent_payer: requiredCanonicalText(round.rent_payer, 'Archive round rent_payer'),
    opened_at: requiredCanonicalNumeric(round.opened_at, 'Archive round opened_at'),
    betting_ends_at: requiredCanonicalNumeric(
      round.betting_ends_at,
      'Archive round betting_ends_at',
    ),
    settles_at: requiredCanonicalNumeric(round.settles_at, 'Archive round settles_at'),
    refund_at: requiredCanonicalNumeric(round.refund_at, 'Archive round refund_at'),
    resolved,
    winning_square: requiredCanonicalSquare(round.winning_square, resolved),
    jackpot_hit: requiredCanonicalBoolean(round.jackpot_hit, 'Archive round jackpot_hit'),
    single_miner_round: requiredCanonicalBoolean(
      round.single_miner_round,
      'Archive round single_miner_round',
    ),
    winner: requiredCanonicalText(round.winner, 'Archive round winner', { nullable: true }),
    total_wager_wei: requiredCanonicalNumeric(
      round.total_wager_wei,
      'Archive round total_wager_wei',
    ),
    winner_total_wei: requiredCanonicalNumeric(
      round.winner_total_wei,
      'Archive round winner_total_wei',
    ),
    pot_for_winners_wei: requiredCanonicalNumeric(
      round.pot_for_winners_wei,
      'Archive round pot_for_winners_wei',
    ),
    bullion_for_winners_wei: requiredCanonicalNumeric(
      round.bullion_for_winners_wei,
      'Archive round bullion_for_winners_wei',
    ),
    payout_mul_wad: requiredCanonicalNumeric(round.payout_mul_wad, 'Archive round payout_mul_wad'),
    total_fee_lamports: requiredCanonicalNumeric(
      round.total_fee_lamports,
      'Archive round total_fee_lamports',
      { nullable: !resolved },
    ),
    staking_gross_lamports: requiredCanonicalNumeric(
      round.staking_gross_lamports,
      'Archive round staking_gross_lamports',
      { nullable: !resolved },
    ),
    staking_admin_lamports: requiredCanonicalNumeric(
      round.staking_admin_lamports,
      'Archive round staking_admin_lamports',
      { nullable: !resolved },
    ),
    staking_net_lamports: requiredCanonicalNumeric(
      round.staking_net_lamports,
      'Archive round staking_net_lamports',
      { nullable: !resolved },
    ),
    buyback_lamports: requiredCanonicalNumeric(
      round.buyback_lamports,
      'Archive round buyback_lamports',
      { nullable: !resolved },
    ),
    motherlode_fee_lamports: requiredCanonicalNumeric(
      round.motherlode_fee_lamports,
      'Archive round motherlode_fee_lamports',
      { nullable: !resolved },
    ),
    mining_admin_lamports: requiredCanonicalNumeric(
      round.mining_admin_lamports,
      'Archive round mining_admin_lamports',
      { nullable: !resolved },
    ),
    admin_total_lamports: requiredCanonicalNumeric(
      round.admin_total_lamports,
      'Archive round admin_total_lamports',
      { nullable: !resolved },
    ),
    admin_fee_wallet: requiredCanonicalText(
      round.admin_fee_wallet,
      'Archive round admin_fee_wallet',
      { nullable: !resolved },
    ),
    randomness_id: requiredCanonicalText(
      round.randomness_id,
      'Archive round randomness_id',
      { nullable: true },
    ),
    randomness_value: requiredCanonicalNumeric(
      round.randomness_value,
      'Archive round randomness_value',
      { nullable: true },
    ),
    randomness_hex: requiredCanonicalHex(
      round.randomness_hex,
      'Archive round randomness_hex',
      { nullable: true },
    ),
    randomness_commit_slot: requiredCanonicalNumeric(
      round.randomness_commit_slot,
      'Archive round randomness_commit_slot',
      { nullable: true },
    ),
    solo_sample: requiredCanonicalNumeric(round.solo_sample, 'Archive round solo_sample'),
    total_receipts: requiredCanonicalNumeric(
      round.total_receipts,
      'Archive round total_receipts',
    ),
    processed_receipts: requiredCanonicalNumeric(
      round.processed_receipts,
      'Archive round processed_receipts',
    ),
    settlement_signature: requiredCanonicalText(
      round.settlement_signature,
      'Archive round settlement_signature',
      { nullable: !resolved },
    ),
    settlement_slot: requiredCanonicalNumeric(
      round.settlement_slot,
      'Archive round settlement_slot',
      { nullable: !resolved },
    ),
    buyback_completed: resolved,
  };
  assert.ok(BigInt(projection.opened_at) <= BigInt(projection.betting_ends_at)
      && BigInt(projection.betting_ends_at) <= BigInt(projection.settles_at)
      && BigInt(projection.settles_at) <= BigInt(projection.refund_at),
  'Archive round timing is invalid');
  assert.equal(projection.processed_receipts, projection.total_receipts,
    'Archive round was captured before every receipt was processed');
  if (projection.randomness_hex !== null || projection.randomness_value !== null) {
    assert.ok(projection.randomness_hex !== null && projection.randomness_value !== null,
      'Archive randomness output is incomplete');
    assert.equal(BigInt(`0x${projection.randomness_hex}`).toString(), projection.randomness_value,
      'Archive randomness numeric and hex outputs disagree');
  }
  if (!resolved) {
    assert.equal(projection.jackpot_hit, false, 'Unresolved archive cannot record a jackpot');
    assert.equal(projection.single_miner_round, false,
      'Unresolved archive cannot record solo mode');
    assert.equal(projection.winner, null, 'Unresolved archive cannot record a winner');
    for (const field of [
      'total_wager_wei',
      'winner_total_wei',
      'pot_for_winners_wei',
      'bullion_for_winners_wei',
      'payout_mul_wad',
      'solo_sample',
    ]) {
      assert.equal(projection[field], '0', `Unresolved archive ${field} must be zero`);
    }
    for (const field of [
      'total_fee_lamports',
      'staking_gross_lamports',
      'staking_admin_lamports',
      'staking_net_lamports',
      'buyback_lamports',
      'motherlode_fee_lamports',
      'mining_admin_lamports',
      'admin_total_lamports',
    ]) {
      assert.ok(projection[field] === null || projection[field] === '0',
        `Unresolved archive ${field} must be null or zero`);
    }
    assert.equal(projection.admin_fee_wallet, null,
      'Unresolved archive cannot record a fee recipient');
    assert.equal(projection.randomness_hex, null,
      'Unresolved archive cannot record a randomness output');
    assert.equal(projection.randomness_value, null,
      'Unresolved archive cannot record a randomness value');
  }

  if (snapshot.version === 2) {
    assert.equal('randomness_proof' in snapshot, false,
      'Version 2 archive snapshot must not contain server proof fields');
    Object.assign(projection, {
      randomness_provider_kind: SWITCHBOARD_PROVIDER_KIND,
      randomness_commitment_hex: null,
      randomness_reveal_hex: null,
      randomness_target_slot: null,
      randomness_entropy_slot: null,
      randomness_entropy_hash_hex: null,
      randomness_commitment_signature: null,
      randomness_commitment_tx_slot: null,
      randomness_lock_signature: null,
      randomness_lock_tx_slot: null,
      randomness_reveal_signature: null,
      randomness_reveal_tx_slot: null,
    });
  } else {
    const proof = snapshot.randomness_proof;
    assert.ok(proof && typeof proof === 'object' && !Array.isArray(proof),
      'Version 3 archive snapshot is missing its server proof');
    assert.equal(proof.provider_kind, SERVER_PROVIDER_KIND,
      'Archive server proof provider is invalid');
    Object.assign(projection, {
      randomness_provider_kind: SERVER_PROVIDER_KIND,
      randomness_id: null,
      randomness_commit_slot: null,
      randomness_commitment_hex: requiredCanonicalHex(
        proof.commitment_hex,
        'Archive proof commitment_hex',
        { nullable: !resolved },
      ),
      randomness_reveal_hex: requiredCanonicalHex(
        proof.reveal_hex,
        'Archive proof reveal_hex',
        { nullable: !resolved },
      ),
      randomness_target_slot: requiredCanonicalNumeric(
        proof.target_slot,
        'Archive proof target_slot',
        { nullable: !resolved },
      ),
      randomness_entropy_slot: requiredCanonicalNumeric(
        proof.entropy_slot,
        'Archive proof entropy_slot',
        { nullable: !resolved },
      ),
      randomness_entropy_hash_hex: requiredCanonicalHex(
        proof.entropy_hash_hex,
        'Archive proof entropy_hash_hex',
        { nullable: !resolved },
      ),
      randomness_commitment_signature: requiredCanonicalText(
        proof.commitment_signature,
        'Archive proof commitment_signature',
        { nullable: !resolved },
      ),
      randomness_commitment_tx_slot: requiredCanonicalNumeric(
        proof.commitment_tx_slot,
        'Archive proof commitment_tx_slot',
        { nullable: !resolved },
      ),
      randomness_lock_signature: requiredCanonicalText(
        proof.lock_signature,
        'Archive proof lock_signature',
        { nullable: !resolved },
      ),
      randomness_lock_tx_slot: requiredCanonicalNumeric(
        proof.lock_tx_slot,
        'Archive proof lock_tx_slot',
        { nullable: !resolved },
      ),
      randomness_reveal_signature: requiredCanonicalText(
        proof.reveal_signature,
        'Archive proof reveal_signature',
        { nullable: !resolved },
      ),
      randomness_reveal_tx_slot: requiredCanonicalNumeric(
        proof.reveal_tx_slot,
        'Archive proof reveal_tx_slot',
        { nullable: !resolved },
      ),
    });
    assert.equal(proof.randomness_hex, projection.randomness_hex,
      'Archive proof randomness output disagrees with its round');
    assert.equal(proof.settlement_signature, projection.settlement_signature,
      'Archive proof settlement signature disagrees with its round');
    assert.equal(proof.settlement_slot, projection.settlement_slot,
      'Archive proof settlement slot disagrees with its round');
  }

  if (resolved) {
    const fees = requireRoundFeeAudit(projection);
    const gross = BigInt(projection.total_wager_wei);
    const winningTotal = BigInt(projection.winner_total_wei);
    const prize = BigInt(projection.pot_for_winners_wei);
    assert.ok(winningTotal <= gross, 'Archive winner total exceeds the deployed total');
    assert.ok(fees.total_fee_lamports <= gross, 'Archive mining fee exceeds the deployed total');
    assert.equal(
      prize,
      winningTotal > 0n ? gross - fees.total_fee_lamports : 0n,
      'Archive winner prize disagrees with the fee-adjusted deployed total',
    );
    assert.equal(
      BigInt(projection.payout_mul_wad),
      winningTotal > 0n ? (prize * 1_000_000_000_000_000_000n) / winningTotal : 0n,
      'Archive payout multiplier disagrees with the winner pool',
    );
    requireRoundRandomnessProof(projection, { programIdBytes, mintBytes });
  }
  return projection;
}

/** Verify the immutable archive hash and return its fully validated projections. */
export function verifiedArchivedRoundProjection({
  programId,
  indexedRound,
  storedProof,
  programIdBytes,
  mintBytes,
  maxRows = DEFAULT_CLOSED_PROOF_MAX_ROWS,
} = {}) {
  assert.ok(indexedRound && storedProof, 'Archived round evidence is missing');
  assert.equal(indexedRound.archive_verified, true, 'Archive was not verified on chain');
  const expectedRoundId = String(indexedRound.round_id ?? '');
  assert.equal(String(storedProof.round_id ?? ''), expectedRoundId,
    'Stored archive proof belongs to a different round');
  const storedHash = String(storedProof.archive_hash ?? '');
  assert.ok(ARCHIVE_HASH.test(storedHash), 'Stored archive hash is invalid');
  assert.equal(String(indexedRound.archive_hash ?? ''), storedHash,
    'Stored and indexed archive hashes disagree');
  assert.ok(Number.isInteger(maxRows) && maxRows > 0 && maxRows <= 250_000,
    'Closed archive proof row bound must be 1..250000');
  const snapshot = storedProof.canonical_snapshot;
  assert.ok(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot),
    'Archive snapshot is missing');
  assert.ok(Array.isArray(snapshot.bets) && Array.isArray(snapshot.settlements)
      && Array.isArray(snapshot.buybacks),
  'Archive snapshot row collections are missing');
  assert.ok(snapshot.bets.length + snapshot.settlements.length + snapshot.buybacks.length <= maxRows,
    'Archive snapshot exceeds the reviewed total row bound');
  assert.equal(archiveHash(snapshot), storedHash, 'Archive snapshot hash is invalid');
  return {
    roundProjection: archivedSnapshotRoundProjection(snapshot, {
      programId,
      expectedRoundId,
      programIdBytes,
      mintBytes,
    }),
    participantProjection: archivedSnapshotProjectionDigest(snapshot, { maxRows }),
  };
}

/**
 * Recompute the participant/lifecycle aggregate committed by an immutable
 * archive snapshot. Closed Round PDAs no longer exist, so this digest is the
 * only bounded substitute for the on-chain tile vectors after the archive
 * hash has already been verified against the account and persisted.
 */
export function archivedSnapshotProjectionDigest(
  snapshot,
  { maxRows = DEFAULT_CLOSED_PROOF_MAX_ROWS } = {},
) {
  assert.ok(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot),
    'Archive snapshot must be an object');
  assert.ok(snapshot.version === 2 || snapshot.version === 3,
    'Archive snapshot version is unsupported');
  assert.ok(typeof snapshot.program === 'string' && snapshot.program.length > 0,
    'Archive snapshot program is missing');
  assert.ok(snapshot.round && typeof snapshot.round === 'object' && !Array.isArray(snapshot.round),
    'Archive snapshot round is missing');
  assert.ok(Array.isArray(snapshot.bets), 'Archive snapshot bets are missing');
  assert.ok(Array.isArray(snapshot.settlements), 'Archive snapshot settlements are missing');
  assert.ok(Array.isArray(snapshot.buybacks), 'Archive snapshot buybacks are missing');
  assert.ok(Number.isInteger(maxRows) && maxRows > 0 && maxRows <= 250_000,
    'Closed archive proof row bound must be 1..250000');
  assert.ok(snapshot.bets.length + snapshot.settlements.length <= maxRows,
    'Closed archive proof exceeds the reviewed participant row bound');
  if (snapshot.version === 2) {
    assert.equal('randomness_proof' in snapshot, false,
      'Version 2 archive snapshot must not contain server proof fields');
  } else {
    assert.ok(snapshot.randomness_proof && typeof snapshot.randomness_proof === 'object',
      'Version 3 archive snapshot is missing its server proof');
  }

  const roundId = String(snapshot.round.round_id ?? '');
  assert.match(roundId, /^(?:0|[1-9][0-9]*)$/, 'Archive snapshot round id is invalid');
  const participantReceipts = new Set();
  const betKeys = new Set();
  const tileLamports = Array(25).fill(0n);
  const tileReceiptSets = Array.from({ length: 25 }, () => new Set());
  for (const bet of snapshot.bets) {
    assert.equal(String(bet?.round_id ?? ''), roundId,
      'Archive bet belongs to a different round');
    const receipt = String(bet?.receipt ?? '');
    assert.ok(receipt, 'Archive bet receipt is missing');
    const square = Number(bet?.square);
    assert.ok(Number.isInteger(square) && square >= 0 && square < 25,
      'Archive bet square is invalid');
    const amount = requiredNonNegativeBigInt(bet?.amount_wei, 'Archive bet amount');
    assert.ok(amount > 0n, 'Archive bet amount must be positive');
    const key = `${receipt}:${square}`;
    assert.equal(betKeys.has(key), false, 'Archive snapshot contains a duplicate bet row');
    betKeys.add(key);
    participantReceipts.add(receipt);
    tileLamports[square] += amount;
    tileReceiptSets[square].add(receipt);
  }

  const processedReceipts = new Set();
  const processedStatusByReceipt = new Map();
  const settlementKeys = new Set();
  for (const settlement of snapshot.settlements) {
    assert.equal(String(settlement?.round_id ?? ''), roundId,
      'Archive settlement belongs to a different round');
    const receipt = String(settlement?.receipt ?? '');
    assert.ok(receipt, 'Archive settlement receipt is missing');
    assert.ok(participantReceipts.has(receipt),
      'Archive settlement has no participant receipt');
    const status = String(settlement?.status ?? '');
    assert.ok(ARCHIVE_SETTLEMENT_STATUSES.has(status),
      'Archive settlement status is not lifecycle-final');
    const previousStatus = processedStatusByReceipt.get(receipt);
    assert.ok(previousStatus === undefined || previousStatus === status,
      'Archive receipt has contradictory lifecycle-final statuses');
    processedStatusByReceipt.set(receipt, status);
    const key = `${receipt}:${status}`;
    assert.equal(settlementKeys.has(key), false,
      'Archive snapshot contains a duplicate settlement row');
    settlementKeys.add(key);
    processedReceipts.add(receipt);
  }

  const totalReceipts = BigInt(participantReceipts.size);
  const processedReceiptCount = BigInt(processedReceipts.size);
  assert.equal(requiredNonNegativeBigInt(
    snapshot.round.total_receipts,
    'Archive round total_receipts',
  ), totalReceipts,
    'Archive participant count disagrees with its round snapshot');
  assert.equal(requiredNonNegativeBigInt(
    snapshot.round.processed_receipts,
    'Archive round processed_receipts',
  ), processedReceiptCount,
    'Archive settlement count disagrees with its round snapshot');
  assert.equal(processedReceiptCount, totalReceipts,
    'Archive snapshot was created before every receipt was processed');

  return {
    round_id: roundId,
    indexed_total_receipts: totalReceipts,
    indexed_processed_receipts: processedReceiptCount,
    indexed_tile_lamports: tileLamports,
    indexed_tile_receipts: tileReceiptSets.map((receipts) => BigInt(receipts.size)),
  };
}

/**
 * Verify a closed round without weakening the live-PDA completeness rule.
 * `archive_verified` means the stored hash was compared with the finalized
 * Round PDA before closure. We still recompute that hash and independently
 * compare its participant/settlement aggregate with today's database rows.
 * Any malformed or incomplete evidence fails closed.
 */
export function roundProjectionMatchesArchivedProof({
  programId,
  indexedRound,
  storedProof,
  indexedProjection,
  programIdBytes,
  mintBytes,
  maxRows = DEFAULT_CLOSED_PROOF_MAX_ROWS,
} = {}) {
  try {
    if (!indexedRound || !storedProof || !indexedProjection) return false;
    if (!indexedRound.closed_signature
        || asBigInt(indexedRound.closed_slot) <= 0n) return false;
    const {
      roundProjection,
      participantProjection: archived,
    } = verifiedArchivedRoundProjection({
      programId,
      indexedRound,
      storedProof,
      programIdBytes,
      mintBytes,
      maxRows,
    });
    for (const [field, expected] of Object.entries(roundProjection)) {
      if (typeof expected === 'boolean') {
        if (indexedRound[field] !== expected) return false;
      } else if (expected === null) {
        if (indexedRound[field] !== null) return false;
      } else if (String(indexedRound[field]) !== String(expected)) return false;
    }
    if (asBigInt(indexedRound.closed_receipts) !== archived.indexed_total_receipts) return false;

    const databaseLamports = projectionVector(indexedProjection.indexed_tile_lamports);
    const databaseReceipts = projectionVector(indexedProjection.indexed_tile_receipts);
    if (databaseLamports.length !== 25 || databaseReceipts.length !== 25) return false;
    if (asBigInt(indexedProjection.indexed_total_receipts)
        !== archived.indexed_total_receipts) return false;
    if (asBigInt(indexedProjection.indexed_processed_receipts)
        !== archived.indexed_processed_receipts) return false;
    // RoundClosed is only legal after every processed receipt is closed. This
    // catches a missed ReceiptClosed event even though closure happens after
    // the pre-close archive snapshot was attested.
    if (asBigInt(indexedProjection.indexed_closed_receipts)
        !== archived.indexed_total_receipts) return false;
    for (let square = 0; square < 25; square += 1) {
      if (databaseLamports[square] !== archived.indexed_tile_lamports[square]) return false;
      if (databaseReceipts[square] !== archived.indexed_tile_receipts[square]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare the rebuildable participant projection with every authoritative
 * aggregate stored in the finalized Round PDA. A total receipt count alone is
 * insufficient: one missing tile row and one duplicate tile row can cancel at
 * the round level while still publishing the wrong miners and payouts.
 */
export function roundParticipantProjectionMatchesChain(chainRound, indexedProjection) {
  if (!chainRound || !indexedProjection) return false;
  const chainLamports = projectionVector(chainRound.tileLamports);
  const chainReceipts = projectionVector(chainRound.tileReceipts);
  const indexedLamports = projectionVector(indexedProjection.indexed_tile_lamports);
  const indexedReceipts = projectionVector(indexedProjection.indexed_tile_receipts);
  if (chainLamports.length !== 25 || chainReceipts.length !== 25
      || indexedLamports.length !== 25 || indexedReceipts.length !== 25) return false;
  if (asBigInt(indexedProjection.indexed_total_receipts)
      !== asBigInt(chainRound.totalReceipts)) return false;
  for (let square = 0; square < 25; square += 1) {
    if (indexedLamports[square] !== chainLamports[square]) return false;
    if (indexedReceipts[square] !== chainReceipts[square]) return false;
  }
  return true;
}

export function roundProjectionMatchesChain(chainRound, indexedProjection) {
  return roundParticipantProjectionMatchesChain(chainRound, indexedProjection)
    && asBigInt(indexedProjection.indexed_processed_receipts)
      === asBigInt(chainRound.processedReceipts)
    && asBigInt(indexedProjection.indexed_closed_receipts)
      === asBigInt(chainRound.closedReceipts);
}

/**
 * Fully refunded rounds intentionally zero their live lamport buckets while
 * preserving immutable deployment rows. Prove that alternate terminal state
 * from exact refund events without weakening the settled-round comparison.
 */
export function refundedRoundProjectionMatchesChain({
  chainRound,
  indexedProjection,
  bets,
  settlements,
  finalizedChainTime,
} = {}) {
  try {
    if (!chainRound || chainRound.settled || !indexedProjection
        || !Array.isArray(bets) || !Array.isArray(settlements)) return false;
    const finalizedNow = requiredNonNegativeBigInt(
      finalizedChainTime,
      'Finalized chain time',
    );
    const refundAt = requiredNonNegativeBigInt(chainRound.refundAt, 'Round refund deadline');
    if (finalizedNow < refundAt) return false;
    const totalReceipts = asBigInt(chainRound.totalReceipts);
    if (asBigInt(chainRound.processedReceipts) !== totalReceipts
        || asBigInt(chainRound.closedReceipts) !== 0n
        || asBigInt(chainRound.grossDeployedLamports) !== 0n
        || asBigInt(chainRound.prizeLamports) !== 0n) return false;
    const chainLamports = projectionVector(chainRound.tileLamports);
    const chainReceiptCounts = projectionVector(chainRound.tileReceipts);
    const indexedLamports = projectionVector(indexedProjection.indexed_tile_lamports);
    const indexedReceiptCounts = projectionVector(indexedProjection.indexed_tile_receipts);
    if (chainLamports.length !== 25 || chainReceiptCounts.length !== 25
        || indexedLamports.length !== 25 || indexedReceiptCounts.length !== 25
        || chainLamports.some((amount) => amount !== 0n)) return false;
    if (asBigInt(indexedProjection.indexed_total_receipts) !== totalReceipts
        || asBigInt(indexedProjection.indexed_processed_receipts) !== totalReceipts
        || asBigInt(indexedProjection.indexed_closed_receipts) !== 0n) return false;

    const roundId = asBigInt(chainRound.id).toString();
    const betAmountsByReceipt = new Map();
    const tileAmounts = Array(25).fill(0n);
    const tileReceipts = Array.from({ length: 25 }, () => new Set());
    const betKeys = new Set();
    for (const bet of bets) {
      if (String(bet?.round_id) !== roundId) return false;
      const receipt = String(bet?.receipt || '');
      const square = Number(bet?.square);
      const amount = requiredNonNegativeBigInt(bet?.amount_wei, 'Refund bet amount');
      if (!receipt || !Number.isInteger(square) || square < 0 || square >= 25 || amount === 0n) {
        return false;
      }
      const betKey = `${receipt}:${square}`;
      if (betKeys.has(betKey)) return false;
      betKeys.add(betKey);
      betAmountsByReceipt.set(receipt, (betAmountsByReceipt.get(receipt) || 0n) + amount);
      tileAmounts[square] += amount;
      tileReceipts[square].add(receipt);
    }
    if (BigInt(betAmountsByReceipt.size) !== totalReceipts) return false;
    for (let square = 0; square < 25; square += 1) {
      if (indexedLamports[square] !== tileAmounts[square]
          || indexedReceiptCounts[square] !== BigInt(tileReceipts[square].size)
          || chainReceiptCounts[square] !== indexedReceiptCounts[square]) return false;
    }

    const refundedReceipts = new Set();
    for (const settlement of settlements) {
      if (String(settlement?.round_id) !== roundId
          || settlement?.status !== 'refunded') return false;
      const receipt = String(settlement?.receipt || '');
      if (!receipt || refundedReceipts.has(receipt) || !betAmountsByReceipt.has(receipt)) return false;
      if (requiredNonNegativeBigInt(
        settlement.sol_lamports,
        'Refund settlement lamports',
      ) !== betAmountsByReceipt.get(receipt)
          || requiredNonNegativeBigInt(settlement.myne_base_units, 'Refund MYNE amount') !== 0n
          || requiredNonNegativeBigInt(
            settlement.motherlode_base_units,
            'Refund Motherlode amount',
          ) !== 0n) return false;
      refundedReceipts.add(receipt);
    }
    return BigInt(refundedReceipts.size) === totalReceipts;
  } catch {
    return false;
  }
}

export function recentScheduledRoundIds(currentRoundId, depth = 12) {
  const current = asBigInt(currentRoundId);
  assert.ok(current >= 0n, 'Current round id must be non-negative');
  assert.ok(Number.isInteger(depth) && depth > 0 && depth <= 64, 'Recent round depth must be 1..64');
  const ids = [];
  for (let offset = 0n; offset < BigInt(depth) && offset <= current; offset += 1n) {
    ids.push(current - offset);
  }
  return ids;
}

export function historicalRoundGapBatch({
  currentRoundId,
  recentDepth = 12,
  nextRoundId = 0n,
  batchSize = 8,
} = {}) {
  const current = asBigInt(currentRoundId);
  const nextCandidate = asBigInt(nextRoundId);
  assert.ok(current >= 0n, 'Current round id must be non-negative');
  assert.ok(Number.isInteger(recentDepth) && recentDepth > 0 && recentDepth <= 64,
    'Recent round depth must be 1..64');
  assert.ok(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 32,
    'Historical gap batch must be 1..32');
  const high = current - BigInt(recentDepth);
  if (high < 0n) return { ids: [], nextRoundId: 0n };
  const start = nextCandidate >= 0n && nextCandidate <= high ? nextCandidate : 0n;
  const ids = [];
  for (let offset = 0n; offset < BigInt(batchSize) && start + offset <= high; offset += 1n) {
    ids.push(start + offset);
  }
  return {
    ids,
    nextRoundId: ids.length && ids.at(-1) < high ? ids.at(-1) + 1n : 0n,
  };
}

export function canonicalSignatureOrder(rows) {
  const unique = new Map();
  for (const row of rows || []) {
    if (!row?.signature || row.err) continue;
    if (!unique.has(row.signature)) unique.set(row.signature, row);
  }
  // getSignaturesForAddress is newest-first. Stable sort by slot first and
  // reverse same-slot RPC order so events are projected in canonical history
  // order before their dependent settlement.
  return [...unique.values()]
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const slotDelta = Number(left.row.slot) - Number(right.row.slot);
      if (slotDelta !== 0) return slotDelta;
      return right.index - left.index;
    })
    .map(({ row }) => row);
}

const completeServerProof = (round) => Boolean(
  round?.randomness_commitment_hex
  && round?.randomness_reveal_hex
  && round?.randomness_target_slot != null
  && round?.randomness_entropy_slot != null
  && round?.randomness_entropy_hash_hex
  && round?.randomness_commitment_signature
  && round?.randomness_lock_signature
  && round?.randomness_reveal_signature
  && round?.settlement_signature,
);

export function roundNeedsCanonicalReplay({
  indexedRound,
  chainRound,
  indexedProjection = null,
} = {}) {
  if (!chainRound) return false;
  // The active round may legitimately lead the finalized event cursor by one
  // transaction. Mark its projection incomplete and let the forward cursor do
  // the cheap append; do not replay its entire growing history on every bet.
  if (!indexedRound) return Boolean(chainRound.settled);
  if (Boolean(indexedRound.resolved) !== Boolean(chainRound.settled)) return true;
  if (!roundParticipantProjectionMatchesChain(chainRound, indexedProjection)) {
    // During open betting the account legitimately leads the forward cursor.
    // Replaying an ever-growing round on every deployment would delay that
    // cursor; a finalized result/refund is the point at which a mismatch must
    // be repaired canonically.
    return Boolean(chainRound.settled)
      || asBigInt(chainRound.processedReceipts) === asBigInt(chainRound.totalReceipts);
  }
  const lifecycleMismatch = asBigInt(indexedProjection.indexed_processed_receipts)
      !== asBigInt(chainRound.processedReceipts)
    || asBigInt(indexedProjection.indexed_closed_receipts)
      !== asBigInt(chainRound.closedReceipts);
  if (lifecycleMismatch
      && asBigInt(chainRound.processedReceipts) === asBigInt(chainRound.totalReceipts)) return true;
  if (!chainRound.settled) return false;
  if (!indexedRound.settlement_signature) return true;
  const encodedSlot = asBigInt(chainRound.randomnessCommitSlot);
  return (encodedSlot & SERVER_RANDOMNESS_SLOT_FLAG) !== 0n && !completeServerProof(indexedRound);
}
