import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [source, styles] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/brand-uniform.css', import.meta.url), 'utf8'),
]);

test('landing statement gives only earned the shared MYNE spectrum', () => {
  assert.match(
    source,
    /<h1 id="landing-title">Value should<br\/>be <span class="landing-earned">earned\.<\/span><\/h1>/,
  );
  assert.match(styles, /\.landing-copy h1 \.landing-earned \{[\s\S]*background:\s*var\(--gld-spectrum\);/);
  assert.match(styles, /\.landing-copy h1 \.landing-earned \{[\s\S]*background-clip:\s*text;/);
  assert.match(styles, /\.landing-copy h1 \.landing-earned \{[\s\S]*-webkit-text-fill-color:\s*transparent;/);
});
