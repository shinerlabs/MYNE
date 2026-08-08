import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [main, style, brand] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/brand-uniform.css', import.meta.url), 'utf8'),
]);

test('expanded rounds omit the redundant settlement field and resolve only the transaction link', () => {
  assert.doesNotMatch(main, /<span>SETTLEMENT<\/span><strong class="round-settlement">/);
  assert.doesNotMatch(main, /querySelector\('\.round-settlement'\)/);
  assert.match(main, /const loadRoundTransaction = async \(detail\)/);
  assert.match(main, /class="round-explorer round-tx-link"[^>]+hidden>View on Solana ↗<\/a>/);
  assert.match(brand, /\.round-tx-link\[hidden\][\s\S]*display: none !important/);
});

test('round proof uses the MYNE spectrum and a structured responsive proof grid', () => {
  assert.match(main, /class="fair-overview"/);
  assert.match(main, /class="fair-proof-grid"/);
  assert.match(main, /MYNE SERVER RNG/);
  assert.match(main, /Committed before betting · Solana entropy selected after betting closed/);
  assert.match(main, /<p class="fair-note">/);
  assert.match(main, /document\.createElement\('div'\)/);
  assert.match(style, /\.round-fairness[\s\S]*var\(--gld-spectrum\) border-box/);
  assert.match(style, /\.fair-proof-grid[\s\S]*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(style, /\.round-fairness \.fair-footer[\s\S]*flex-wrap:\s*wrap/);
  assert.match(style, /\.round-fairness \.fair-note[\s\S]*min-width:\s*min\(260px, 100%\)/);
  assert.match(style, /\.round-fairness \.fair-verdict[\s\S]*flex:\s*3 1 680px/);
  assert.match(style, /@media \(max-width: 560px\)[\s\S]*\.fair-proof-grid[\s\S]*minmax\(0, 1fr\)/);
  assert.match(brand, /\.round-detail \{[\s\S]*repeat\(2, minmax\(0, 1fr\)\) auto/);
});
