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
  assert.match(mine, /subscribeAccountActivity\(derivePda\('round', u64Seed\(id\)\)/);
  assert.match(mine, /subscribeAccountActivity\(minerPda\(authority\)/);
  assert.match(mine, /subscribeAccountActivity\(stakePositionPda\(authority\)/);
  assert.match(mine, /subscribeAccountActivity\(protocolPdas\.miningPool/);
  assert.match(mine, /subscribeAccountActivity\(protocolPdas\.stakePool/);
  // Realtime is an acceleration path, not a single point of failure.
  assert.match(mine, /window\.setInterval\([\s\S]*refreshRound\(\)[\s\S]*5000/);
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
