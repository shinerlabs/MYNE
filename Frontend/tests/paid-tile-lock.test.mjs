import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { manualDeploymentRequiredBalance } from '../src/chain/autocommit.js';
import { mergeConfirmedTileBets } from '../src/chain/confirmed-tile-bets.js';

test('manual deployment reserves exact receipt, account and network costs', () => {
  const feeParams = {
    maxFee: 3n,
    transactionFeeReserve: 5n,
    minerRent: 7n,
    stakePositionRent: 11n,
  };
  assert.equal(manualDeploymentRequiredBalance({ amount: 100n, hasMiner: true, feeParams }), 108n);
  assert.equal(manualDeploymentRequiredBalance({ amount: 100n, hasMiner: false, feeParams }), 126n);
});

test('a confirmed transaction remains authoritative while RPC still returns the old receipt snapshot', () => {
  const chain = Array(25).fill(0n);
  const confirmed = Array(25).fill(0n);
  confirmed[6] = 50_000_000n;
  assert.equal(mergeConfirmedTileBets(chain, confirmed)[6], 50_000_000n);

  chain[6] = 50_000_000n;
  assert.equal(mergeConfirmedTileBets(chain, confirmed)[6], 50_000_000n);
});

test('confirmed tile receipts remain selected and locked for the active betting round', async () => {
  const [source, minePage] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/mine-page.js', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /const tileHasConfirmedBet = \(slotId, state = chain\.state\)/);
  assert.match(source, /const tileLocked = \(slotId\) => \([\s\S]*tileHasConfirmedBet\(slotId\)[\s\S]*classList\.contains\('has-position'\)/);
  assert.match(source, /const paid = tileHasConfirmedBet\(tile\.dataset\.slot, state\)[\s\S]*tile\.classList\.contains\('has-position'\);[\s\S]*const picked = paid \|\| selected\.has\(tile\.dataset\.slot\)/);
  assert.match(source, /already paid for and locked this round/);
  assert.match(source, /ALL\/CLEAR only affects tiles that are still available\.[\s\S]*if \(tileLocked\(id\)\) return;/);
  assert.match(minePage, /const submittedRoundId = BigInt\(state\.roundId\)/);
  assert.match(minePage, /rememberConfirmedTileBets\([\s\S]*state\.myBets = mergeConfirmedTileBets[\s\S]*await Promise\.all\(\[refreshRound\(\), refreshMiner\(\)\]\)/);
  assert.match(minePage, /baseAmounts: state\.myBets/);
  assert.match(minePage, /if \(priorTotal > confirmedTileBets\.amounts\[index\]\)/);
  assert.match(minePage, /state\.myBets = reconcileConfirmedTileBets\(/);
  assert.match(minePage, /myne-confirmed-tiles-v1/);
  assert.match(minePage, /persistConfirmedTileBets\(\)/);
  assert.match(minePage, /restoreConfirmedTileBets\(\{ roundId, account \}\)/);
  assert.match(minePage, /if \(rolled\) \{[\s\S]*clearConfirmedTileBets\(\{ removeStored: true \}\)/);
});
