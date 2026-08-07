import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const surfaces = await readFile(new URL('../src/surface-system.css', import.meta.url), 'utf8');
const icon = await readFile(new URL('../public/usdc-mark.svg', import.meta.url), 'utf8');

test('Mine presents the alternate quote as USDC with the token mark', () => {
  assert.match(source, /toggle-usdc/);
  assert.match(source, />USDC<\/span>/);
  assert.match(source, /USDC \/ tile/);
  assert.match(source, /usdcValueFor/);
  assert.match(source, /getSolUsdc/);
  assert.match(surfaces, /url\('\/usdc-mark\.svg'\)/);
  assert.match(icon, /#2775CA/);
});

test('USDC mode remains presentation-only while SOL stays canonical', () => {
  assert.match(source, /let amountSolValue/);
  assert.match(source, /const price = getSolUsdc\(\)/);
  assert.match(source, /amountSolValue = shown \/ price/);
  assert.match(source, /const entered = amountSolValue/);
  assert.match(source, /Transactions settle on Solana/);
});
