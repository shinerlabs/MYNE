import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../src/brand-uniform.css', import.meta.url), 'utf8');

test('desktop chat has a wider rail and reaches the viewport floor', () => {
  assert.match(styles, /grid-template-columns:\s*280px 540px 500px !important/);
  assert.match(styles, /100dvh - 92px[\s\S]*var\(--mine-ui-scale\)/);
  assert.match(styles, /workspace\.page-view\.active \.chat-panel \{[\s\S]*height:\s*100% !important/);
});

test('chat is transparent and the composer owns the bottom row', () => {
  assert.match(styles, /workspace > \.chat-panel,[\s\S]*background:\s*transparent !important/);
  assert.match(styles, /chat-panel \.chat-compose-shell \{[\s\S]*bottom:\s*0;[\s\S]*margin-top:\s*auto/);
});
