import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [main, style] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
]);

test('Stake claimable SOL swaps to USD without changing its typography or geometry', () => {
  assert.match(main, /id="stake-claimable-eth"[\s\S]*stake-claim-hover-mark[\s\S]*data-sol-readout-value/);
  assert.match(main, /node\.classList\.contains\('is-usd'\)[\s\S]*data-sol-readout-value/);
  assert.match(style, /#stake-claimable-eth > \.stake-claim-hover-mark \{ display: none !important; \}/);
  assert.match(style, /\.usd-swap \{[\s\S]*font: inherit !important;[\s\S]*letter-spacing: inherit !important;/);
});
