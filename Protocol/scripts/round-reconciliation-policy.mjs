import assert from 'node:assert/strict';

export const SERVER_RANDOMNESS_SLOT_FLAG = 1n << 63n;

const asBigInt = (value) => BigInt(value?.toString?.() ?? value ?? 0);

const projectionVector = (value) => Array.isArray(value) ? value.map(asBigInt) : [];

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
