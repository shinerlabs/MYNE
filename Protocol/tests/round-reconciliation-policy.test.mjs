import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SERVER_RANDOMNESS_SLOT_FLAG,
  canonicalSignatureOrder,
  historicalRoundGapBatch,
  recentScheduledRoundIds,
  roundParticipantProjectionMatchesChain,
  roundNeedsCanonicalReplay,
  roundProjectionMatchesChain,
} from '../scripts/round-reconciliation-policy.mjs';

const projection = ({
  receipts = 2n,
  processed = 1n,
  closed = 0n,
  tile0 = 10n,
  tile0Receipts = 2n,
} = {}) => ({
  indexed_total_receipts: receipts,
  indexed_processed_receipts: processed,
  indexed_closed_receipts: closed,
  indexed_tile_lamports: [tile0, ...Array(24).fill(0n)],
  indexed_tile_receipts: [tile0Receipts, ...Array(24).fill(0n)],
});

test('recent reconciliation derives a bounded exact PDA window', () => {
  assert.deepEqual(recentScheduledRoundIds(5n, 4), [5n, 4n, 3n, 2n]);
  assert.deepEqual(recentScheduledRoundIds(1n, 12), [1n, 0n]);
  assert.throws(() => recentScheduledRoundIds(1n, 0), /1\.\.64/);
});

test('historical gap scan advances fairly and wraps without overlapping recent ids', () => {
  assert.deepEqual(historicalRoundGapBatch({
    currentRoundId: 20n, recentDepth: 5, nextRoundId: 0n, batchSize: 4,
  }), { ids: [0n, 1n, 2n, 3n], nextRoundId: 4n });
  assert.deepEqual(historicalRoundGapBatch({
    currentRoundId: 20n, recentDepth: 5, nextRoundId: 14n, batchSize: 4,
  }), { ids: [14n, 15n], nextRoundId: 0n });
  assert.deepEqual(historicalRoundGapBatch({
    currentRoundId: 3n, recentDepth: 5, nextRoundId: 0n, batchSize: 4,
  }), { ids: [], nextRoundId: 0n });
});

test('round history is replayed oldest-to-newest and deduplicated', () => {
  const ordered = canonicalSignatureOrder([
    { signature: 'settle', slot: 13, err: null },
    { signature: 'lock', slot: 12, err: null },
    { signature: 'deploy-b', slot: 11, err: null },
    { signature: 'deploy-a', slot: 11, err: null },
    { signature: 'lock', slot: 12, err: null },
    { signature: 'failed', slot: 10, err: { custom: 1 } },
  ]);
  assert.deepEqual(ordered.map((row) => row.signature), ['deploy-a', 'deploy-b', 'lock', 'settle']);
});

test('missing proof, bets, receipts, or row forces canonical replay', () => {
  const chainRound = {
    settled: true,
    totalReceipts: 2n,
    processedReceipts: 1n,
    closedReceipts: 0n,
    tileLamports: [10n, ...Array(24).fill(0n)],
    tileReceipts: [2n, ...Array(24).fill(0n)],
    randomnessCommitSlot: SERVER_RANDOMNESS_SLOT_FLAG | 44n,
  };
  const complete = {
    resolved: true,
    settlement_signature: 'settle',
    randomness_commitment_hex: '11',
    randomness_reveal_hex: '22',
    randomness_target_slot: '43',
    randomness_entropy_slot: '44',
    randomness_entropy_hash_hex: '33',
    randomness_commitment_signature: 'commit',
    randomness_lock_signature: 'lock',
    randomness_reveal_signature: 'reveal',
  };
  assert.equal(roundNeedsCanonicalReplay({ chainRound, indexedRound: null }), true);
  assert.equal(roundNeedsCanonicalReplay({
    chainRound, indexedRound: complete, indexedProjection: projection(),
  }), false);
  assert.equal(roundNeedsCanonicalReplay({
    chainRound, indexedRound: { ...complete, randomness_lock_signature: null },
    indexedProjection: projection(),
  }), true);
  assert.equal(roundNeedsCanonicalReplay({
    chainRound, indexedRound: complete, indexedProjection: projection({ receipts: 1n }),
  }), true);
  assert.equal(roundNeedsCanonicalReplay({
    chainRound, indexedRound: complete, indexedProjection: projection({ processed: 0n }),
  }), false);
  assert.equal(roundNeedsCanonicalReplay({
    chainRound: { ...chainRound, processedReceipts: 2n },
    indexedRound: complete,
    indexedProjection: projection({ processed: 1n }),
  }), true);
});

test('projection completeness verifies all 25 tile sums and receipt counts', () => {
  const chainRound = {
    totalReceipts: 2n,
    processedReceipts: 1n,
    closedReceipts: 0n,
    tileLamports: [10n, ...Array(24).fill(0n)],
    tileReceipts: [2n, ...Array(24).fill(0n)],
  };
  assert.equal(roundProjectionMatchesChain(chainRound, projection()), true);
  assert.equal(roundParticipantProjectionMatchesChain(
    chainRound, projection({ processed: 0n, closed: 1n }),
  ), true);
  assert.equal(roundProjectionMatchesChain(chainRound, projection({ tile0: 9n })), false);
  assert.equal(roundProjectionMatchesChain(chainRound, projection({ tile0Receipts: 1n })), false);
  assert.equal(roundProjectionMatchesChain(chainRound, projection({ receipts: 1n })), false);
  assert.equal(roundProjectionMatchesChain(chainRound, projection({ processed: 0n })), false);
  assert.equal(roundProjectionMatchesChain(chainRound, projection({ closed: 1n })), false);
  assert.equal(roundProjectionMatchesChain(chainRound, {
    ...projection(), indexed_tile_lamports: [10n],
  }), false);
});

test('an active round waits for the forward cursor instead of replaying every new bet', () => {
  const chainRound = {
    settled: false,
    totalReceipts: 3n,
    processedReceipts: 0n,
    closedReceipts: 0n,
    tileLamports: [30n, ...Array(24).fill(0n)],
    tileReceipts: [3n, ...Array(24).fill(0n)],
    randomnessCommitSlot: 0n,
  };
  assert.equal(roundNeedsCanonicalReplay({
    chainRound,
    indexedRound: { resolved: false },
    indexedProjection: projection({ receipts: 2n, tile0: 20n, tile0Receipts: 2n }),
  }), false);
});
