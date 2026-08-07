import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [source, styles] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wide-dashboards.css', import.meta.url), 'utf8'),
]);

test('Stake and Referrals use explicit two-column dashboard wrappers', () => {
  assert.match(source, /class="staking-dashboard"/);
  assert.match(source, /class="referrals-dashboard"/);
  assert.match(styles, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /width:\s*min\(1320px, calc\(100vw - 48px\)\)/);
});

test('wide dashboards collapse to a single column below the desktop breakpoint', () => {
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.staking-dashboard,[\s\S]*\.referrals-dashboard \{ grid-template-columns: 1fr; \}/);
});
