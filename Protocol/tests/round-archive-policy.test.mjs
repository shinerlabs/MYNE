import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveHash, buildArchiveSnapshot } from '../scripts/round-archive-policy.mjs';

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
  randomness_id: 'randomness',
  randomness_value: '12',
  randomness_hex: '0c',
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
