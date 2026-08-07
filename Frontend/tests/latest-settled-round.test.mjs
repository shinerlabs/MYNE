import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/chain/rounds-index.js', import.meta.url), 'utf8');

test('latest played round uses one bounded indexed read', () => {
  const fn = source.slice(
    source.indexOf('export async function loadLatestSettledRoundId'),
    source.indexOf('/**', source.indexOf('export async function loadLatestSettledRoundId') + 10),
  );
  assert.match(fn, /\.eq\('resolved', true\)/);
  assert.match(fn, /\.gt\('total_wager_wei', 0\)/);
  assert.match(fn, /\.order\('round_id', \{ ascending: false \}\)/);
  assert.match(fn, /\.limit\(1\)/);
  assert.match(fn, /\.lte\('round_id', String\(atOrBefore\)\)/);
});
