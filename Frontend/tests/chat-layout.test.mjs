import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [styles, fitStyles] = await Promise.all([
  readFile(new URL('../src/brand-uniform.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/viewport-fit.css', import.meta.url), 'utf8'),
]);

test('desktop chat has a wider rail and reaches the viewport floor', () => {
  assert.match(fitStyles, /grid-template-columns:\s*clamp\(240px, 20vw, 360px\) minmax\(480px, 1fr\) clamp\(400px, 29vw, 500px\) !important/);
  assert.match(fitStyles, /margin:\s*8px 18px 0 !important/);
  assert.match(fitStyles, /left:\s*18px !important;[\s\S]*width:\s*min\(420px, calc\(100vw - 36px\)\) !important/);
  assert.match(styles, /100dvh - 92px[\s\S]*var\(--mine-ui-scale\)/);
  assert.match(styles, /workspace\.page-view\.active \.chat-panel \{[\s\S]*height:\s*100% !important/);
});

test('chat is transparent and the composer owns the bottom row', () => {
  assert.match(styles, /workspace > \.chat-panel,[\s\S]*background:\s*transparent !important/);
  assert.match(styles, /chat-panel \.chat-compose-shell \{[\s\S]*bottom:\s*0;[\s\S]*margin-top:\s*auto/);
});
