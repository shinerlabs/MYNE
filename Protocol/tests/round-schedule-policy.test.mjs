import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_PREPARATION_LEAD_SECONDS,
  roundIdsToPrepare,
} from '../scripts/round-schedule-policy.mjs';

const schedule = (now) => roundIdsToPrepare({
  now,
  initializedAt: 1_000,
  roundDurationSeconds: 65,
});

test('provider preparation mirrors the on-chain 60-second bounded lead', () => {
  assert.equal(PROVIDER_PREPARATION_LEAD_SECONDS, 60);
  assert.deepEqual(schedule(999), []);
  assert.deepEqual(schedule(1_000), [0]);
  assert.deepEqual(schedule(1_004), [0]);
  // Round 1 opens at 1065, so its earliest provider-only preparation second
  // is 1005 while round 0 still has all of its own betting time remaining.
  assert.deepEqual(schedule(1_005), [0, 1]);
  assert.deepEqual(schedule(1_064), [0, 1]);
  assert.deepEqual(schedule(1_065), [1]);
  assert.deepEqual(schedule(1_070), [1, 2]);
});

test('invalid scheduling parameters fail closed', () => {
  assert.throws(() => roundIdsToPrepare({
    now: 1_000,
    initializedAt: 1_000,
    roundDurationSeconds: 60,
  }), /inside one round/);
  assert.throws(() => roundIdsToPrepare({
    now: 1_000.5,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
  }), /safe integer/);
});
