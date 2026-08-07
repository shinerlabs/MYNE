import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/surface-system.css', import.meta.url), 'utf8');

test('canonical surface system loads after route-specific styles', () => {
  const surfaceIndex = main.indexOf("import './surface-system.css'");
  assert.ok(surfaceIndex > main.indexOf("import './about-stats.css'"));
  assert.equal(main.slice(surfaceIndex + 1).includes("import './"), false);
});

test('surface hierarchy distinguishes page, cards, controls and tiles', () => {
  assert.match(styles, /--surface-page:\s*#090909/);
  assert.match(styles, /--surface-panel:\s*linear-gradient/);
  assert.match(styles, /--surface-control:\s*#1b1b1d/);
  assert.match(styles, /--surface-tile:\s*linear-gradient/);
  assert.match(styles, /--surface-radius-panel:\s*16px/);
  assert.match(styles, /--surface-text-secondary:\s*#b8bac0/);
});

test('empty mining tiles use the neutral tile layer while brand states remain excluded', () => {
  assert.match(styles, /\.slot:not\(\.selected\):not\(\.has-position\):not\(\.round-winner\)/);
  assert.match(styles, /border-color:\s*var\(--surface-rule-strong\) !important/);
  assert.match(styles, /background:\s*var\(--surface-tile\) !important/);
});

test('dashboard cards and supporting data share one route-independent elevation system', () => {
  assert.match(styles, /body\[data-route="stake"\][\s\S]*\.staking-history/);
  assert.match(styles, /body\[data-route="referrals"\][\s\S]*\.referral-metrics/);
  assert.match(styles, /body\[data-route="rounds"\][\s\S]*\.ledger-panel/);
  assert.match(styles, /body\[data-route="about"\][\s\S]*\.about-content/);
  assert.match(styles, /\.about-statline > span/);
  assert.match(styles, /background:\s*var\(--surface-inset\) !important/);
  assert.match(styles, /border-color:\s*var\(--surface-rule\) !important/);
});

test('round filters use the same solid control surface as the rest of the app', () => {
  assert.match(styles, /body\[data-route="rounds"\] \.feature-shell\[data-page="rounds"\] \.round-filters \{[\s\S]*background:\s*var\(--surface-control\) !important/);
});
