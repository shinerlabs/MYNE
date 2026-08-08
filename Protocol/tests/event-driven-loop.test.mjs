import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createWakeSignal } from '../scripts/event-driven-loop.mjs';

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

test('indexer and lifecycle workers wake from confirmed program logs with timed recovery', async () => {
  const [indexer, lifecycle] = await Promise.all([
    readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/round-lifecycle-keeper.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(indexer, /attachProgramWake\(\{ connection: provider\.connection, programId: PROGRAM_ID, wake \}\)/);
  assert.match(indexer, /wake\.wait\(intervalMs\)/);
  assert.match(lifecycle, /attachProgramWake\(\{[\s\S]*followUpDelays: \[750, 2_000\]/);
  assert.match(lifecycle, /wake\.wait\(intervalMs\)/);
});
