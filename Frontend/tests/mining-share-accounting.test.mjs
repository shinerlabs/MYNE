import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { effectiveUnclaimedMyne, miningShareValue } from '../src/chain/mining-shares.js';

test('effective unclaimed MYNE is the exact floor of pool assets times owned share fraction', () => {
  assert.equal(miningShareValue(218n, 200n, 100n), 109n);
  assert.equal(miningShareValue(11n, 3n, 1n), 3n);
  assert.equal(miningShareValue(11n, 3n, 2n), 7n);
});

test('effective miner balance ignores stale cached unclaimedMyne', () => {
  const miner = { unclaimedMyne: 1n, passiveRewardDebt: 25n };
  const pool = { totalUnclaimed: 1_000n, rewardPerUnclaimed: 100n };
  assert.equal(effectiveUnclaimedMyne(miner, pool), 250n);
});

test('invalid or cross-slot share snapshots fail closed', () => {
  assert.equal(miningShareValue(0n, 0n, 0n), 0n);
  assert.equal(miningShareValue(100n, 0n, 1n), 0n);
  assert.equal(miningShareValue(100n, 10n, 11n), 0n);
  assert.equal(effectiveUnclaimedMyne(null, null), 0n);
});

test('claim and burn guards use live share value and referred claims omit the global admin ATA', async () => {
  const source = await readFile(new URL('../src/chain/lottery.js', import.meta.url), 'utf8');
  assert.match(source, /effectiveUnclaimedMyne\(miner, miningPool\)/);
  assert.doesNotMatch(source, /toBig\(miner\.unclaimedMyne\) === 0n/);
  assert.match(source, /const adminFeeTokens = hasReferrer \? null : associatedToken/);
});
