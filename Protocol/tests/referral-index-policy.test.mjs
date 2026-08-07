import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';

import {
  compactReferralCode, minerRegistrationProjection, myneClaimProjection,
} from '../scripts/referral-index-policy.mjs';

const wallet = (seed) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => seed))
  .publicKey.toBase58();
const claimant = wallet(1);
const referrer = wallet(2);
const otherReferrer = wallet(3);
const admin = wallet(4);
const signature = '2'.repeat(88);

const claim = {
  authority: claimant,
  grossBaseUnits: 100n,
  netBaseUnits: 90n,
  feeBaseUnits: 10n,
  referralBaseUnits: 1n,
  adminBaseUnits: 0n,
};

test('MinerRegistered projection preserves permanent attribution and compact codes', () => {
  const row = minerRegistrationProjection({
    data: { authority: claimant, referrer }, signature, slot: 42, eventIndex: 3,
  });
  assert.deepEqual(row, {
    registration_signature: signature,
    registration_event_index: 3,
    authority: claimant,
    referrer,
    registration_slot: 42,
  });
  assert.equal(compactReferralCode(claimant), claimant.slice(-10));

  const root = minerRegistrationProjection({
    data: { authority: claimant, referrer: PublicKey.default },
    signature,
    slot: 42,
    eventIndex: 4,
  });
  assert.equal(root.referrer, null);
});

test('legacy MyneClaimed credits resolve only through permanent registration', () => {
  const row = myneClaimProjection({
    data: claim,
    mappedReferrer: referrer,
    signature,
    slot: 88,
    eventIndex: 5,
  });
  assert.equal(row.referral_wallet, referrer);
  assert.equal(row.referral_base_units, '1');
  assert.equal(row.passive_base_units, '9');
  assert.equal(row.routing_audited, false);
});

test('ClaimFeeRoutedV2 verifies every fee leg and direct recipient', () => {
  const row = myneClaimProjection({
    data: claim,
    routingData: {
      claimant,
      passiveBaseUnits: 9n,
      referralWallet: referrer,
      referralBaseUnits: 1n,
      adminFeeWallet: admin,
      adminBaseUnits: 0n,
    },
    mappedReferrer: referrer,
    signature,
    slot: 99,
    eventIndex: 6,
    routingEventIndex: 7,
  });
  assert.equal(row.routing_audited, true);
  assert.equal(row.routing_event_index, 7);
  assert.equal(row.admin_fee_wallet, admin);
});

test('ClaimFeeRoutedV2 keeps the no-referrer admin fallback distinct', () => {
  const row = myneClaimProjection({
    data: { ...claim, referralBaseUnits: 0n, adminBaseUnits: 1n },
    routingData: {
      claimant,
      passiveBaseUnits: 9n,
      referralWallet: PublicKey.default,
      referralBaseUnits: 0n,
      adminFeeWallet: admin,
      adminBaseUnits: 1n,
    },
    signature,
    slot: 99,
    eventIndex: 6,
    routingEventIndex: 7,
  });
  assert.equal(row.referral_wallet, null);
  assert.equal(row.admin_fee_wallet, admin);
  assert.equal(row.admin_base_units, '1');
});

test('positive credits fail closed when attribution is missing or contradictory', () => {
  assert.throws(() => myneClaimProjection({
    data: claim, signature, slot: 100, eventIndex: 8,
  }), /no auditable recipient/);

  assert.throws(() => myneClaimProjection({
    data: claim,
    routingData: {
      claimant,
      passiveBaseUnits: 9n,
      referralWallet: otherReferrer,
      referralBaseUnits: 1n,
      adminFeeWallet: admin,
      adminBaseUnits: 0n,
    },
    mappedReferrer: referrer,
    signature,
    slot: 100,
    eventIndex: 8,
    routingEventIndex: 9,
  }), /disagrees with permanent MinerRegistered attribution/);
});

test('round indexer wires a versioned finalized-log backfill into the additive schema', async () => {
  const indexer = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const migration = await readFile(
    new URL('../../supabase/migrations/20260807133000_referral_read_model_v1.sql', import.meta.url),
    'utf8',
  );

  assert.match(indexer, /REFERRAL_INDEXER_ID = .*referrals:v/);
  assert.match(indexer, /event\.name === 'MinerRegistered'/);
  assert.match(indexer, /event\.name !== 'MyneClaimed'/);
  assert.match(indexer, /next\?\.name === 'ClaimFeeRoutedV2'/);
  assert.match(indexer, /upsert\(\s*'mine_referral_claims_v1'/);
  assert.match(indexer, /REFERRAL_INDEXER_START_SLOT/);
  assert.doesNotMatch(indexer, /getProgramAccounts\s*\(/);

  assert.match(migration, /create table if not exists public\.mine_referral_miners_v1/);
  assert.match(migration, /create table if not exists public\.mine_referral_claims_v1/);
  assert.match(migration, /create or replace view public\.mine_referral_network_v1/);
  assert.match(migration, /create or replace view public\.mine_referral_stats_v1/);
  assert.match(migration, /gross_base_units = net_base_units \+ fee_base_units/);
  assert.match(migration, /fee_base_units = passive_base_units \+ referral_base_units \+ admin_base_units/);
});
