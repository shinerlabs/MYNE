import assert from 'node:assert/strict';
import test from 'node:test';

import { roundIdsForRange } from '../src/chain/round-range.js';

test('round history scans newest to oldest when requested by the Rounds page', () => {
  assert.deepEqual(roundIdsForRange(4n, 0n), {
    ids: [4n, 3n, 2n, 1n, 0n],
    truncated: false,
  });
});

test('round history supports ascending callers and reports its scan cap', () => {
  assert.deepEqual(roundIdsForRange(-3n, 3n), {
    ids: [0n, 1n, 2n, 3n],
    truncated: false,
  });
  assert.deepEqual(roundIdsForRange(9n, 0n, 3), {
    ids: [9n, 8n, 7n],
    truncated: true,
  });
});
