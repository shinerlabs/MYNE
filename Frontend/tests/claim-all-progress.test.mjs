import assert from 'node:assert/strict';
import test from 'node:test';

import { executeClaimChunks } from '../src/chain/lottery.js';

const roundClaims = (roundIds) => roundIds.map((roundId, index) => ({
  roundId: BigInt(roundId),
  instruction: `claim-${index}`,
}));

const remainingClaims = (roundIds) => roundIds.map((roundId) => ({
  account: { roundId: BigInt(roundId) },
}));

async function failedChunkScenario({ failChunk, remaining }) {
  const requestedRoundIds = Array.from({ length: 9 }, (_, index) => BigInt(index + 1));
  let chunkIndex = 0;
  const failure = new Error(`wallet failed at chunk ${failChunk + 1}`);
  const outcome = await executeClaimChunks({
    requestedRoundIds,
    claims: roundClaims(requestedRoundIds),
    chunkSize: 4,
    sendChunk: async () => {
      const current = chunkIndex++;
      if (current === failChunk) throw failure;
      return `signature-${current}`;
    },
    reconcileRemaining: async () => remainingClaims(remaining),
  });
  return { outcome, failure };
}

test('a first receipt chunk failure reports no false progress', async () => {
  const { outcome, failure } = await failedChunkScenario({
    failChunk: 0,
    remaining: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n],
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.signature, null);
  assert.equal(outcome.confirmedReceiptCount, 0);
  assert.deepEqual(outcome.processedRoundIds, []);
  assert.deepEqual(outcome.remainingRoundIds, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
  assert.equal(outcome.failure, failure);
  assert.equal(outcome.reconciled, true);
});

test('a middle receipt chunk failure preserves the first confirmed chunk', async () => {
  const { outcome, failure } = await failedChunkScenario({
    failChunk: 1,
    remaining: [5n, 6n, 7n, 8n, 9n],
  });

  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.signature, 'signature-0');
  assert.equal(outcome.confirmedReceiptCount, 4);
  assert.deepEqual(outcome.processedRoundIds, [1n, 2n, 3n, 4n]);
  assert.deepEqual(outcome.remainingRoundIds, [5n, 6n, 7n, 8n, 9n]);
  assert.equal(outcome.failure, failure);
});

test('four confirmed receipts do not complete a round while its fifth receipt remains', async () => {
  let chunkIndex = 0;
  const failure = new Error('wallet rejected the final receipt');
  const outcome = await executeClaimChunks({
    requestedRoundIds: [42n],
    claims: roundClaims([42n, 42n, 42n, 42n, 42n]),
    chunkSize: 4,
    sendChunk: async () => {
      if (chunkIndex++ === 1) throw failure;
      return 'signature-first-four-receipts';
    },
    reconcileRemaining: async () => remainingClaims([42n]),
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.signature, 'signature-first-four-receipts');
  assert.equal(outcome.confirmedReceiptCount, 4);
  assert.deepEqual(outcome.processedRoundIds, []);
  assert.deepEqual(outcome.remainingRoundIds, [42n]);
  assert.equal(outcome.failure, failure);
});

test('a final receipt chunk failure preserves every earlier confirmed chunk', async () => {
  const { outcome, failure } = await failedChunkScenario({
    failChunk: 2,
    remaining: [9n],
  });

  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.signature, 'signature-1');
  assert.equal(outcome.confirmedReceiptCount, 8);
  assert.deepEqual(outcome.processedRoundIds, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
  assert.deepEqual(outcome.remainingRoundIds, [9n]);
  assert.equal(outcome.failure, failure);
});

test('keeper/user races use the confirmed ledger and count each round once', async () => {
  const failure = new Error('receipt was already processed by keeper');
  let chunkIndex = 0;
  const outcome = await executeClaimChunks({
    requestedRoundIds: [1n, 1n, 2n, 3n],
    claims: roundClaims([1n, 1n, 2n, 3n]),
    chunkSize: 2,
    sendChunk: async () => {
      const current = chunkIndex++;
      if (current === 1) throw failure;
      return 'signature-user-round-1';
    },
    // Both receipts for round 1 were confirmed by the user. The keeper won
    // round 2 concurrently; only round 3 remains actionable after the rescan.
    reconcileRemaining: async () => remainingClaims([3n]),
  });

  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.confirmedReceiptCount, 2);
  assert.deepEqual(outcome.processedRoundIds, [1n, 2n]);
  assert.deepEqual(outcome.remainingRoundIds, [3n]);
  assert.equal(outcome.processedRoundIds.length, 2);
});

test('a keeper completing every receipt during a failed user chunk is complete', async () => {
  const outcome = await executeClaimChunks({
    requestedRoundIds: [11n, 12n],
    claims: roundClaims([11n, 12n]),
    sendChunk: async () => { throw new Error('receipt no longer actionable'); },
    reconcileRemaining: async () => [],
  });

  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.confirmedReceiptCount, 0);
  assert.deepEqual(outcome.processedRoundIds, [11n, 12n]);
  assert.deepEqual(outcome.remainingRoundIds, []);
});

test('a failed reconciliation preserves only progress proven by confirmed chunks', async () => {
  let chunkIndex = 0;
  const outcome = await executeClaimChunks({
    requestedRoundIds: [21n, 22n, 23n],
    claims: roundClaims([21n, 22n, 23n]),
    chunkSize: 2,
    sendChunk: async () => {
      if (chunkIndex++ === 1) throw new Error('wallet rejected second chunk');
      return 'signature-first-chunk';
    },
    reconcileRemaining: async () => { throw new Error('RPC unavailable'); },
  });

  assert.equal(outcome.status, 'unverified');
  assert.equal(outcome.reconciled, false);
  assert.equal(outcome.confirmedReceiptCount, 2);
  assert.deepEqual(outcome.processedRoundIds, [21n, 22n]);
  assert.deepEqual(outcome.remainingRoundIds, [23n]);
});
