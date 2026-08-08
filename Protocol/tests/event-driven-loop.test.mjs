import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  WORKER_HEARTBEAT_TYPE,
  createWakeSignal,
  createWorkerHeartbeat,
  recordWorkerHeartbeat,
  runWorkerTick,
  workerHeartbeatFresh,
} from '../scripts/event-driven-loop.mjs';

test('worker heartbeat is authenticated to its expected child and expires locally', () => {
  const status = { running: true, lastHeartbeatAt: 1_000 };
  const message = createWorkerHeartbeat('round-indexer', 'tick-complete', 'ok', 5_000);
  assert.equal(message.type, WORKER_HEARTBEAT_TYPE);
  assert.equal(recordWorkerHeartbeat(status, message, {
    expectedWorker: 'round-lifecycle',
    receivedAt: 6_000,
  }), false);
  assert.equal(status.lastHeartbeatAt, 1_000);
  assert.equal(recordWorkerHeartbeat(status, message, {
    expectedWorker: 'round-indexer',
    receivedAt: 6_000,
  }), true);
  assert.equal(status.lastCompletedAt, 6_000);
  assert.equal(status.lastOutcome, 'ok');
  assert.equal(workerHeartbeatFresh(status, { now: 65_999, maxAgeMs: 60_000 }), true);
  assert.equal(workerHeartbeatFresh(status, { now: 66_001, maxAgeMs: 60_000 }), false);
  status.running = false;
  assert.equal(workerHeartbeatFresh(status, { now: 6_000, maxAgeMs: 60_000 }), false);
});

test('event received during work wakes the next loop without waiting for the fallback timer', async () => {
  const wake = createWakeSignal();
  wake.signal();
  assert.equal(await wake.wait(10_000), 'event');
});

test('wake signal resolves a worker that is currently waiting', async () => {
  const wake = createWakeSignal();
  const waiting = wake.wait(10_000);
  queueMicrotask(() => wake.signal());
  assert.equal(await waiting, 'event');
});

test('fallback timeout remains available when websocket delivery is absent', async () => {
  const wake = createWakeSignal();
  assert.equal(await wake.wait(5), 'timeout');
});

test('worker watchdog returns a completed cycle and clears its deadline', async () => {
  let cleared = false;
  const result = await runWorkerTick({
    worker: 'test-worker',
    timeoutMs: 100,
    task: async () => ({ ok: true }),
    onTimeout: () => assert.fail('completed work must not time out'),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => { cleared = true; },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(cleared, true);
});

test('worker watchdog invokes the supervisor exit hook when a cycle stalls', async () => {
  let fireTimeout = null;
  let timedOut = null;
  const pending = runWorkerTick({
    worker: 'stalled-worker',
    timeoutMs: 100,
    task: () => new Promise(() => {}),
    onTimeout: (error) => { timedOut = error; },
    setTimer: (callback) => {
      fireTimeout = callback;
      return { unref() {} };
    },
    clearTimer: () => {},
  });
  await Promise.resolve();
  fireTimeout();
  await assert.rejects(pending, { code: 'WORKER_TICK_TIMEOUT' });
  assert.equal(timedOut?.message, 'stalled-worker tick exceeded 100ms');
});

test('indexer and lifecycle workers wake from confirmed program logs with timed recovery', async () => {
  const [indexer, lifecycle] = await Promise.all([
    readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/round-lifecycle-keeper.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(indexer, /attachProgramWake\(\{ connection: provider\.connection, programId: PROGRAM_ID, wake \}\)/);
  assert.match(indexer, /runWorkerTick\(\{[\s\S]*worker: 'round-indexer'/);
  assert.match(indexer, /wake\.wait\(intervalMs\)[\s\S]*sleep\(realtimeDebounceMs\)/);
  assert.match(lifecycle, /attachProgramWake\(\{[\s\S]*followUpDelays: \[750, 2_000\]/);
  assert.match(lifecycle, /runWorkerTick\(\{[\s\S]*worker: 'round-lifecycle'/);
  assert.match(lifecycle, /wake\.wait\(intervalMs\)[\s\S]*sleep\(realtimeDebounceMs\)/);
});
