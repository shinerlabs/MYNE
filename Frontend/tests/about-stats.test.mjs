import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sparklinePath } from '../src/about-stats.js';

const [source, styles] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/about-stats.css', import.meta.url), 'utf8'),
]);
const renderer = await readFile(new URL('../src/about-stats.js', import.meta.url), 'utf8');

test('About exposes a dedicated Stats chapter', () => {
  assert.match(source, /data-about-section="stats">Stats</);
  assert.match(source, /data-about-panel="stats"/);
  assert.match(source, /stats:\s*`[\s\S]*Protocol stats/);
  assert.match(source, /stats:\s*'Stats'/);
});

test('Stats covers market, mining, staking and supply with a chart on every row', () => {
  for (const group of ['Market', 'Mining', 'Staking', 'Supply']) {
    assert.match(source, new RegExp(`statsGroup\\('${group}'`));
  }
  const rows = [...source.matchAll(/statsRow\('([^']+)'/g)].map((match) => match[1]);
  assert.equal(rows.length, 16);
  assert.equal(new Set(rows).size, rows.length);
  assert.match(source, /data-stat-line/);
  assert.match(styles, /\.protocol-stat-row\s*\{[\s\S]*grid-template-columns:/);
});

test('Stats uses indexed mining reads and refreshes only while its chapter is active', () => {
  assert.match(source, /loadIndexedRounds\(\{ page: 0, pageSize: 24/);
  assert.match(source, /target === 'stats'[\s\S]*refreshProtocolStats/);
  assert.match(source, /data-about-panel="stats"\]\.active/);
});

test('Stats grid collapses to one column on narrow screens', () => {
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.protocol-stats-grid \{ grid-template-columns: 1fr;/);
});

test('sparkline paths are finite for flat and changing histories', () => {
  const flat = sparklinePath([5]);
  const changing = sparklinePath([1, 4, 2, 7]);
  assert.match(flat, /^M/);
  assert.match(changing, /^M/);
  assert.doesNotMatch(flat + changing, /NaN|Infinity/);
  assert.equal((flat.match(/L/g) || []).length, 1);
  assert.equal((changing.match(/L/g) || []).length, 3);
});

test('missing live metrics are labelled unavailable instead of looking like zero or broken data', () => {
  assert.match(renderer, /value\.textContent = 'Unavailable'/);
  assert.match(renderer, /aria-label[^\n]+unavailable/);
  assert.match(styles, /\.protocol-stat-row\.unavailable \.protocol-stat-value[\s\S]*text-transform: uppercase/);
});
