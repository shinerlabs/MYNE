import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcileBurnTotals, sumCompletedBuybackBurnRows,
} from '../src/chain/burn-accounting.js';

const completed = { resolved: true, buyback_completed: true };

test('completed buyback burn evidence is summed exactly in base units', () => {
  assert.equal(sumCompletedBuybackBurnRows([
    {
      round_id: '41', sequence: 0, burned_base_units: '1200000001', burn_signature: 'sig-a', mine_rounds: completed,
    },
    {
      round_id: '41', sequence: 1, burned_base_units: '9999999999999999999', burn_signature: 'sig-b', mine_rounds: [completed],
    },
  ]), 10_000_000_001_200_000_000n);
});

test('buyback evidence fails closed unless its round is resolved and completed', () => {
  const row = {
    round_id: '41', sequence: 0, burned_base_units: '10', burn_signature: 'sig-a', mine_rounds: completed,
  };
  assert.equal(sumCompletedBuybackBurnRows([{ ...row, mine_rounds: { ...completed, buyback_completed: false } }]), null);
  assert.equal(sumCompletedBuybackBurnRows([{ ...row, mine_rounds: { ...completed, resolved: false } }]), null);
  assert.equal(sumCompletedBuybackBurnRows([{ ...row, burned_base_units: '0' }]), null);
  assert.equal(sumCompletedBuybackBurnRows([{ ...row, burned_base_units: '1.5' }]), null);
  assert.equal(sumCompletedBuybackBurnRows([{ ...row, burn_signature: '' }]), null);
  assert.equal(sumCompletedBuybackBurnRows([row, { ...row, burn_signature: 'sig-b' }]), null);
});

test('burn totals combine permanent Stake + Burn principal and completed buybacks', () => {
  assert.deepEqual(reconcileBurnTotals({
    totalEmittedBaseUnits: 180_000_000_000n,
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

test('burn totals fail closed on stale evidence or unsafe/malformed quantities', () => {
  const valid = {
    totalEmittedBaseUnits: '180000000000',
    currentSupplyBaseUnits: '100000000000',
    stakingBurnBaseUnits: '60000000000',
    completedBuybackBurnBaseUnits: '20000000000',
  };
  assert.equal(reconcileBurnTotals({ ...valid, completedBuybackBurnBaseUnits: '19999999999' }), null);
  assert.equal(reconcileBurnTotals({ ...valid, stakingBurnBaseUnits: '-1' }), null);
  assert.equal(reconcileBurnTotals({ ...valid, currentSupplyBaseUnits: Number.MAX_SAFE_INTEGER + 1 }), null);
  assert.equal(reconcileBurnTotals({ ...valid, totalEmittedBaseUnits: '90000000000' }), null);
});
