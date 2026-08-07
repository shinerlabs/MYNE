import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MAX_REFERRAL_OFFSET,
  MAX_REFERRAL_PAGE_SIZE,
  boundedReferralPage,
  referralLeaderFromRow,
  referralNetworkFromRow,
  referralStatsFromRow,
} from '../src/chain/referral-read-model.js';

test('referral reads clamp caller-controlled page sizes and offsets', () => {
  assert.deepEqual(boundedReferralPage({ limit: 1_000_000, offset: -9 }), {
    limit: MAX_REFERRAL_PAGE_SIZE,
    offset: 0,
  });
  assert.deepEqual(boundedReferralPage({ limit: 0, offset: 1_000_000 }), {
    limit: 1,
    offset: MAX_REFERRAL_OFFSET,
  });
});

test('referral row adapters preserve exact MYNE base units', () => {
  const exact = '18446744073709551615';
  assert.deepEqual(referralStatsFromRow({
    earned_base_units: exact, referrals: '12', active: '7',
  }), { lifetime: BigInt(exact), referrals: 12, active: 7 });
  assert.deepEqual(referralNetworkFromRow({
    referred_wallet: 'wallet-a', active: true, earned_base_units: exact,
  }), { addr: 'wallet-a', active: true, earned: BigInt(exact) });
  assert.deepEqual(referralLeaderFromRow({
    wallet_address: 'wallet-b', referrals: 3, active: 2, earned_base_units: exact,
  }), { addr: 'wallet-b', referrals: 3, active: 2, lifetime: BigInt(exact) });
});

test('frontend uses bounded referral views and never labels generic unclaimed MYNE as referral claimable', async () => {
  const source = await readFile(new URL('../src/chain/referral.js', import.meta.url), 'utf8');
  assert.match(source, /from\('mine_referral_stats_v1'\)/);
  assert.match(source, /from\('mine_referral_network_v1'\)/);
  assert.match(source, /\.range\(page\.offset, page\.offset \+ page\.limit - 1\)/);
  assert.doesNotMatch(source, /miner\?\.unclaimedMyne|miner\.unclaimedMyne/);
  assert.match(source, /claimable: 0n/);
});
