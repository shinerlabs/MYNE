import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';

export const REFERRAL_PROJECTION_VERSION = 1;
export const DEFAULT_SOLANA_ADDRESS = PublicKey.default.toBase58();
const U64_MAX = (1n << 64n) - 1n;

const asString = (value) => value?.toString?.() ?? String(value ?? 0);

function u64(value, label) {
  const parsed = BigInt(asString(value));
  assert.ok(parsed >= 0n && parsed <= U64_MAX, `${label} must fit in a Solana u64`);
  return parsed;
}

export function canonicalReferralAddress(value, label = 'referral address') {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new Error(`${label} must be a canonical Solana public key`);
  }
}

function optionalNonDefaultAddress(value, label) {
  if (value === null || value === undefined) return null;
  const address = canonicalReferralAddress(value, label);
  return address === DEFAULT_SOLANA_ADDRESS ? null : address;
}

export function compactReferralCode(authority) {
  return canonicalReferralAddress(authority, 'referral-code authority').slice(-10);
}

export function minerRegistrationProjection({ data, signature, slot, eventIndex }) {
  const authority = canonicalReferralAddress(data.authority, 'registered miner');
  const referrer = optionalNonDefaultAddress(data.referrer, 'registered referrer');
  assert.notEqual(referrer, authority, 'MinerRegistered cannot attribute a miner to itself');
  return {
    registration_signature: String(signature),
    registration_event_index: eventIndex,
    authority,
    referrer,
    registration_slot: slot,
  };
}

/**
 * Build one claim projection from the stable MyneClaimed event and its optional versioned
 * ClaimFeeRoutedV2 companion. Historical claims resolve through the permanent registration row;
 * versioned claims additionally verify every directly emitted recipient and fee leg.
 */
export function myneClaimProjection({
  data, routingData = null, mappedReferrer = null, signature, slot, eventIndex,
  routingEventIndex = null,
}) {
  const claimant = canonicalReferralAddress(data.authority, 'MYNE claimant');
  const gross = u64(data.grossBaseUnits, 'gross_base_units');
  const net = u64(data.netBaseUnits, 'net_base_units');
  const fee = u64(data.feeBaseUnits, 'fee_base_units');
  const referral = u64(data.referralBaseUnits, 'referral_base_units');
  const admin = u64(data.adminBaseUnits, 'admin_base_units');
  assert.equal(gross, net + fee, 'MyneClaimed gross must equal net plus fee');
  assert.ok(referral + admin <= fee, 'MyneClaimed direct fee legs cannot exceed the total fee');
  const passive = fee - referral - admin;

  const registeredReferrer = optionalNonDefaultAddress(mappedReferrer, 'indexed referrer');
  let emittedReferrer = null;
  let adminFeeWallet = null;

  if (routingData) {
    const routedClaimant = canonicalReferralAddress(routingData.claimant, 'routed claimant');
    assert.equal(routedClaimant, claimant, 'ClaimFeeRoutedV2 claimant must match MyneClaimed');
    assert.equal(
      u64(routingData.passiveBaseUnits, 'routed passive_base_units'),
      passive,
      'ClaimFeeRoutedV2 passive fee must match MyneClaimed',
    );
    assert.equal(
      u64(routingData.referralBaseUnits, 'routed referral_base_units'),
      referral,
      'ClaimFeeRoutedV2 referral fee must match MyneClaimed',
    );
    assert.equal(
      u64(routingData.adminBaseUnits, 'routed admin_base_units'),
      admin,
      'ClaimFeeRoutedV2 admin fee must match MyneClaimed',
    );
    emittedReferrer = optionalNonDefaultAddress(
      routingData.referralWallet,
      'routed referral wallet',
    );
    adminFeeWallet = canonicalReferralAddress(
      routingData.adminFeeWallet,
      'routed admin fee wallet',
    );
  }

  if (registeredReferrer && emittedReferrer) {
    assert.equal(
      emittedReferrer,
      registeredReferrer,
      'ClaimFeeRoutedV2 referral wallet disagrees with permanent MinerRegistered attribution',
    );
  }
  const referralWallet = emittedReferrer ?? registeredReferrer;
  if (referral > 0n) {
    assert.ok(referralWallet, 'Positive referral credit has no auditable recipient');
    if (routingData) {
      assert.ok(emittedReferrer, 'ClaimFeeRoutedV2 omitted a positive referral recipient');
    }
  }
  assert.ok(
    !(admin > 0n && referralWallet),
    'Admin fallback and a permanent referrer cannot both receive the direct fee leg',
  );

  return {
    claim_signature: String(signature),
    claim_event_index: eventIndex,
    routing_event_index: routingData ? routingEventIndex : null,
    routing_audited: Boolean(routingData),
    claimant,
    referral_wallet: referralWallet,
    admin_fee_wallet: adminFeeWallet,
    gross_base_units: gross.toString(),
    net_base_units: net.toString(),
    fee_base_units: fee.toString(),
    passive_base_units: passive.toString(),
    referral_base_units: referral.toString(),
    admin_base_units: admin.toString(),
    claim_slot: slot,
  };
}
