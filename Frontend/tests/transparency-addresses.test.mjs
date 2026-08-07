import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const renderer = source.slice(
  source.indexOf('const renderTransparencyAddresses = async () => {'),
  source.indexOf('/* About is protocol documentation'),
);

test('transparency page omits externally controlled operational wallets', () => {
  for (const label of [
    'Buyback wallet',
    'Referral fallback wallet',
    'Protocol administrator',
    'Upgrade authority',
    'Randomness authority',
  ]) {
    assert.equal(renderer.includes(`label: '${label}'`), false, `${label} must not be rendered`);
  }
});

test('transparency page retains canonical public protocol identities', () => {
  for (const label of [
    'MYNE mint',
    'Protocol program',
    'Protocol config',
    'Staking rewards vault',
    'Mining rewards ledger',
    'Liquidity gate',
    'Meteora pool',
    'Switchboard program',
  ]) {
    assert.equal(renderer.includes(`label: '${label}'`), true, `${label} must remain visible`);
  }
});
