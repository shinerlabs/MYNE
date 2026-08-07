import { createHash } from 'node:crypto';

const textOrNull = (value) => (value === null || value === undefined ? null : String(value));
const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value));
const U64_MAX = (1n << 64n) - 1n;
const SIGNED_BIGINT_MAX = (1n << 63n) - 1n;
const HEX_32 = /^[0-9a-f]{64}$/;
const SERVER_COMMIT_DOMAIN = Buffer.from('MYNE_SERVER_COMMIT_V1');
const SERVER_OUTPUT_DOMAIN = Buffer.from('MYNE_SERVER_OUTPUT_V1');

export const SWITCHBOARD_PROVIDER_KIND = 'switchboard';
export const SERVER_PROVIDER_KIND = 'server_commit_reveal';

const FEE_AMOUNT_FIELDS = Object.freeze([
  'total_fee_lamports',
  'staking_gross_lamports',
  'staking_admin_lamports',
  'staking_net_lamports',
  'buyback_lamports',
  'motherlode_fee_lamports',
  'mining_admin_lamports',
  'admin_total_lamports',
]);

/**
 * Fail closed before a settled round is archived. These values come from the
 * on-chain RoundFeesDistributed event rather than a keeper-side fee formula,
 * so archived evidence remains correct across fee-schedule versions.
 */
export function requireRoundFeeAudit(round) {
  const fees = {};
  for (const field of FEE_AMOUNT_FIELDS) {
    const raw = round?.[field];
    if (raw === null || raw === undefined || raw === '') {
      throw new Error(`Round fee audit is missing ${field}`);
    }
    try {
      fees[field] = BigInt(String(raw));
    } catch {
      throw new Error(`Round fee audit has invalid ${field}`);
    }
    if (fees[field] < 0n) throw new Error(`Round fee audit has negative ${field}`);
  }
  if (!textOrNull(round?.admin_fee_wallet)) {
    throw new Error('Round fee audit is missing admin_fee_wallet');
  }
  if (fees.staking_gross_lamports
      !== fees.staking_net_lamports + fees.staking_admin_lamports) {
    throw new Error('Round fee audit does not conserve the gross staking allocation');
  }
  if (fees.admin_total_lamports
      !== fees.mining_admin_lamports + fees.staking_admin_lamports) {
    throw new Error('Round fee audit does not conserve the administrator allocation');
  }
  if (fees.total_fee_lamports !== fees.staking_net_lamports
      + fees.staking_admin_lamports
      + fees.buyback_lamports
      + fees.motherlode_fee_lamports
      + fees.mining_admin_lamports) {
    throw new Error('Round fee audit does not conserve the total mining fee');
  }
  return {
    ...fees,
    admin_fee_wallet: String(round.admin_fee_wallet),
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requiredText(value, label) {
  const text = textOrNull(value);
  if (!text) throw new Error(`Round randomness proof is missing ${label}`);
  return text;
}

function requiredHex32(value, label) {
  const text = requiredText(value, label);
  if (!HEX_32.test(text)) throw new Error(`Round randomness proof has invalid ${label}`);
  return text;
}

function requiredU64(value, label) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Round randomness proof is missing ${label}`);
  }
  let parsed;
  try {
    parsed = BigInt(String(value));
  } catch {
    throw new Error(`Round randomness proof has invalid ${label}`);
  }
  if (parsed < 0n || parsed > U64_MAX) {
    throw new Error(`Round randomness proof has out-of-range ${label}`);
  }
  return parsed;
}

function bytes32(value, label) {
  const bytes = Buffer.from(value || []);
  if (bytes.length !== 32) throw new Error(`${label} must contain exactly 32 bytes`);
  return bytes;
}

function u64Le(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function hashHex(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

/**
 * Verifies the complete provider-specific proof required before a settled
 * round can be archived and its temporary accounts can be closed.
 */
export function requireRoundRandomnessProof(round, { programIdBytes, mintBytes } = {}) {
  const providerKind = requiredText(round?.randomness_provider_kind, 'provider_kind');
  const outputHex = requiredHex32(round?.randomness_hex, 'randomness_hex');
  const settlementSignature = requiredText(
    round?.settlement_signature,
    'settlement_signature',
  );

  if (providerKind === SWITCHBOARD_PROVIDER_KIND) {
    requiredText(round?.randomness_id, 'randomness_account');
    const commitSlot = requiredU64(round?.randomness_commit_slot, 'randomness_commit_slot');
    if (commitSlot === 0n || commitSlot > SIGNED_BIGINT_MAX) {
      throw new Error('Switchboard randomness_commit_slot is invalid or server-tagged');
    }
    return {
      provider_kind: providerKind,
      randomness_account: String(round.randomness_id),
      randomness_commit_slot: commitSlot.toString(),
      randomness_hex: outputHex,
      settlement_signature: settlementSignature,
    };
  }

  if (providerKind !== SERVER_PROVIDER_KIND) {
    throw new Error(`Unsupported randomness provider_kind ${providerKind}`);
  }
  if (round?.randomness_id !== null && round?.randomness_id !== undefined) {
    throw new Error('Server commitment must not be stored as randomness_id');
  }
  if (round?.randomness_commit_slot !== null && round?.randomness_commit_slot !== undefined) {
    throw new Error('Server-tagged slot must not be stored as randomness_commit_slot');
  }

  const commitmentHex = requiredHex32(
    round?.randomness_commitment_hex,
    'commitment_hex',
  );
  const revealHex = requiredHex32(round?.randomness_reveal_hex, 'reveal_hex');
  const targetSlot = requiredU64(round?.randomness_target_slot, 'target_slot');
  const entropySlot = requiredU64(round?.randomness_entropy_slot, 'entropy_slot');
  const entropyHashHex = requiredHex32(
    round?.randomness_entropy_hash_hex,
    'entropy_hash_hex',
  );
  const commitmentSignature = requiredText(
    round?.randomness_commitment_signature,
    'commitment_signature',
  );
  const commitmentTxSlot = requiredU64(
    round?.randomness_commitment_tx_slot,
    'commitment_tx_slot',
  );
  const lockSignature = requiredText(round?.randomness_lock_signature, 'lock_signature');
  const lockTxSlot = requiredU64(round?.randomness_lock_tx_slot, 'lock_tx_slot');
  const revealSignature = requiredText(
    round?.randomness_reveal_signature,
    'reveal_signature',
  );
  const revealTxSlot = requiredU64(round?.randomness_reveal_tx_slot, 'reveal_tx_slot');
  const settlementSlot = requiredU64(round?.settlement_slot, 'settlement_slot');
  const roundId = requiredU64(round?.round_id, 'round_id');
  if (targetSlot === 0n || entropySlot < targetSlot) {
    throw new Error('Server entropy slot must be at or after a non-zero target slot');
  }
  if (commitmentTxSlot > lockTxSlot || lockTxSlot > revealTxSlot) {
    throw new Error('Server randomness transactions are not in canonical order');
  }
  if (revealSignature !== settlementSignature || revealTxSlot !== settlementSlot) {
    throw new Error('Server reveal and RoundSettled must be atomic in one transaction');
  }

  const program = bytes32(programIdBytes, 'programIdBytes');
  const mint = bytes32(mintBytes, 'mintBytes');
  const reveal = Buffer.from(revealHex, 'hex');
  const entropyHash = Buffer.from(entropyHashHex, 'hex');
  const expectedCommitment = hashHex([
    SERVER_COMMIT_DOMAIN,
    program,
    mint,
    u64Le(roundId),
    reveal,
  ]);
  if (commitmentHex !== expectedCommitment) {
    throw new Error('Server reveal does not match the pre-betting commitment');
  }
  const expectedOutput = hashHex([
    SERVER_OUTPUT_DOMAIN,
    program,
    mint,
    u64Le(roundId),
    reveal,
    u64Le(entropySlot),
    entropyHash,
  ]);
  if (outputHex !== expectedOutput) {
    throw new Error('Server randomness output does not match its archived entropy proof');
  }

  return {
    provider_kind: providerKind,
    commitment_hex: commitmentHex,
    reveal_hex: revealHex,
    target_slot: targetSlot.toString(),
    entropy_slot: entropySlot.toString(),
    entropy_hash_hex: entropyHashHex,
    randomness_hex: outputHex,
    commitment_signature: commitmentSignature,
    commitment_tx_slot: commitmentTxSlot.toString(),
    lock_signature: lockSignature,
    lock_tx_slot: lockTxSlot.toString(),
    reveal_signature: revealSignature,
    reveal_tx_slot: revealTxSlot.toString(),
    settlement_signature: settlementSignature,
    settlement_slot: settlementSlot.toString(),
  };
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
    total_fee_lamports: textOrNull(round.total_fee_lamports),
    staking_gross_lamports: textOrNull(round.staking_gross_lamports),
    staking_admin_lamports: textOrNull(round.staking_admin_lamports),
    staking_net_lamports: textOrNull(round.staking_net_lamports),
    buyback_lamports: textOrNull(round.buyback_lamports),
    motherlode_fee_lamports: textOrNull(round.motherlode_fee_lamports),
    mining_admin_lamports: textOrNull(round.mining_admin_lamports),
    admin_total_lamports: textOrNull(round.admin_total_lamports),
    admin_fee_wallet: textOrNull(round.admin_fee_wallet),
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

function canonicalServerRandomnessProof(round) {
  return {
    provider_kind: textOrNull(round.randomness_provider_kind),
    commitment_hex: textOrNull(round.randomness_commitment_hex),
    reveal_hex: textOrNull(round.randomness_reveal_hex),
    target_slot: textOrNull(round.randomness_target_slot),
    entropy_slot: textOrNull(round.randomness_entropy_slot),
    entropy_hash_hex: textOrNull(round.randomness_entropy_hash_hex),
    randomness_hex: textOrNull(round.randomness_hex),
    commitment_signature: textOrNull(round.randomness_commitment_signature),
    commitment_tx_slot: textOrNull(round.randomness_commitment_tx_slot),
    lock_signature: textOrNull(round.randomness_lock_signature),
    lock_tx_slot: textOrNull(round.randomness_lock_tx_slot),
    reveal_signature: textOrNull(round.randomness_reveal_signature),
    reveal_tx_slot: textOrNull(round.randomness_reveal_tx_slot),
    settlement_signature: textOrNull(round.settlement_signature),
    settlement_slot: textOrNull(round.settlement_slot),
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
  const snapshot = {
    // Preserve the exact v2 Switchboard snapshot shape and hash. Server
    // commit-reveal rounds opt into v3 and add a distinct proof object rather
    // than overloading randomness_account/randomness_commit_slot.
    version: round.randomness_provider_kind === SERVER_PROVIDER_KIND ? 3 : 2,
    program: String(program),
    round: canonicalRound(round),
    bets: canonicalBets,
    settlements: canonicalSettlements,
    buybacks: canonicalBuybacks,
  };
  if (snapshot.version === 3) {
    snapshot.randomness_proof = canonicalServerRandomnessProof(round);
  }
  return snapshot;
}

export function archiveHash(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}
