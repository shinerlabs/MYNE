import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  affordableAutoPlanRounds,
  maxAutoPlanFundingLamports,
  requiredDeposit,
} from '../src/chain/autocommit.js';

test('Auto-round keeps exactly 10% of wallet SOL outside plan funding', () => {
  assert.equal(maxAutoPlanFundingLamports(1_000n), 900n);
  assert.equal(maxAutoPlanFundingLamports(11n), 9n);
  assert.equal(maxAutoPlanFundingLamports(0n), 0n);
});

test('Auto-round capacity uses the exact wager plus live receipt rent', () => {
  assert.equal(affordableAutoPlanRounds({
    walletBalance: 1_000n,
    amountPerPlay: 100n,
    maxFee: 50n,
  }), 6n);
  assert.equal(requiredDeposit({ amountPerPlay: 100n, maxFee: 50n, fundRounds: 6 }), 900n);
});

test('both initial funding and top-ups enforce the 90% boundary before submission', async () => {
  const [autoCommit, minePage, main] = await Promise.all([
    readFile(new URL('../src/chain/autocommit.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/mine-page.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);
  assert.match(autoCommit, /await assertFundingWithinWalletBudget\(deposit, authority\)/);
  assert.match(autoCommit, /await assertFundingWithinWalletBudget\(value, authority\)/);
  assert.match(minePage, /deposit > maximumFunding/);
  assert.match(minePage, /value > maximumFunding/);
  assert.match(main, /affordableAutoPlanRounds\(\{/);
  assert.match(main, /state\.autoPlanMaxFee/);
  assert.doesNotMatch(main, /AUTO_FEE_WEI|AUTO_FEE_PER_ROUND|GAS_RESERVE_ETH/);
});
