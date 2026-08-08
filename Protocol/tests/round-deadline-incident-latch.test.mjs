import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ROUND_DEADLINE_VIOLATION_STAGES,
  createRoundDeadlineIncidentLatch,
  safeRoundDeadlineIncidentPath,
} from '../scripts/round-deadline-incident-latch.mjs';

const PROGRAM_ID = 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e';

test('deadline incident survives restart until its exact acknowledgement clears it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'myne-round-incidents-'));
  try {
    const latch = await createRoundDeadlineIncidentLatch({ dataDir: root, programId: PROGRAM_ID });
    const recorded = latch.record({
      roundId: 1_234,
      stage: 'settlement-deadline-missed',
      outcome: 'confirmed-at:1065;deadline-exclusive:1065',
      observedAt: 10_000,
    });
    assert.equal(recorded.created, true);
    await recorded.persisted;
    assert.equal((await stat(latch.path)).mode & 0o777, 0o600);

    const restarted = await createRoundDeadlineIncidentLatch({ dataDir: root, programId: PROGRAM_ID });
    assert.deepEqual(restarted.activeIncidents(), [recorded.incident]);
    const duplicate = restarted.record({
      roundId: 1_234,
      stage: 'settlement-deadline-missed',
      outcome: 'a later duplicate observation',
      observedAt: 10_100,
    });
    assert.equal(duplicate.created, false);
    await duplicate.persisted;
    assert.deepEqual(restarted.activeIncidents(), [recorded.incident]);

    await assert.rejects(
      restarted.clearExact(`${recorded.incident.id}-typo`, { clearedAt: 11_000 }),
      /does not match this incident history/,
    );
    const cleared = await restarted.clearExact(recorded.incident.id, { clearedAt: 11_000 });
    assert.equal(cleared.id, recorded.incident.id);
    assert.equal(cleared.clearedAt, 11_000);

    const afterClear = await createRoundDeadlineIncidentLatch({ dataDir: root, programId: PROGRAM_ID });
    assert.deepEqual(afterClear.activeIncidents(), []);
    assert.equal(afterClear.history()[0].clearedAt, 11_000);
    const idempotent = await afterClear.clearExact(recorded.incident.id, { clearedAt: 12_000 });
    assert.equal(idempotent.alreadyCleared, true);

    const recurrence = afterClear.record({
      roundId: 1_234,
      stage: 'settlement-deadline-missed',
      outcome: 'new reviewed incident',
      observedAt: 13_000,
    });
    await recurrence.persisted;
    assert.notEqual(recurrence.incident.id, recorded.incident.id);
    await afterClear.clearExact(recorded.incident.id, { clearedAt: 14_000 });
    assert.equal(afterClear.activeIncidents()[0].id, recurrence.incident.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed persistence remains active in memory and retries durably', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'myne-round-incident-failure-'));
  const root = join(parent, 'volume');
  try {
    const latch = await createRoundDeadlineIncidentLatch({ dataDir: root, programId: PROGRAM_ID });
    await rm(root, { recursive: true, force: true });
    await writeFile(root, 'not-a-directory', 'utf8');

    const failed = latch.record({
      roundId: 77,
      stage: 'lock-deadline-missed',
      outcome: 'disk unavailable',
      observedAt: 20_000,
    });
    await assert.rejects(failed.persisted);
    assert.equal(latch.activeIncidents().length, 1);
    await assert.rejects(latch.flush());

    await rm(root, { force: true });
    await mkdir(root, { recursive: true });
    const retry = latch.record({
      roundId: 77,
      stage: 'lock-deadline-missed',
      outcome: 'duplicate triggers retry',
      observedAt: 20_100,
    });
    assert.equal(retry.created, false);
    await retry.persisted;
    await latch.flush();
    const restarted = await createRoundDeadlineIncidentLatch({ dataDir: root, programId: PROGRAM_ID });
    assert.equal(restarted.activeIncidents()[0].id, failed.incident.id);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('incident latch rejects unsafe paths, foreign state, and unknown stages', async () => {
  assert.throws(() => safeRoundDeadlineIncidentPath('relative/path'), /must be absolute/);
  assert.throws(() => safeRoundDeadlineIncidentPath('/'), /cannot be the filesystem root/);
  assert.deepEqual([...ROUND_DEADLINE_VIOLATION_STAGES].sort(), [
    'lock-deadline-missed',
    'next-prebind-deadline-missed',
    'prepare-deadline-missed',
    'settlement-deadline-missed',
  ]);

  const root = await mkdtemp(join(tmpdir(), 'myne-round-incident-invalid-'));
  try {
    const latch = await createRoundDeadlineIncidentLatch({ dataDir: root, programId: PROGRAM_ID });
    assert.throws(() => latch.record({
      roundId: 1,
      stage: 'not-a-real-deadline',
      observedAt: 1,
    }), /stage is invalid/);
    const document = JSON.parse(await readFile(latch.path, 'utf8').catch(() => '{"missing":true}'));
    assert.equal(document.missing, true, 'An empty latch should not create an incident file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
