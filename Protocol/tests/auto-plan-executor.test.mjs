import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeAutoPlansDuringWindow,
  fetchActiveAutoPlanAuthorities,
  sendAutoPlanBatchesIsolated,
} from '../scripts/auto-plan-executor.mjs';

test('active Auto Mine plans are read in bounded stable pages and deduplicated', async () => {
  const paths = [];
  const pages = [
    [{ authority: 'A' }, { authority: 'B' }],
    [{ authority: 'B' }, { authority: 'C' }],
    [],
  ];
  const authorities = await fetchActiveAutoPlanAuthorities({
    pageSize: 2,
    indexedRows: async (path) => { paths.push(path); return pages.shift(); },
  });
  assert.deepEqual(authorities, ['A', 'B', 'C']);
  assert.match(paths[0], /balance_lamports=gt\.0/);
  assert.match(paths[0], /limit=2&offset=0$/);
  assert.match(paths[1], /limit=2&offset=2$/);
});

test('one stale plan is bisected away without skipping valid neighbours', async () => {
  const sent = [];
  const events = [];
  await sendAutoPlanBatchesIsolated({
    entries: ['good-1', 'bad', 'good-2'].map((authority) => ({ authority, ix: authority })),
    batchSize: 3,
    sendBatch: async (batch) => {
      if (batch.some(({ authority }) => authority === 'bad')) throw new Error('stale plan');
      sent.push(...batch.map(({ authority }) => authority));
      return { signature: `sig-${sent.length}` };
    },
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(sent, ['good-1', 'good-2']);
  assert.ok(events.some(({ event, authority }) => event === 'auto-plan-execution-failed' && authority === 'bad'));
});

test('Auto Mine retries across the betting window and picks up a late indexed plan', async () => {
  let now = 0;
  let buildCalls = 0;
  const sent = [];
  await executeAutoPlansDuringWindow({
    bettingEndsAt: 11,
    nowSeconds: async () => now,
    sleep: async (milliseconds) => { now += milliseconds / 1_000; },
    indexedRows: async () => [{ authority: 'late-wallet' }],
    buildEntry: async ({ authority }) => (++buildCalls < 2 ? null : { authority, ix: 'ix' }),
    sendBatch: async (batch) => { sent.push(...batch); return { signature: 'sig' }; },
    retryMs: 5_000,
  });
  assert.ok(buildCalls >= 2);
  assert.ok(sent.some(({ authority }) => authority === 'late-wallet'));
  assert.ok(now >= 11);
});
