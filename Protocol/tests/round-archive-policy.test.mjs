import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  archiveHash,
  buildArchiveSnapshot,
  requireRoundFeeAudit,
  requireRoundRandomnessProof,
  SERVER_PROVIDER_KIND,
  SWITCHBOARD_PROVIDER_KIND,
} from '../scripts/round-archive-policy.mjs';

const round = {
  round_id: 9,
  rent_payer: 'payer',
  opened_at: 100,
  betting_ends_at: 160,
  settles_at: 160,
  refund_at: 200,
  resolved: true,
  winning_square: 3,
  jackpot_hit: false,
  single_miner_round: false,
  winner: null,
  total_wager_wei: '1000',
  winner_total_wei: '300',
  pot_for_winners_wei: '880',
  bullion_for_winners_wei: '1000000000',
  payout_mul_wad: '2933333333333333333',
  total_fee_lamports: '120',
  staking_gross_lamports: '80',
  staking_admin_lamports: '8',
  staking_net_lamports: '72',
  buyback_lamports: '10',
  motherlode_fee_lamports: '20',
  mining_admin_lamports: '10',
  admin_total_lamports: '18',
  admin_fee_wallet: 'admin',
  randomness_provider_kind: SWITCHBOARD_PROVIDER_KIND,
  randomness_id: 'randomness',
  randomness_value: '12',
  randomness_hex: '0c'.repeat(32),
  randomness_commit_slot: 50,
  solo_sample: '0',
  total_receipts: 2,
  processed_receipts: 2,
  settlement_signature: 'settle-signature',
  settlement_slot: 60,
  updated_at: 'mutable',
  buyback_completed: false,
};
const bets = [
  { round_id: 9, receipt: 'b', bettor: 'B', nonce: 2, square: 3, amount_wei: '200', cumulative_start_wei: '100', reward_mode: 1, deployment_signature: 'd2', deployment_slot: 45, created_at: 'mutable' },
  { round_id: 9, receipt: 'a', bettor: 'A', nonce: 1, square: 3, amount_wei: '100', cumulative_start_wei: '0', reward_mode: 0, deployment_signature: 'd1', deployment_slot: 44, created_at: 'mutable' },
];
const settlements = [
  { round_id: 9, receipt: 'b', authority: 'B', nonce: 2, status: 'claimed', sol_lamports: '587', myne_base_units: '666', motherlode_base_units: '0', signature: 'c2', slot: 62, updated_at: 'mutable' },
  { round_id: 9, receipt: 'a', authority: 'A', nonce: 1, status: 'claimed', sol_lamports: '293', myne_base_units: '334', motherlode_base_units: '0', signature: 'c1', slot: 61, updated_at: 'mutable' },
];
const buybacks = [{
  round_id: 9,
  sequence: 0,
  spend_lamports: '20',
  expected_output_base_units: '400',
  burned_base_units: '405',
  swap_signature: 'swap',
  burn_signature: 'burn',
  created_at: 'mutable',
}];

test('archive proof is deterministic across query order and operational timestamps', () => {
  const first = buildArchiveSnapshot({ program: 'program', round, bets, settlements, buybacks });
  const second = buildArchiveSnapshot({
    program: 'program',
    round: { ...round, updated_at: 'later', buyback_completed: true, archived_at: 'later' },
    bets: [...bets].reverse().map((bet) => ({ ...bet, created_at: 'later' })),
    settlements: [...settlements].reverse().map((entry) => ({ ...entry, updated_at: 'later' })),
    buybacks: buybacks.map((entry) => ({ ...entry, created_at: 'later' })),
  });
  assert.equal(archiveHash(first), archiveHash(second));
});

test('archive proof changes when economic history changes', () => {
  const first = buildArchiveSnapshot({ program: 'program', round, bets, settlements, buybacks });
  const changed = buildArchiveSnapshot({
    program: 'program', round, bets: [{ ...bets[0], amount_wei: '201' }, bets[1]], settlements, buybacks,
  });
  assert.notEqual(archiveHash(first), archiveHash(changed));
});

test('zero-bid settled round archives its winning tile with no reward or participant rows', () => {
  const emptyRound = {
    ...round,
    round_id: 10,
    winning_square: 21,
    total_wager_wei: '0',
    winner_total_wei: '0',
    pot_for_winners_wei: '0',
    bullion_for_winners_wei: '0',
    payout_mul_wad: '0',
    total_fee_lamports: '0',
    staking_gross_lamports: '0',
    staking_admin_lamports: '0',
    staking_net_lamports: '0',
    buyback_lamports: '0',
    motherlode_fee_lamports: '0',
    mining_admin_lamports: '0',
    admin_total_lamports: '0',
    total_receipts: 0,
    processed_receipts: 0,
  };
  const audit = requireRoundFeeAudit(emptyRound);
  assert.equal(audit.total_fee_lamports, 0n);
  const snapshot = buildArchiveSnapshot({
    program: 'program', round: emptyRound, bets: [], settlements: [], buybacks: [],
  });
  assert.equal(snapshot.round.winning_square, 21);
  assert.equal(snapshot.round.bullion_for_winners_wei, '0');
  assert.equal(snapshot.round.total_receipts, '0');
  assert.deepEqual(snapshot.bets, []);
  assert.deepEqual(snapshot.settlements, []);
  assert.equal(archiveHash(snapshot), archiveHash(buildArchiveSnapshot({
    program: 'program', round: emptyRound, bets: [], settlements: [], buybacks: [],
  })));
});

test('archive proof commits every round fee destination', () => {
  const first = buildArchiveSnapshot({ program: 'program', round, bets, settlements, buybacks });
  const changed = buildArchiveSnapshot({
    program: 'program',
    round: { ...round, staking_net_lamports: '71', staking_admin_lamports: '9' },
    bets,
    settlements,
    buybacks,
  });
  assert.equal(first.version, 2);
  assert.notEqual(archiveHash(first), archiveHash(changed));
});

test('Switchboard archive snapshots remain byte-compatible version 2', () => {
  const snapshot = buildArchiveSnapshot({ program: 'program', round, bets, settlements, buybacks });
  assert.equal(snapshot.version, 2);
  assert.equal('randomness_proof' in snapshot, false);
});

function hashHex(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function u64Le(value) {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64LE(BigInt(value));
  return encoded;
}

const serverProgramBytes = Buffer.alloc(32, 1);
const serverMintBytes = Buffer.alloc(32, 2);
const serverRevealHex = '07'.repeat(32);
const serverEntropyHashHex = '09'.repeat(32);
const serverCommitmentHex = hashHex([
  Buffer.from('MYNE_SERVER_COMMIT_V1'),
  serverProgramBytes,
  serverMintBytes,
  u64Le(round.round_id),
  Buffer.from(serverRevealHex, 'hex'),
]);
const serverOutputHex = hashHex([
  Buffer.from('MYNE_SERVER_OUTPUT_V1'),
  serverProgramBytes,
  serverMintBytes,
  u64Le(round.round_id),
  Buffer.from(serverRevealHex, 'hex'),
  u64Le(105),
  Buffer.from(serverEntropyHashHex, 'hex'),
]);
const serverRound = {
  ...round,
  randomness_provider_kind: SERVER_PROVIDER_KIND,
  randomness_id: null,
  randomness_commit_slot: null,
  randomness_commitment_hex: serverCommitmentHex,
  randomness_reveal_hex: serverRevealHex,
  randomness_target_slot: '101',
  randomness_entropy_slot: '105',
  randomness_entropy_hash_hex: serverEntropyHashHex,
  randomness_hex: serverOutputHex,
  randomness_commitment_signature: 'commit-signature',
  randomness_commitment_tx_slot: '90',
  randomness_lock_signature: 'lock-signature',
  randomness_lock_tx_slot: '100',
  randomness_reveal_signature: 'settle-signature',
  randomness_reveal_tx_slot: '110',
  settlement_signature: 'settle-signature',
  settlement_slot: '110',
};

test('complete server proof is verified and committed in a version 3 snapshot', () => {
  const proof = requireRoundRandomnessProof(serverRound, {
    programIdBytes: serverProgramBytes,
    mintBytes: serverMintBytes,
  });
  assert.equal(proof.commitment_hex, serverCommitmentHex);
  assert.equal(proof.entropy_slot, '105');

  const snapshot = buildArchiveSnapshot({
    program: 'program', round: serverRound, bets, settlements, buybacks,
  });
  assert.equal(snapshot.version, 3);
  assert.deepEqual(snapshot.randomness_proof, proof);
});

test('server archive rejects incomplete, non-atomic or cryptographically invalid proof', () => {
  const context = { programIdBytes: serverProgramBytes, mintBytes: serverMintBytes };
  assert.throws(
    () => requireRoundRandomnessProof({ ...serverRound, randomness_reveal_hex: null }, context),
    /missing reveal_hex/,
  );
  assert.throws(
    () => requireRoundRandomnessProof({
      ...serverRound, randomness_reveal_signature: 'different-signature',
    }, context),
    /must be atomic/,
  );
  assert.throws(
    () => requireRoundRandomnessProof({
      ...serverRound, randomness_commitment_hex: '01'.repeat(32),
    }, context),
    /does not match the pre-betting commitment/,
  );
  assert.throws(
    () => requireRoundRandomnessProof({ ...serverRound, randomness_hex: '02'.repeat(32) }, context),
    /does not match its archived entropy proof/,
  );
});

test('provider storage cannot disguise server evidence as a Switchboard account or signed slot', () => {
  const context = { programIdBytes: serverProgramBytes, mintBytes: serverMintBytes };
  assert.throws(
    () => requireRoundRandomnessProof({ ...serverRound, randomness_id: serverCommitmentHex }, context),
    /must not be stored as randomness_id/,
  );
  assert.throws(
    () => requireRoundRandomnessProof({ ...serverRound, randomness_commit_slot: 2n ** 63n }, context),
    /must not be stored as randomness_commit_slot/,
  );
  assert.throws(
    () => requireRoundRandomnessProof({ ...round, randomness_commit_slot: 2n ** 63n }),
    /server-tagged/,
  );
});

test('settled-round fee audit returns the indexed buyback allocation', () => {
  const audit = requireRoundFeeAudit(round);
  assert.equal(audit.buyback_lamports, 10n);
  assert.equal(audit.admin_total_lamports, 18n);
});

test('settled-round fee audit rejects missing or non-conserving evidence', () => {
  assert.throws(
    () => requireRoundFeeAudit({ ...round, buyback_lamports: null }),
    /missing buyback_lamports/,
  );
  assert.throws(
    () => requireRoundFeeAudit({ ...round, admin_total_lamports: '17' }),
    /administrator allocation/,
  );
  assert.throws(
    () => requireRoundFeeAudit({ ...round, total_fee_lamports: '119' }),
    /total mining fee/,
  );
});
