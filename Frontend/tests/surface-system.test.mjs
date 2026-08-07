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
});

test('empty mining tiles use the neutral tile layer while brand states remain excluded', () => {
  assert.match(styles, /\.slot:not\(\.selected\):not\(\.has-position\):not\(\.round-winner\)/);
  assert.match(styles, /border-color:\s*var\(--surface-rule-strong\) !important/);
  assert.match(styles, /background:\s*var\(--surface-tile\) !important/);
});
