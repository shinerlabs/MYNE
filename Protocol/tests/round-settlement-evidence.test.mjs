import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyFinalizedRoundSettlementEvidence,
  findFinalizedRoundSettlementEvidence,
} from '../scripts/round-settlement-evidence.mjs';

const ROUND_ADDRESS = { toBase58: () => 'RoundAddress1111111111111111111111111111111' };
const parser = { parseLogs: (logs) => logs };

const connectionWith = ({ rows, transactions }) => ({
  getSignaturesForAddress: async () => rows,
  getTransaction: async (signature) => transactions[signature] || null,
});

test('restart recovery finds only the exact finalized RoundSettled event', async () => {
  const evidence = await findFinalizedRoundSettlementEvidence({
    connection: connectionWith({
      rows: [
        { signature: 'newer-unrelated', err: null },
        { signature: 'exact-settlement', err: null },
      ],
      transactions: {
        'newer-unrelated': {
          slot: 10,
          blockTime: 1_064,
          meta: { err: null, logMessages: [{ name: 'RoundSettled', data: { round_id: 40 } }] },
        },
        'exact-settlement': {
          slot: 9,
          blockTime: 1_064,
          meta: { err: null, logMessages: [{ name: 'roundSettled', data: { round_id: 41 } }] },
        },
      },
    }),
    eventParser: parser,
    roundAddress: ROUND_ADDRESS,
    roundId: 41n,
    pageSize: 10,
  });
  assert.deepEqual(evidence, {
    roundId: '41',
    signature: 'exact-settlement',
    slot: 9,
    blockTime: 1_064,
  });
  assert.deepEqual(classifyFinalizedRoundSettlementEvidence({
    evidence,
    roundId: 41n,
    resultDeadlineAt: 1_065,
  }), { deadlineMet: true, outcome: 'exact-settlement' });
});

test('restart recovery fails closed for a late settlement or unavailable evidence', async () => {
  const late = classifyFinalizedRoundSettlementEvidence({
    evidence: {
      roundId: '41', signature: 'late-settlement', slot: 11, blockTime: 1_065,
    },
    roundId: 41n,
    resultDeadlineAt: 1_065,
  });
  assert.equal(late.deadlineMet, false);
  assert.match(late.outcome, /confirmed-at:1065;deadline-exclusive:1065/);

  const unavailable = classifyFinalizedRoundSettlementEvidence({
    evidence: null,
    roundId: 41n,
    resultDeadlineAt: 1_065,
  });
  assert.equal(unavailable.deadlineMet, false);
  assert.match(unavailable.outcome, /evidence-unavailable/);

  const missing = await findFinalizedRoundSettlementEvidence({
    connection: connectionWith({
      rows: [{ signature: 'other-round', err: null }],
      transactions: {
        'other-round': {
          slot: 12,
          blockTime: 1_064,
          meta: { err: null, logMessages: [{ name: 'RoundSettled', data: { round_id: 40 } }] },
        },
      },
    }),
    eventParser: parser,
    roundAddress: ROUND_ADDRESS,
    roundId: 41n,
    pageSize: 10,
  });
  assert.equal(missing, null);
});

test('restart recovery rejects exact settlement evidence without finalized block time', async () => {
  await assert.rejects(
    findFinalizedRoundSettlementEvidence({
      connection: connectionWith({
        rows: [{ signature: 'missing-time', err: null }],
        transactions: {
          'missing-time': {
            slot: 13,
            blockTime: null,
            meta: { err: null, logMessages: [{ name: 'RoundSettled', data: { round_id: 41 } }] },
          },
        },
      }),
      eventParser: parser,
      roundAddress: ROUND_ADDRESS,
      roundId: 41n,
      pageSize: 10,
    }),
    /has no block time/,
  );
});
