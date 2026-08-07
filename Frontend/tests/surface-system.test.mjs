import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/surface-system.css', import.meta.url), 'utf8');

test('canonical surface system loads after visual route styles and before viewport geometry', () => {
  const surfaceIndex = main.indexOf("import './surface-system.css'");
  const viewportIndex = main.indexOf("import './viewport-fit.css'");
  assert.ok(surfaceIndex > main.indexOf("import './about-stats.css'"));
  assert.ok(viewportIndex > surfaceIndex);
  assert.equal(main.slice(viewportIndex + 1).includes("import './"), false);
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
  assert.match(styles, /body\[data-route="mine"\] \.slot \{[\s\S]*border:\s*2px solid transparent !important/);
  assert.match(styles, /inset 0 0 0 1px var\(--surface-rule\)/);
  assert.match(styles, /border-color:\s*transparent !important/);
  assert.match(styles, /background:\s*var\(--surface-tile\) !important/);
});

test('interactive mining tiles expose only the spectrum edge', () => {
  assert.match(styles, /\.slot:not\(\.round-winner\):is\(:hover, :focus-visible, \.selected, \.has-position\) \{[\s\S]*box-shadow:\s*none !important;[\s\S]*outline:\s*0 !important/);
  assert.match(styles, /\.slot:focus-visible::after,[\s\S]*\.slot\.has-position::after \{[\s\S]*opacity:\s*1 !important/);
});

test('the mining board remains a transparent layout canvas', () => {
  assert.match(styles, /\.board-panel\.panel \{[\s\S]*background:\s*transparent !important;[\s\S]*box-shadow:\s*none !important/);
  assert.match(styles, /\.board-panel\.panel::after \{[\s\S]*content:\s*none !important;[\s\S]*display:\s*none !important/);
});

test('dashboard cards and supporting data share one route-independent elevation system', () => {
  assert.match(styles, /body\[data-route="stake"\][\s\S]*\.staking-history/);
  assert.match(styles, /body\[data-route="referrals"\][\s\S]*\.referral-link-block/);
  assert.match(styles, /body\[data-route="rounds"\][\s\S]*\.ledger-panel/);
  assert.match(styles, /body\[data-route="about"\][\s\S]*\.about-content/);
  assert.match(styles, /\.about-statline > span/);
  assert.match(styles, /background:\s*var\(--surface-inset\) !important/);
  assert.match(styles, /border-color:\s*var\(--surface-rule\) !important/);
});

test('route-level metric rails sit directly on the page canvas', () => {
  assert.match(styles, /body\[data-route="referrals"\][\s\S]*\.referral-metrics,[\s\S]*body\[data-route="rounds"\][\s\S]*\.feature-metrics \{[\s\S]*background:\s*transparent !important/);
  assert.match(styles, /\.referral-metrics article,[\s\S]*\.feature-metrics article \{[\s\S]*box-shadow:\s*none !important/);
});

test('mining composer has no rectangular card surface', () => {
  assert.match(styles, /body\[data-route="mine"\] \.control-column > \.deploy-panel \{[\s\S]*background:\s*transparent !important/);
  assert.match(styles, /body\[data-route="mine"\] :is\(\.quick-amounts button, \.configuration #all, \.deploy\)[\s\S]*background-color:\s*var\(--surface-control\) !important/);
});

test('round filters use the same solid control surface as the rest of the app', () => {
  assert.match(styles, /body\[data-route="rounds"\] \.feature-shell\[data-page="rounds"\] \.round-filters \{[\s\S]*background:\s*var\(--surface-control\) !important/);
});
