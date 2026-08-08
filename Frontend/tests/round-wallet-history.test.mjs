import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { walletRoundHistoryFromRows } from '../src/chain/rounds-index.js';
import { selectWalletRoundDecoration } from '../src/chain/rounds-page.js';

const [roundsPage, roundsIndex, main, migration, edge, supabaseConfig] = await Promise.all([
  readFile(new URL('../src/chain/rounds-page.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/chain/rounds-index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20260808135000_wallet_round_history.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/functions/wallet-round-history/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/config.toml', import.meta.url), 'utf8'),
]);

test('wallet history parser preserves exact bigint positions and processed status', () => {
  assert.deepEqual(walletRoundHistoryFromRows([
    {
      roundId: '501',
      positionLamports: '900719925474099312345',
      winningReceipts: '2',
      processedWinningReceipts: '2',
      claimed: true,
    },
    {
      roundId: '500',
      positionLamports: '12500000',
      winningReceipts: '3',
      processedWinningReceipts: '1',
      claimed: false,
    },
  ], ['501', '500']), new Map([
    ['501', {
      myBet: 900719925474099312345n,
      claimed: true,
      winningReceipts: 2n,
      processedWinningReceipts: 2n,
      historical: true,
    }],
    ['500', {
      myBet: 12500000n,
      claimed: false,
      winningReceipts: 3n,
      processedWinningReceipts: 1n,
      historical: true,
    }],
  ]));
});

test('wallet history parser fails closed on scope, duplication, or inconsistent claims', () => {
  const valid = {
    roundId: '8', positionLamports: '1', winningReceipts: '1',
    processedWinningReceipts: '1', claimed: true,
  };
  assert.equal(walletRoundHistoryFromRows([valid], ['7']), null);
  assert.equal(walletRoundHistoryFromRows([valid, valid], ['8']), null);
  assert.equal(walletRoundHistoryFromRows([
    { ...valid, processedWinningReceipts: '0' },
  ], ['8']), null);
  assert.equal(walletRoundHistoryFromRows([
    { ...valid, positionLamports: '0' },
  ], ['8']), null);
  assert.equal(walletRoundHistoryFromRows([], Array.from({ length: 51 }, (_, i) => String(i))), null);
});

test('historical decoration is bounded, completeness-gated and wallet-owned', () => {
  assert.match(roundsIndex, /visibleIds\.length > 50/);
  assert.match(roundsIndex, /round\.projectionComplete === true/);
  assert.match(roundsIndex, /wallet-round-history/);
  assert.match(roundsIndex, /stored\.walletAddress !== wallet/);
  assert.match(roundsIndex, /if \(!stored\?\.token[\s\S]*return null/);
  assert.doesNotMatch(roundsIndex, /authedFetchJson|ensureSession/);

  assert.match(edge, /const MAX_ROUND_IDS = 50/);
  assert.match(edge, /const session = await requireSession\(req\)/);
  assert.match(edge, /p_wallet: session\.walletAddress/);
  assert.doesNotMatch(edge, /payload\?\.wallet|payload\.wallet/);
  assert.match(edge, /sort\(\(left, right\) =>/);
  assert.match(supabaseConfig, /\[functions\.wallet-round-history\]\s*verify_jwt = false/);
});

test('missing or rejected wallet auth leaves decoration unknown, never false', () => {
  assert.deepEqual(selectWalletRoundDecoration({
    account: 'wallet',
    direct: null,
    historical: null,
    historicalAvailable: false,
    projectionComplete: true,
  }), {
    myBet: null,
    claimed: null,
    walletHistoryKnown: false,
  });
  assert.deepEqual(selectWalletRoundDecoration({
    account: 'wallet',
    direct: null,
    historical: null,
    historicalAvailable: true,
    projectionComplete: true,
  }), {
    myBet: 0n,
    claimed: false,
    walletHistoryKnown: true,
  });
  assert.deepEqual(selectWalletRoundDecoration({
    account: 'wallet',
    direct: { myBet: 5n, claimed: false },
    historical: { myBet: 5n, claimed: true },
    historicalAvailable: true,
    projectionComplete: true,
  }), {
    myBet: 5n,
    claimed: false,
    walletHistoryKnown: true,
  });
  assert.match(main, /walletHistoryKnown === false[\s\S]*Archived wallet history unavailable · live rewards remain in Rewards/);
});

test('private settlement access stays service-only and projection-complete', () => {
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = public, pg_temp/);
  assert.match(migration, /decode to exactly 32 bytes/);
  assert.match(migration, /cardinality\(p_round_ids\) > 50/);
  assert.match(migration, /rounds\.projection_complete = true/);
  assert.match(migration, /public\.mine_round_bets/);
  assert.match(migration, /public\.mine_receipt_settlements/);
  assert.match(migration, /revoke all on function public\.mine_wallet_round_history_v1[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.mine_wallet_round_history_v1[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /to anon, authenticated/);
});

test('historical rows decorate the ledger but never enter actionable claim discovery', () => {
  assert.match(roundsPage, /const \[indexedCounts, actionableMine, historicalMine\]/);
  assert.match(roundsPage, /historicalMine\?\.get\(key\)/);
  assert.match(roundsPage, /buildClaimable\(settledForClaims, actionableMine, account\)/);
  assert.match(roundsPage, /account && includeLive[\s\S]*loadIndexedWalletRoundHistory/);
  assert.doesNotMatch(roundsPage, /buildClaimable\([^)]*historicalMine/);
  assert.doesNotMatch(roundsPage, /mergeSettledClaimRounds\([^)]*historicalMine/);
});
