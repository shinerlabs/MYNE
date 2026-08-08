import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVIDER_PREPARATION_LEAD_SECONDS,
  PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS,
  firstSafeResumeRoundId,
  roundIdsToPrepare,
} from '../scripts/round-schedule-policy.mjs';

const schedule = (now) => roundIdsToPrepare({
  now,
  initializedAt: 1_000,
  roundDurationSeconds: 65,
});

test('provider preparation mirrors the on-chain 60-second bounded lead', () => {
  assert.equal(PROVIDER_PREPARATION_LEAD_SECONDS, 60);
  assert.equal(PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS, 2);
  assert.deepEqual(schedule(999), []);
  assert.deepEqual(schedule(1_000), [0]);
  assert.deepEqual(schedule(1_004), [0]);
  // Round 1 opens at 1065. Its on-chain preparation window begins at 1005,
  // but the host waits two seconds so Solana Clock cannot still be at 1004.
  assert.deepEqual(schedule(1_005), [0]);
  assert.deepEqual(schedule(1_006), [0]);
  assert.deepEqual(schedule(1_007), [0, 1]);
  assert.deepEqual(schedule(1_064), [0, 1]);
  assert.deepEqual(schedule(1_065), [1]);
  assert.deepEqual(schedule(1_070), [1]);
  assert.deepEqual(schedule(1_072), [1, 2]);
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
  assert.throws(() => roundIdsToPrepare({
    now: 1_000,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    preparationSafetyMarginSeconds: 60,
  }), /fit inside/);
});

test('paused-to-live recovery chooses only a future round with a safe prebind window', () => {
  const resume = (now) => firstSafeResumeRoundId({
    now,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    nextRoundPrebindGraceSeconds: 15,
  });

  assert.equal(resume(999), 0);
  assert.equal(resume(1_000), 1);
  assert.equal(resume(1_021), 1);
  // Round 1's safe prebind deadline is 1022. At the boundary it is skipped;
  // round 2 will receive an intact preparation window and full betting time.
  assert.equal(resume(1_022), 2);
  assert.equal(resume(1_064), 2);
  assert.equal(resume(1_065), 2);
  assert.equal(resume(1_086), 2);
  assert.equal(resume(1_087), 3);
});

test('resume scheduling fails closed when the safe lead is invalid', () => {
  assert.throws(() => firstSafeResumeRoundId({
    now: 1_000,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    nextRoundPrebindGraceSeconds: 58,
  }), /fit inside/);
  assert.throws(() => firstSafeResumeRoundId({
    now: 1_000.5,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    nextRoundPrebindGraceSeconds: 15,
  }), /safe integer/);
});
