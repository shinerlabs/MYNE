import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { capabilitiesFromIdl } from '../src/chain/protocol-capabilities.js';

const idl = JSON.parse(await readFile(new URL('../src/generated/myne_protocol.json', import.meta.url), 'utf8'));

test('generated IDL exposes the implemented feature bundles and keeps swaps external', () => {
  const capabilities = capabilitiesFromIdl(idl);
  assert.equal(capabilities.configuration.ready, true);
  assert.equal(capabilities.mining.ready, true);
  assert.equal(capabilities.staking.ready, true);
  assert.equal(capabilities.referrals.ready, true);
  assert.equal(capabilities.autoRound.ready, true);
  assert.equal(capabilities.autoReinvest.ready, true);
  assert.equal(capabilities.swaps.ready, false);
});

test('SOL reinvest is independently gated without disabling ordinary Auto-round', () => {
  const capabilities = capabilitiesFromIdl({ instructions: [
    { name: 'create_auto_plan' },
    { name: 'configure_auto_plan' },
    { name: 'fund_auto_plan' },
    { name: 'cancel_auto_plan' },
    { name: 'execute_auto_plan' },
    { name: 'claim_auto_burn_receipt' },
  ] });
  assert.equal(capabilities.autoRound.ready, true);
  assert.equal(capabilities.autoReinvest.ready, false);
  assert.deepEqual(capabilities.autoReinvest.missing, ['reinvest_auto_plan_rewards']);
});

test('feature detection fails closed when an instruction is absent', () => {
  const capabilities = capabilitiesFromIdl({ instructions: [{ name: 'stake_standard' }] });
  assert.deepEqual(capabilities.staking.missing, [
    'burn_stake',
    'burn_unclaimed_myne',
    'request_unstake',
    'withdraw_unstaked',
    'claim_staking_rewards',
    'fund_staking_rewards',
  ]);
});
