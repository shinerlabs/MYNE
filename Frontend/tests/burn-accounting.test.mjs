import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  combineBurnTotals, completedBuybackBurnFromStatsRow,
} from '../src/chain/burn-accounting.js';

test('completed buyback aggregate preserves exact base units', () => {
  assert.equal(completedBuybackBurnFromStatsRow({
    completed_buyback_burn_base_units: '10000000001200000000',
    completed_buyback_executions: 2,
    latest_completed_buyback_round: 41,
  }), 10_000_000_001_200_000_000n);
});

test('buyback aggregate accepts an empty ledger and rejects inconsistent rows', () => {
  assert.equal(completedBuybackBurnFromStatsRow({
    completed_buyback_burn_base_units: '0',
    completed_buyback_executions: 0,
    latest_completed_buyback_round: null,
  }), 0n);
  assert.equal(completedBuybackBurnFromStatsRow({
    completed_buyback_burn_base_units: '1', completed_buyback_executions: 0, latest_completed_buyback_round: null,
  }), null);
  assert.equal(completedBuybackBurnFromStatsRow({
    completed_buyback_burn_base_units: '0', completed_buyback_executions: 1, latest_completed_buyback_round: 41,
  }), null);
  assert.equal(completedBuybackBurnFromStatsRow({
    completed_buyback_burn_base_units: '1.5', completed_buyback_executions: 1, latest_completed_buyback_round: 41,
  }), null);
});

test('burn totals combine permanent Stake + Burn principal and completed buybacks', () => {
  assert.deepEqual(combineBurnTotals({
    currentSupplyBaseUnits: 100_000_000_000n,
    stakingBurnBaseUnits: 60_000_000_000n,
    completedBuybackBurnBaseUnits: 20_000_000_000n,
  }), {
    current: 100_000_000_000n,
    supplied: 180_000_000_000n,
    burned: 80_000_000_000n,
    burnedStaking: 60_000_000_000n,
    burnedBuyback: 20_000_000_000n,
  });
});

test('burn totals fail closed on unsafe or malformed quantities', () => {
  const valid = {
    currentSupplyBaseUnits: '100000000000',
    stakingBurnBaseUnits: '60000000000',
    completedBuybackBurnBaseUnits: '20000000000',
  };
  assert.equal(combineBurnTotals({ ...valid, stakingBurnBaseUnits: '-1' }), null);
  assert.equal(combineBurnTotals({ ...valid, completedBuybackBurnBaseUnits: '1.5' }), null);
  assert.equal(combineBurnTotals({ ...valid, currentSupplyBaseUnits: Number.MAX_SAFE_INTEGER + 1 }), null);
});

test('frontend reads one completed-buyback aggregate instead of scanning execution history', async () => {
  const [reader, migration] = await Promise.all([
    readFile(new URL('../src/chain/burn-index.js', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/20260808113000_burn_stats.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(reader, /\.from\('mine_burn_stats'\)/);
  assert.doesNotMatch(reader, /\.from\('mine_buyback_executions'\)/);
  assert.match(migration, /security_invoker = true/);
  assert.match(migration, /round_state\.resolved = true[\s\S]*round_state\.buyback_completed = true/);
  assert.match(migration, /grant select on public\.mine_burn_stats to anon, authenticated/);
});
