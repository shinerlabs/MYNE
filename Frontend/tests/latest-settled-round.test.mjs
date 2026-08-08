import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/chain/rounds-index.js', import.meta.url), 'utf8');

test('latest settled round includes zero-bid results in one bounded indexed read', () => {
  const fn = source.slice(
    source.indexOf('export async function loadLatestSettledRoundId'),
    source.indexOf('/**', source.indexOf('export async function loadLatestSettledRoundId') + 10),
  );
  assert.match(fn, /\.eq\('resolved', true\)/);
  assert.doesNotMatch(fn, /\.gt\('total_wager_wei', 0\)/);
  assert.match(fn, /\.order\('round_id', \{ ascending: false \}\)/);
  assert.match(fn, /\.limit\(1\)/);
  assert.match(fn, /\.lte\('round_id', String\(atOrBefore\)\)/);
});

test('latest played settlement is independently bounded for the miners card', () => {
  const fn = source.slice(
    source.indexOf('export async function loadLatestPlayedSettledRoundId'),
  );
  assert.match(fn, /\.eq\('resolved', true\)/);
  assert.match(fn, /\.gt\('total_wager_wei', 0\)/);
  assert.match(fn, /\.order\('round_id', \{ ascending: false \}\)/);
  assert.match(fn, /\.limit\(1\)/);
  assert.match(fn, /\.lte\('round_id', String\(atOrBefore\)\)/);
});
