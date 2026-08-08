import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATION_TIMEOUT_CODE,
  autoPlanExecutionFunding,
  executeAutoPlansDuringWindow,
  fetchActiveAutoPlanAuthorities,
  sendAutoPlanBatchesIsolated,
  withOperationTimeout,
} from '../scripts/auto-plan-executor.mjs';

test('external Auto Mine operations have a hard timeout boundary', async () => {
  let timeoutCallback = false;
  await assert.rejects(
    withOperationTimeout(() => new Promise(() => {}), {
      timeoutMs: 5,
      label: 'stalled dependency',
      onTimeout: () => { timeoutCallback = true; },
    }),
    (error) => error.code === OPERATION_TIMEOUT_CODE && /stalled dependency/.test(error.message),
  );
  assert.equal(timeoutCallback, true);
});

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
  assert.match(paths[0], /or=\(balance_lamports\.gt\.0,reward_mode\.gte\.2\)/);
  assert.match(paths[0], /limit=2&offset=0$/);
  assert.match(paths[1], /limit=2&offset=2$/);
});

test('only explicit composite-mode consent makes claimable SOL executable plan funding', () => {
  const optedOut = autoPlanExecutionFunding({
    rewardMode: 1,
    balanceLamports: 40n,
    pendingSol: 70n,
    requiredLamports: 100n,
  });
  assert.deepEqual(optedOut, {
    reinvestSol: false,
    pendingSol: 0n,
    availableLamports: 40n,
    executable: false,
  });

  const optedIn = autoPlanExecutionFunding({
    rewardMode: 3,
    balanceLamports: 40n,
    pendingSol: 70n,
    requiredLamports: 100n,
  });
  assert.deepEqual(optedIn, {
    reinvestSol: true,
    pendingSol: 70n,
    availableLamports: 110n,
    executable: true,
  });
  assert.throws(() => autoPlanExecutionFunding({
    rewardMode: 4,
    balanceLamports: 0n,
    pendingSol: 0n,
    requiredLamports: 1n,
  }), /reward mode is invalid/);
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

test('Auto Mine stops submitting as soon as the betting window closes', async () => {
  let submitted = false;
  const events = [];
  await sendAutoPlanBatchesIsolated({
    entries: [{ authority: 'too-late', ix: 'ix' }],
    batchSize: 1,
    canSend: async () => false,
    sendBatch: async () => { submitted = true; },
    onEvent: (event) => events.push(event),
  });
  assert.equal(submitted, false);
  assert.deepEqual(events, [{ event: 'auto-plan-window-closed', skipped: 1 }]);
});

test('an indeterminate timed-out Auto Mine send is not immediately resubmitted', async () => {
  let sends = 0;
  const events = [];
  await sendAutoPlanBatchesIsolated({
    entries: ['one', 'two', 'three'].map((authority) => ({ authority, ix: authority })),
    batchSize: 3,
    operationTimeoutMs: 5,
    sendBatch: async () => {
      sends += 1;
      return new Promise(() => {});
    },
    onEvent: (event) => events.push(event),
  });
  assert.equal(sends, 1);
  assert.deepEqual(events[0].authorities, ['one', 'two', 'three']);
  assert.equal(events[0].event, 'auto-plan-batch-indeterminate');
});

test('the full-window executor preserves the separately bounded send budget', async () => {
  let now = 0;
  const events = [];
  await executeAutoPlansDuringWindow({
    bettingEndsAt: 1,
    nowSeconds: async () => now,
    sleep: async () => {},
    indexedRows: async () => [{ authority: 'wallet' }],
    buildEntry: async ({ authority }) => ({ authority, ix: 'ix' }),
    sendBatch: async () => {
      now = 1;
      await new Promise((resolve) => setTimeout(resolve, 550));
      return { signature: 'confirmed' };
    },
    operationTimeoutMs: 500,
    sendTimeoutMs: 2_000,
    onEvent: (event) => events.push(event),
  });
  assert.equal(events.some(({ event }) => event === 'auto-plans-executed'), true);
  assert.equal(events.some(({ event }) => event === 'auto-plan-batch-indeterminate'), false);
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
