import assert from 'node:assert/strict';
import test from 'node:test';

import { selectTokenAccountForAmount, tokenAccountBalance } from '../src/chain/token-account.js';

const row = (pubkey, amount) => ({
  pubkey,
  account: { data: { parsed: { info: { tokenAmount: { amount: String(amount) } } } } },
});

test('staking prefers a funded canonical ATA', () => {
  const rows = [row('auxiliary', 100n), row('canonical', 250n)];
  assert.equal(selectTokenAccountForAmount(rows, 200n, 'canonical'), 'canonical');
});

test('staking falls back to a funded auxiliary token account', () => {
  const rows = [row('auxiliary', 250n), row('canonical', 10n)];
  assert.equal(selectTokenAccountForAmount(rows, 200n, 'canonical'), 'auxiliary');
});

test('staking reports a split balance instead of submitting a missing source account', () => {
  const rows = [row('first', 100n), row('second', 100n)];
  assert.equal(selectTokenAccountForAmount(rows, 150n, 'canonical'), null);
  assert.equal(tokenAccountBalance(rows), 200n);
});

test('malformed token-account rows are ignored safely', () => {
  assert.equal(selectTokenAccountForAmount([{ pubkey: 'bad', account: {} }], 1n), null);
});
