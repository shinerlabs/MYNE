import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { roundIdsForRange } from '../src/chain/round-range.js';

const indexedReader = await readFile(new URL('../src/chain/rounds-index.js', import.meta.url), 'utf8');

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

test('paused round history counts indexed records instead of advancing with wall-clock ids', () => {
  assert.match(indexedReader, /from\('mine_rounds'\)[\s\S]*select\('round_id', \{ count: 'exact' \}\)[\s\S]*range\(0, 0\)/);
  assert.match(indexedReader, /const total = totalRounds\.count \?\? 0/);
  assert.match(indexedReader, /summary: \{ count: total, mined, deployed, minted, jackpots \}/);
  assert.doesNotMatch(indexedReader, /total:\s*currentRoundId > 0n/);
});
