import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  archivedSnapshotProjectionDigest,
  SERVER_RANDOMNESS_SLOT_FLAG,
  canonicalSignatureOrder,
  closedRoundNeedsCanonicalReplay,
  historicalRoundGapBatch,
  receiptSettlementStatus,
  recentScheduledRoundIds,
  refundedRoundProjectionMatchesChain,
  randomnessProjectionValueMatches,
  roundParticipantProjectionMatchesChain,
  roundNeedsCanonicalReplay,
  roundProjectionMatchesArchivedProof,
  roundProjectionMatchesChain,
  staleReceiptSettlementRows,
  verifiedArchivedRoundProjection,
} from '../scripts/round-reconciliation-policy.mjs';
import {
  archiveHash,
  buildArchiveSnapshot,
  SERVER_PROVIDER_KIND,
  SWITCHBOARD_PROVIDER_KIND,
} from '../scripts/round-archive-policy.mjs';

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

test('normalized receipt event names map to one canonical lifecycle status', () => {
  assert.equal(receiptSettlementStatus('ReceiptClaimed'), 'claimed');
  assert.equal(receiptSettlementStatus('ReceiptRewardAccruedV1'), 'accrued');
  assert.equal(receiptSettlementStatus('ReceiptRefunded'), 'refunded');
  assert.equal(receiptSettlementStatus('ReceiptClosed'), 'closed');
  assert.equal(receiptSettlementStatus('receiptClaimed'), null,
    'the index boundary must normalize event names before status mapping');
  assert.equal(receiptSettlementStatus('RoundSettled'), null);
});

test('canonical history prunes only the false status decoded from that exact transaction', () => {
  const canonicalRows = [
    {
      round_id: 318,
      receipt: 'receipt-a',
      status: 'claimed',
      signature: 'claim-signature-a',
      slot: 100,
    },
    {
      round_id: 318,
      receipt: 'receipt-b',
      status: 'refunded',
      signature: 'refund-signature-b',
      slot: 101,
    },
    {
      round_id: 318,
      receipt: 'receipt-c',
      status: 'accrued',
      signature: 'accrue-signature-c',
      slot: 102,
    },
    {
      round_id: 318,
      receipt: 'receipt-c',
      status: 'closed',
      signature: 'close-signature-c',
      slot: 103,
    },
  ];
  const indexedRows = [
    ...canonicalRows,
    {
      round_id: 318,
      receipt: 'receipt-a',
      status: 'closed',
      signature: 'claim-signature-a',
      slot: 100,
    },
    {
      round_id: 318,
      receipt: 'receipt-b',
      status: 'closed',
      signature: 'refund-signature-b',
      slot: 101,
    },
    {
      round_id: 318,
      receipt: 'receipt-d',
      status: 'closed',
      signature: 'unavailable-signature',
      slot: 104,
    },
  ];
  const stale = staleReceiptSettlementRows({
    roundId: 318,
    indexedRows,
    canonicalRows,
    finalizedHistoryComplete: true,
  });
  assert.deepEqual(stale.map((row) => [row.receipt, row.status]), [
    ['receipt-a', 'closed'],
    ['receipt-b', 'closed'],
  ]);
  assert.ok(!stale.some((row) => row.receipt === 'receipt-c'),
    'genuine accrued and closed evidence must be preserved');
  assert.ok(!stale.some((row) => row.receipt === 'receipt-d'),
    'absence of a decoded transaction is not deletion proof');
});

test('settlement cleanup fails closed on incomplete or oversized history and is batch bounded', () => {
  const falseClosed = {
    round_id: 319,
    receipt: 'receipt-a',
    status: 'closed',
    signature: 'claim-signature-a',
    slot: 100,
  };
  const canonicalClaim = {
    ...falseClosed,
    status: 'claimed',
  };
  assert.deepEqual(staleReceiptSettlementRows({
    roundId: 319,
    indexedRows: [falseClosed],
    canonicalRows: [canonicalClaim],
    finalizedHistoryComplete: false,
  }), []);
  assert.throws(() => staleReceiptSettlementRows({
    roundId: 319,
    indexedRows: [falseClosed, { ...falseClosed, receipt: 'receipt-b' }],
    canonicalRows: [canonicalClaim],
    finalizedHistoryComplete: true,
    maxRows: 1,
    maxDeletes: 1,
  }), /exceed.*bound/);
  assert.equal(staleReceiptSettlementRows({
    roundId: 319,
    indexedRows: [falseClosed, { ...falseClosed, receipt: 'receipt-b' }],
    canonicalRows: [canonicalClaim, { ...canonicalClaim, receipt: 'receipt-b' }],
    finalizedHistoryComplete: true,
    maxRows: 2,
    maxDeletes: 1,
  }).length, 1);
});

test('an absent Round PDA replays only when a verified archive needs repair', () => {
  assert.equal(closedRoundNeedsCanonicalReplay({
    indexedRound: { archive_verified: true, closed_signature: null },
    projectionMatchesProof: false,
  }), true);
  assert.equal(closedRoundNeedsCanonicalReplay({
    indexedRound: { archive_verified: true, closed_signature: 'closed' },
    projectionMatchesProof: false,
  }), true);
  assert.equal(closedRoundNeedsCanonicalReplay({
    indexedRound: { archive_verified: true, closed_signature: 'closed' },
    projectionMatchesProof: true,
  }), false);
  assert.equal(closedRoundNeedsCanonicalReplay({
    indexedRound: { archive_verified: false, closed_signature: 'closed' },
    projectionMatchesProof: false,
  }), false, 'PDA absence without verified archive evidence is never authoritative');
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

test('fully refunded rounds prove immutable bets against exact refund events', () => {
  const refundBets = [
    { round_id: 319, receipt: 'receipt-a', square: 0, amount_wei: '7' },
    { round_id: 319, receipt: 'receipt-a', square: 1, amount_wei: '3' },
    { round_id: 319, receipt: 'receipt-b', square: 0, amount_wei: '5' },
  ];
  const refunds = [
    {
      round_id: 319,
      receipt: 'receipt-a',
      status: 'refunded',
      sol_lamports: '10',
      myne_base_units: '0',
      motherlode_base_units: '0',
    },
    {
      round_id: 319,
      receipt: 'receipt-b',
      status: 'refunded',
      sol_lamports: '5',
      myne_base_units: '0',
      motherlode_base_units: '0',
    },
  ];
  const refundChain = {
    id: 319,
    settled: false,
    refundAt: 500,
    totalReceipts: 2,
    processedReceipts: 2,
    closedReceipts: 0,
    grossDeployedLamports: 0,
    prizeLamports: 0,
    tileLamports: Array(25).fill(0),
    tileReceipts: [2, 1, ...Array(23).fill(0)],
  };
  const refundDigest = projection({
    receipts: 2,
    processed: 2,
    closed: 0,
    tile0: 12,
    tile0Receipts: 2,
  });
  refundDigest.indexed_tile_lamports[1] = 3;
  refundDigest.indexed_tile_receipts[1] = 1;
  const valid = {
    chainRound: refundChain,
    indexedProjection: refundDigest,
    bets: refundBets,
    settlements: refunds,
    finalizedChainTime: 500,
  };
  assert.equal(refundedRoundProjectionMatchesChain(valid), true);
  assert.equal(refundedRoundProjectionMatchesChain({
    ...valid,
    finalizedChainTime: 499,
  }), false, 'the finalized chain clock must reach the authoritative PDA refund deadline');
  assert.equal(refundedRoundProjectionMatchesChain({
    ...valid,
    finalizedChainTime: undefined,
  }), false, 'host or database time cannot substitute for finalized chain time');
  assert.equal(refundedRoundProjectionMatchesChain({
    ...valid,
    chainRound: { ...refundChain, settled: true },
  }), false, 'settled rounds never enter the refund exception');
  assert.equal(refundedRoundProjectionMatchesChain({
    ...valid,
    chainRound: { ...refundChain, tileLamports: [1, ...Array(24).fill(0)] },
  }), false);
  assert.equal(refundedRoundProjectionMatchesChain({
    ...valid,
    settlements: [{ ...refunds[0], sol_lamports: '9' }, refunds[1]],
  }), false);
  assert.equal(refundedRoundProjectionMatchesChain({
    ...valid,
    settlements: [{ ...refunds[0], status: 'accrued' }, refunds[1]],
  }), false);
  assert.equal(refundedRoundProjectionMatchesChain({
    ...valid,
    indexedProjection: { ...refundDigest, indexed_closed_receipts: 1 },
  }), false, 'false historical closed rows must be repaired before refund archival');
});

const archivedBets = [
  {
    round_id: 41,
    receipt: 'receipt-a',
    bettor: 'miner-a',
    nonce: 1,
    square: 0,
    amount_wei: '7',
    cumulative_start_wei: '0',
    reward_mode: 0,
    deployment_signature: 'deploy-a',
    deployment_slot: 100,
  },
  {
    round_id: 41,
    receipt: 'receipt-a',
    bettor: 'miner-a',
    nonce: 1,
    square: 1,
    amount_wei: '3',
    cumulative_start_wei: '0',
    reward_mode: 0,
    deployment_signature: 'deploy-a',
    deployment_slot: 100,
  },
  {
    round_id: 41,
    receipt: 'receipt-b',
    bettor: 'miner-b',
    nonce: 2,
    square: 0,
    amount_wei: '5',
    cumulative_start_wei: '7',
    reward_mode: 1,
    deployment_signature: 'deploy-b',
    deployment_slot: 101,
  },
];
const archivedSettlements = [
  {
    round_id: 41,
    receipt: 'receipt-a',
    authority: 'miner-a',
    nonce: 1,
    status: 'accrued',
    sol_lamports: '9',
    myne_base_units: '10',
    motherlode_base_units: '0',
    signature: 'settle-a',
    slot: 110,
  },
  {
    round_id: 41,
    receipt: 'receipt-b',
    authority: 'miner-b',
    nonce: 2,
    status: 'refunded',
    sol_lamports: '5',
    myne_base_units: '0',
    motherlode_base_units: '0',
    signature: 'settle-b',
    slot: 111,
  },
];
const archivedSnapshot = buildArchiveSnapshot({
  program: 'program-id',
  round: {
    round_id: 41,
    rent_payer: 'payer',
    opened_at: 100,
    betting_ends_at: 160,
    settles_at: 160,
    refund_at: 200,
    randomness_provider_kind: SWITCHBOARD_PROVIDER_KIND,
    randomness_id: 'randomness-account',
    randomness_value: '1',
    randomness_hex: `${'00'.repeat(31)}01`,
    randomness_commit_slot: 50,
    resolved: true,
    winning_square: 0,
    jackpot_hit: false,
    single_miner_round: false,
    winner: null,
    total_wager_wei: '15',
    winner_total_wei: '12',
    pot_for_winners_wei: '12',
    bullion_for_winners_wei: '10',
    payout_mul_wad: '1000000000000000000',
    total_fee_lamports: '3',
    staking_gross_lamports: '1',
    staking_admin_lamports: '0',
    staking_net_lamports: '1',
    buyback_lamports: '1',
    motherlode_fee_lamports: '0',
    mining_admin_lamports: '1',
    admin_total_lamports: '1',
    admin_fee_wallet: 'admin',
    solo_sample: '0',
    total_receipts: 2,
    processed_receipts: 2,
    settlement_signature: 'settle',
    settlement_slot: 110,
  },
  bets: archivedBets,
  settlements: archivedSettlements,
  buybacks: [],
});
const archivedHash = archiveHash(archivedSnapshot);
const archivedIndexedRound = {
  ...archivedSnapshot.round,
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
  buyback_completed: true,
  archive_verified: true,
  archive_hash: archivedHash,
  closed_signature: 'close-round',
  closed_slot: 120,
  total_receipts: 2,
  processed_receipts: 2,
  closed_receipts: 2,
};
const archivedDatabaseProjection = {
  indexed_total_receipts: 2,
  indexed_processed_receipts: 2,
  indexed_closed_receipts: 2,
  indexed_tile_lamports: ['12', '3', ...Array(23).fill('0')],
  indexed_tile_receipts: [2, 1, ...Array(23).fill(0)],
};

const legacyRandomnessHex = '0a17'.repeat(16);
const legacyRandomnessExact = BigInt(`0x${legacyRandomnessHex}`).toString();

function hashHex(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function u64Le(value) {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64LE(BigInt(value));
  return encoded;
}

const archiveProgramBytes = Buffer.alloc(32, 3);
const archiveMintBytes = Buffer.alloc(32, 4);
const archiveRevealHex = '05'.repeat(32);
const archiveEntropyHex = '06'.repeat(32);
const archiveCommitmentHex = hashHex([
  Buffer.from('MYNE_SERVER_COMMIT_V1'),
  archiveProgramBytes,
  archiveMintBytes,
  u64Le(41),
  Buffer.from(archiveRevealHex, 'hex'),
]);
const archiveServerOutputHex = hashHex([
  Buffer.from('MYNE_SERVER_OUTPUT_V1'),
  archiveProgramBytes,
  archiveMintBytes,
  u64Le(41),
  Buffer.from(archiveRevealHex, 'hex'),
  u64Le(105),
  Buffer.from(archiveEntropyHex, 'hex'),
]);

function legacySnapshot(snapshot) {
  const legacy = structuredClone(snapshot);
  legacy.round.randomness_value = Number(BigInt(`0x${legacy.round.randomness_hex}`)).toString();
  assert.match(legacy.round.randomness_value, /e\+/);
  return legacy;
}

const exactV2Snapshot = buildArchiveSnapshot({
  program: 'program-id',
  round: {
    ...archivedSnapshot.round,
    randomness_hex: legacyRandomnessHex,
    randomness_value: legacyRandomnessExact,
  },
  bets: archivedBets,
  settlements: archivedSettlements,
  buybacks: [],
});
const legacyV2Snapshot = legacySnapshot(exactV2Snapshot);

const exactV3Snapshot = buildArchiveSnapshot({
  program: 'program-id',
  round: {
    ...archivedSnapshot.round,
    randomness_provider_kind: SERVER_PROVIDER_KIND,
    randomness_id: null,
    randomness_commit_slot: null,
    randomness_value: BigInt(`0x${archiveServerOutputHex}`).toString(),
    randomness_hex: archiveServerOutputHex,
    randomness_commitment_hex: archiveCommitmentHex,
    randomness_reveal_hex: archiveRevealHex,
    randomness_target_slot: '101',
    randomness_entropy_slot: '105',
    randomness_entropy_hash_hex: archiveEntropyHex,
    randomness_commitment_signature: 'commit',
    randomness_commitment_tx_slot: '90',
    randomness_lock_signature: 'lock',
    randomness_lock_tx_slot: '100',
    randomness_reveal_signature: 'settle',
    randomness_reveal_tx_slot: '110',
  },
  bets: archivedBets,
  settlements: archivedSettlements,
  buybacks: [],
});
const legacyV3Snapshot = legacySnapshot(exactV3Snapshot);

function verifiedLegacyProjection(snapshot, context = {}) {
  const hash = archiveHash(snapshot);
  return verifiedArchivedRoundProjection({
    programId: 'program-id',
    indexedRound: {
      round_id: 41,
      archive_verified: true,
      archive_hash: hash,
    },
    storedProof: {
      round_id: 41,
      archive_hash: hash,
      canonical_snapshot: snapshot,
    },
    ...context,
  }).roundProjection;
}

test('legacy v2 and v3 scientific randomness snapshots recover exact values from attested hex', () => {
  const v2 = verifiedLegacyProjection(legacyV2Snapshot);
  assert.equal(v2.randomness_value, legacyRandomnessExact);
  const v3 = verifiedLegacyProjection(legacyV3Snapshot, {
    programIdBytes: archiveProgramBytes,
    mintBytes: archiveMintBytes,
  });
  assert.equal(v3.randomness_value, BigInt(`0x${archiveServerOutputHex}`).toString());
});

test('legacy scientific randomness compatibility fails closed on v2 and v3 mismatches', () => {
  for (const [snapshot, context] of [
    [legacyV2Snapshot, {}],
    [legacyV3Snapshot, { programIdBytes: archiveProgramBytes, mintBytes: archiveMintBytes }],
  ]) {
    const mismatch = structuredClone(snapshot);
    mismatch.round.randomness_value = Number(BigInt(`0x${'ff'.repeat(32)}`)).toString();
    assert.throws(
      () => verifiedLegacyProjection(mismatch, context),
      /numeric and hex outputs disagree/,
    );
  }
});

test('randomness projection comparison treats matching legacy JSON numeric output as a no-op', () => {
  assert.equal(randomnessProjectionValueMatches({
    randomness_hex: legacyRandomnessHex,
    randomness_value: Number(legacyRandomnessExact),
  }, {
    randomness_hex: legacyRandomnessHex,
    randomness_value: legacyRandomnessExact,
  }), true);
  assert.equal(randomnessProjectionValueMatches({
    randomness_hex: legacyRandomnessHex,
    randomness_value: Number(BigInt(`0x${'ff'.repeat(32)}`)),
  }, {
    randomness_hex: legacyRandomnessHex,
    randomness_value: legacyRandomnessExact,
  }), false);
  assert.equal(randomnessProjectionValueMatches({
    randomness_hex: 'ff'.repeat(32),
    randomness_value: Number(legacyRandomnessExact),
  }, {
    randomness_hex: legacyRandomnessHex,
    randomness_value: legacyRandomnessExact,
  }), false);
});

test('closed projection recomputes its attested archive participant and settlement digest', () => {
  const digest = archivedSnapshotProjectionDigest(archivedSnapshot);
  assert.equal(digest.indexed_total_receipts, 2n);
  assert.equal(digest.indexed_processed_receipts, 2n);
  assert.deepEqual(digest.indexed_tile_lamports.slice(0, 2), [12n, 3n]);
  assert.deepEqual(digest.indexed_tile_receipts.slice(0, 2), [2n, 1n]);
  const verified = verifiedArchivedRoundProjection({
    programId: 'program-id',
    indexedRound: archivedIndexedRound,
    storedProof: {
      round_id: 41,
      archive_hash: archivedHash,
      canonical_snapshot: archivedSnapshot,
    },
  });
  assert.equal(verified.roundProjection.winning_square, 0);
  assert.equal(verified.roundProjection.total_wager_wei, '15');
  assert.equal(verified.roundProjection.buyback_completed, true);
  assert.equal(roundProjectionMatchesArchivedProof({
    programId: 'program-id',
    indexedRound: archivedIndexedRound,
    storedProof: {
      round_id: 41,
      archive_hash: archivedHash,
      canonical_snapshot: archivedSnapshot,
    },
    indexedProjection: archivedDatabaseProjection,
  }), true);
  assert.equal(roundProjectionMatchesArchivedProof({
    programId: 'program-id',
    indexedRound: {
      ...archivedIndexedRound,
      total_receipts: 0,
      processed_receipts: 0,
      closed_receipts: 0,
    },
    storedProof: {
      round_id: 41,
      archive_hash: archivedHash,
      canonical_snapshot: archivedSnapshot,
    },
    indexedProjection: archivedDatabaseProjection,
  }), false, 'stale materialized counters cannot be labeled complete before atomic repair');
});

test('closed projection fails closed on tampered proof or any participant/lifecycle mismatch', () => {
  const valid = {
    programId: 'program-id',
    indexedRound: archivedIndexedRound,
    storedProof: {
      round_id: 41,
      archive_hash: archivedHash,
      canonical_snapshot: archivedSnapshot,
    },
    indexedProjection: archivedDatabaseProjection,
  };
  const tamperedSnapshot = structuredClone(archivedSnapshot);
  tamperedSnapshot.bets[0].amount_wei = '8';
  assert.equal(roundProjectionMatchesArchivedProof({
    ...valid,
    storedProof: { ...valid.storedProof, canonical_snapshot: tamperedSnapshot },
  }), false);
  assert.equal(roundProjectionMatchesArchivedProof({
    ...valid,
    indexedProjection: { ...archivedDatabaseProjection, indexed_tile_lamports: ['13', '3', ...Array(23).fill('0')] },
  }), false);
  assert.equal(roundProjectionMatchesArchivedProof({
    ...valid,
    indexedProjection: { ...archivedDatabaseProjection, indexed_processed_receipts: 1 },
  }), false);
  assert.equal(roundProjectionMatchesArchivedProof({
    ...valid,
    indexedProjection: { ...archivedDatabaseProjection, indexed_closed_receipts: 1 },
  }), false);
  assert.equal(roundProjectionMatchesArchivedProof({
    ...valid,
    indexedRound: { ...archivedIndexedRound, archive_verified: false },
  }), false);
  assert.equal(roundProjectionMatchesArchivedProof({
    ...valid,
    indexedRound: { ...archivedIndexedRound, closed_signature: null },
  }), false, 'an open or merely archived PDA cannot use the closed-proof path');
  for (const [field, value] of [
    ['resolved', false],
    ['winning_square', 7],
    ['opened_at', '99'],
    ['total_wager_wei', '16'],
    ['pot_for_winners_wei', '11'],
    ['bullion_for_winners_wei', '11'],
    ['total_fee_lamports', '4'],
    ['settlement_signature', 'wrong-settlement'],
    ['buyback_completed', false],
  ]) {
    assert.equal(roundProjectionMatchesArchivedProof({
      ...valid,
      indexedRound: { ...archivedIndexedRound, [field]: value },
    }), false, `stale archived round field ${field} must fail closed`);
  }
  const contradictorySnapshot = structuredClone(archivedSnapshot);
  contradictorySnapshot.settlements.push({
    ...contradictorySnapshot.settlements[0],
    status: 'refunded',
    signature: 'contradictory-refund',
  });
  assert.throws(
    () => archivedSnapshotProjectionDigest(contradictorySnapshot),
    /contradictory lifecycle-final statuses/,
  );
  assert.equal(roundProjectionMatchesArchivedProof({ ...valid, maxRows: 4 }), false,
    'oversized snapshots fail closed instead of creating an unbounded tick');
});
