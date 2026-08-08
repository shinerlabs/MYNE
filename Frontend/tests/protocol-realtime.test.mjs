import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('confirmed Solana account subscriptions drive round and wallet reward refreshes', async () => {
  const [realtime, mine] = await Promise.all([
    read('../src/chain/protocol-realtime.js'),
    read('../src/chain/mine-page.js'),
  ]);
  assert.match(realtime, /connection\.onAccountChange\([\s\S]*'confirmed'/);
  assert.match(realtime, /removeAccountChangeListener/);
  assert.match(mine, /const observed = new Set\(\[id, \.\.\.\(id > 0n \? \[id - 1n\] : \[\]\)\]/);
  assert.match(mine, /subscribeAccountActivity\(derivePda\('round', u64Seed\(observedId\)\)/);
  assert.match(mine, /decodeRoundAccountData\(observedId, account\.data\)/);
  assert.match(mine, /applyRoundSnapshot\(round, slot\)/);
  assert.match(mine, /if \(round\.resolved\) publishResolvedRound\(state\.roundId, round\)/);
  assert.match(mine, /current\.resolved && !round\.resolved/);
  assert.match(mine, /incomingSlot < state\.currentRoundSlot/);
  const roundRefresh = mine.slice(
    mine.indexOf('async function refreshRound'),
    mine.indexOf('async function refreshJackpot'),
  );
  assert.match(roundRefresh, /void refreshWalletBets\(requestedRoundId, requestedAccount\)/);
  assert.doesNotMatch(roundRefresh, /await readMyBets/);
  assert.match(mine, /boundedWalletRead\(readMyBets\(roundId, account\)\)/);
  assert.match(mine, /catch \{[\s\S]*observedId === state\.roundId\) void refreshRound\(\);[\s\S]*void loadResolved\(observedId\)/);
  assert.match(mine, /subscribeAccountActivity\(minerPda\(authority\)/);
  assert.match(mine, /subscribeAccountActivity\(stakePositionPda\(authority\)/);
  assert.match(mine, /subscribeAccountActivity\(protocolPdas\.miningPool/);
  assert.match(mine, /subscribeAccountActivity\(protocolPdas\.stakePool/);
  assert.match(mine, /const scheduleMinerRefresh = \(\) => \{[\s\S]*window\.setTimeout[\s\S]*refreshMiner\(\)[\s\S]*100/);
  assert.match(mine, /protocolPdas\.miningPool[\s\S]*scheduleMinerRefresh\(\)[\s\S]*protocolPdas\.stakePool[\s\S]*scheduleMinerRefresh\(\)/);
  // Realtime is an acceleration path, not a single point of failure.
  assert.match(mine, /window\.setInterval\([\s\S]*refreshRound\(\)[\s\S]*5000/);
});

test('incomplete indexes fall back only to exact receipt scans on mainnet', async () => {
  const lottery = await read('../src/chain/lottery.js');
  assert.match(lottery, /cluster === 'mainnet-beta' && roundId === null && !authority/);
  assert.match(lottery, /filters\.push\(\{ memcmp: \{ offset: 9, bytes: bs58\.encode\(u64Seed\(roundId\)\) \} \}\)/);
  assert.match(lottery, /if \(authority\) \{[\s\S]*scanReceipts\(\{ roundId, authority \}\)/);
  assert.match(lottery, /wallet reward ledger is temporarily unavailable/);
  const claimable = lottery.slice(
    lottery.indexOf('async function claimableReceipts'),
    lottery.indexOf('export async function claimRound'),
  );
  assert.match(claimable, /await decodedReceipts\(\{ authority \}\)/);
  assert.doesNotMatch(claimable, /Promise\.all/);
  assert.equal(claimable.match(/decodedReceipts\(/g)?.length, 1);
  assert.match(lottery, /decodeRoundAccountData[\s\S]*decodeProtocolAccount\('Round', data\)/);
});

test('round index realtime refreshes history while publishing no private settlement table', async () => {
  const [indexRealtime, main, migration] = await Promise.all([
    read('../src/chain/round-index-realtime.js'),
    read('../src/main.js'),
    read('../../supabase/migrations/20260808130000_round_realtime.sql'),
  ]);
  assert.match(indexRealtime, /postgres_changes[\s\S]*table: 'mine_rounds'/);
  assert.match(main, /subscribeRoundIndexChanges\([\s\S]*indexed: true/);
  assert.match(main, /refreshRoundHistory\(\{ force: true \}\)/);
  assert.match(migration, /alter publication supabase_realtime add table public\.mine_rounds/);
  assert.doesNotMatch(migration, /add table public\.mine_receipt_settlements/);
  assert.doesNotMatch(migration, /add table public\.mine_indexer_state/);
});
