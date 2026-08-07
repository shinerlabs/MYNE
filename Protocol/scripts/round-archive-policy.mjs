import { createHash } from 'node:crypto';

const textOrNull = (value) => (value === null || value === undefined ? null : String(value));
const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalRound(round) {
  return {
    round_id: textOrNull(round.round_id),
    rent_payer: textOrNull(round.rent_payer),
    opened_at: textOrNull(round.opened_at),
    betting_ends_at: textOrNull(round.betting_ends_at),
    settles_at: textOrNull(round.settles_at),
    refund_at: textOrNull(round.refund_at),
    resolved: Boolean(round.resolved),
    winning_square: numberOrNull(round.winning_square),
    jackpot_hit: Boolean(round.jackpot_hit),
    single_miner_round: Boolean(round.single_miner_round),
    winner: textOrNull(round.winner),
    total_wager_wei: textOrNull(round.total_wager_wei),
    winner_total_wei: textOrNull(round.winner_total_wei),
    pot_for_winners_wei: textOrNull(round.pot_for_winners_wei),
    bullion_for_winners_wei: textOrNull(round.bullion_for_winners_wei),
    payout_mul_wad: textOrNull(round.payout_mul_wad),
    randomness_id: textOrNull(round.randomness_id),
    randomness_value: textOrNull(round.randomness_value),
    randomness_hex: textOrNull(round.randomness_hex),
    randomness_commit_slot: textOrNull(round.randomness_commit_slot),
    solo_sample: textOrNull(round.solo_sample),
    total_receipts: textOrNull(round.total_receipts),
    processed_receipts: textOrNull(round.processed_receipts),
    settlement_signature: textOrNull(round.settlement_signature),
    settlement_slot: textOrNull(round.settlement_slot),
  };
}

function canonicalBet(bet) {
  return {
    round_id: textOrNull(bet.round_id),
    receipt: textOrNull(bet.receipt),
    bettor: textOrNull(bet.bettor),
    nonce: textOrNull(bet.nonce),
    square: Number(bet.square),
    amount_wei: textOrNull(bet.amount_wei),
    cumulative_start_wei: textOrNull(bet.cumulative_start_wei),
    reward_mode: Number(bet.reward_mode),
    deployment_signature: textOrNull(bet.deployment_signature),
    deployment_slot: textOrNull(bet.deployment_slot),
  };
}

function canonicalSettlement(entry) {
  return {
    round_id: textOrNull(entry.round_id),
    receipt: textOrNull(entry.receipt),
    authority: textOrNull(entry.authority),
    nonce: textOrNull(entry.nonce),
    status: textOrNull(entry.status),
    sol_lamports: textOrNull(entry.sol_lamports),
    myne_base_units: textOrNull(entry.myne_base_units),
    motherlode_base_units: textOrNull(entry.motherlode_base_units),
    signature: textOrNull(entry.signature),
    slot: textOrNull(entry.slot),
  };
}

function canonicalBuyback(entry) {
  return {
    round_id: textOrNull(entry.round_id),
    sequence: Number(entry.sequence),
    spend_lamports: textOrNull(entry.spend_lamports),
    expected_output_base_units: textOrNull(entry.expected_output_base_units),
    burned_base_units: textOrNull(entry.burned_base_units),
    swap_signature: textOrNull(entry.swap_signature),
    burn_signature: textOrNull(entry.burn_signature),
  };
}

export function buildArchiveSnapshot({ program, round, bets, settlements, buybacks = [] }) {
  const canonicalBets = bets.map(canonicalBet).sort((left, right) => (
    left.receipt.localeCompare(right.receipt) || left.square - right.square
  ));
  const canonicalSettlements = settlements.map(canonicalSettlement).sort((left, right) => (
    left.receipt.localeCompare(right.receipt) || left.status.localeCompare(right.status)
  ));
  const canonicalBuybacks = buybacks.map(canonicalBuyback).sort((left, right) => (
    left.sequence - right.sequence
  ));
  return {
    version: 1,
    program: String(program),
    round: canonicalRound(round),
    bets: canonicalBets,
    settlements: canonicalSettlements,
    buybacks: canonicalBuybacks,
  };
}

export function archiveHash(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}
