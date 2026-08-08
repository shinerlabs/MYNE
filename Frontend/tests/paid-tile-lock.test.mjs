import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('confirmed tile receipts remain selected and locked for the active betting round', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /const tileHasConfirmedBet = \(slotId, state = chain\.state\)/);
  assert.match(source, /const tileLocked = \(slotId\) => chain\.state\.phase === 'betting' && tileHasConfirmedBet\(slotId\)/);
  assert.match(source, /const paid = state\.phase === 'betting' && tileHasConfirmedBet\(tile\.dataset\.slot, state\);[\s\S]*const picked = paid \|\| selected\.has\(tile\.dataset\.slot\)/);
  assert.match(source, /already paid for and locked this round/);
  assert.match(source, /ALL\/CLEAR only affects tiles that are still available\.[\s\S]*if \(tileLocked\(id\)\) return;/);
});
