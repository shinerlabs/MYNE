import assert from 'node:assert/strict';
import test from 'node:test';

import { selectLifecycleRoundBatch } from '../scripts/lifecycle-queue-policy.mjs';

test('bounded lifecycle selection shares capacity across every recovery queue', () => {
  const recent = [{ round_id: 10 }, { round_id: 9 }, { round_id: 8 }];
  const unprocessed = [{ round_id: 4 }, { round_id: 3 }, { round_id: 2 }];
  const historical = [{ round_id: 7 }, { round_id: 6 }, { round_id: 5 }];
  const randomness = [{ round_id: 1 }, { round_id: 0 }];
  assert.deepEqual(
    selectLifecycleRoundBatch(8, recent, unprocessed, historical, randomness)
      .map((row) => row.round_id),
    [10, 4, 7, 1, 9, 3, 6, 0],
  );
});

test('bounded lifecycle selection deduplicates overlapping priority queues and fills the batch', () => {
  const recent = [{ round_id: 10 }, { round_id: 9 }];
  const unprocessed = [{ round_id: 10 }, { round_id: 8 }, { round_id: 7 }];
  const historical = [{ round_id: 9 }, { round_id: 6 }];
  assert.deepEqual(
    selectLifecycleRoundBatch(5, recent, unprocessed, historical)
      .map((row) => row.round_id),
    [10, 8, 9, 7, 6],
  );
});

test('bounded lifecycle selection rejects unsafe limits', () => {
  assert.throws(() => selectLifecycleRoundBatch(0, []), /positive integer/);
  assert.throws(() => selectLifecycleRoundBatch(1.5, []), /positive integer/);
});
