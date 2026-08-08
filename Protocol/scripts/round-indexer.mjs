/**
 * Durable Solana event indexer and round-archive attestor.
 *
 * The chain is authoritative. Supabase stores a rebuildable, read-only history
 * before temporary receipt/round PDAs are closed. Live mode requires the
 * randomness keeper key because only that configured signer may attest the
 * canonical archive hash on-chain.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  ComputeBudgetProgram, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  archiveHash,
  buildArchiveSnapshot,
  requireRoundFeeAudit,
  requireRoundRandomnessProof,
  SERVER_PROVIDER_KIND,
  SWITCHBOARD_PROVIDER_KIND,
} from './round-archive-policy.mjs';
import { requireMatchingSolanaNetwork } from './production-network-policy.mjs';
import {
  REFERRAL_PROJECTION_VERSION,
  compactReferralCode,
  minerRegistrationProjection,
  myneClaimProjection,
} from './referral-index-policy.mjs';
import { normalizeAnchorEventData, normalizeAnchorEventName } from './anchor-event-data.mjs';
import {
  archivedSnapshotProjectionDigest,
  archivedSnapshotRoundProjection,
  canonicalSignatureOrder,
  closedRoundNeedsCanonicalReplay,
  historicalRoundGapBatch,
  receiptSettlementStatus,
  recentScheduledRoundIds,
  refundedRoundProjectionMatchesChain,
  roundNeedsCanonicalReplay,
  roundProjectionMatchesArchivedProof,
  roundProjectionMatchesChain,
  staleReceiptSettlementRows,
  verifiedArchivedRoundProjection,
} from './round-reconciliation-policy.mjs';
import {
  attachProgramWake,
  createWakeSignal,
  emitWorkerHeartbeat,
  runWorkerTick,
} from './event-driven-loop.mjs';

const { AnchorProvider, EventParser, Program, setProvider } = anchor;
const PROGRAM_ID = new PublicKey(process.env.MYNE_PROGRAM_ID
  || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const environmentProvider = AnchorProvider.env();
// Projection, cursor and reconciliation must observe one finality boundary.
// Anchor's environment default can be `processed`, while log history below is
// explicitly finalized; mixing them lets a newer account state race ahead of
// the transaction stream that explains it.
const provider = new AnchorProvider(
  environmentProvider.connection,
  environmentProvider.wallet,
  { commitment: 'finalized', preflightCommitment: 'confirmed', skipPreflight: false },
);
setProvider(provider);
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed randomness/indexer wallet is required');
const program = new Program(idl, provider);
const parser = new EventParser(PROGRAM_ID, program.coder);
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS');
assert.ok(serviceRole, 'SUPABASE_SERVICE_ROLE_KEY is required and must remain server-side');

// A projection cursor belongs to the program/schema, not an RPC URL. Tying it
// to an endpoint made failover start a second cursor and a second lease while
// the first writer could still be active.
const INDEXER_ID = `${PROGRAM_ID.toBase58()}:rounds:v2`;
const REFERRAL_INDEXER_ID = `${INDEXER_ID}:referrals:v${REFERRAL_PROJECTION_VERSION}`;
const ROUND_GAP_CURSOR_ID = `${INDEXER_ID}:historical-gaps:v1`;
const intervalMs = Number(process.env.ROUND_INDEXER_INTERVAL_MS || 3000);
const tickTimeoutMs = Number(process.env.ROUND_INDEXER_TICK_TIMEOUT_MS || 120_000);
const realtimeDebounceMs = Number(process.env.ROUND_INDEXER_REALTIME_DEBOUNCE_MS || 750);
const startSlot = Number(process.env.ROUND_INDEXER_START_SLOT ?? -1);
const referralStartSlot = Number(process.env.REFERRAL_INDEXER_START_SLOT ?? startSlot);
const maxPages = Number(process.env.ROUND_INDEXER_MAX_PAGES || 100);
const reconcileDepth = Number(process.env.ROUND_INDEXER_RECONCILE_DEPTH || 12);
const reconcileMaxPages = Number(process.env.ROUND_INDEXER_RECONCILE_MAX_PAGES || 4);
const reconcileGapBatch = Number(process.env.ROUND_INDEXER_GAP_BATCH || 8);
const closedProofMaxRows = Number(process.env.ROUND_INDEXER_CLOSED_PROOF_MAX_ROWS || 100_000);
const settlementRepairMaxRows = Number(
  process.env.ROUND_INDEXER_SETTLEMENT_REPAIR_MAX_ROWS || 10_000,
);
const settlementRepairBatch = Number(process.env.ROUND_INDEXER_SETTLEMENT_REPAIR_BATCH || 256);
const projectOnly = process.env.ROUND_INDEXER_PROJECT_ONLY === '1';
const requireBuybackEvidence = process.env.ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE === '1';
// A supervised child can be restarted after an RPC watchdog timeout while its
// database lease is still live. The host supplies one stable, replica-scoped
// holder so that replacement child can resume immediately without defeating
// fencing between distinct hosts/replicas.
const indexerInstanceId = String(process.env.ROUND_INDEXER_LEASE_HOLDER || '').trim() || randomUUID();
const SERVER_RANDOMNESS_SLOT_FLAG = 1n << 63n;
const SERVER_RANDOMNESS_SLOT_MASK = SERVER_RANDOMNESS_SLOT_FLAG - 1n;
const SIGNED_BIGINT_MAX = SERVER_RANDOMNESS_SLOT_MASK;
const ROUND_PROJECTION_VERSION = 2;
assert.ok(Number.isInteger(intervalMs) && intervalMs >= 1000, 'ROUND_INDEXER_INTERVAL_MS must be >= 1000');
assert.ok(
  Number.isInteger(tickTimeoutMs) && tickTimeoutMs >= 15_000 && tickTimeoutMs <= 600_000,
  'ROUND_INDEXER_TICK_TIMEOUT_MS must be between 15000 and 600000',
);
assert.ok(
  Number.isInteger(realtimeDebounceMs) && realtimeDebounceMs >= 250 && realtimeDebounceMs <= 5_000,
  'ROUND_INDEXER_REALTIME_DEBOUNCE_MS must be between 250 and 5000',
);
assert.ok(Number.isInteger(referralStartSlot), 'REFERRAL_INDEXER_START_SLOT must be an integer');
assert.ok(Number.isInteger(maxPages) && maxPages > 0, 'ROUND_INDEXER_MAX_PAGES must be positive');
assert.match(
  String(process.env.ROUND_INDEXER_PROJECT_ONLY || '0'),
  /^(?:0|1)$/,
  'ROUND_INDEXER_PROJECT_ONLY must be 0 or 1',
);
assert.ok(
  Number.isInteger(reconcileDepth) && reconcileDepth > 0 && reconcileDepth <= 64,
  'ROUND_INDEXER_RECONCILE_DEPTH must be between 1 and 64',
);
assert.ok(
  Number.isInteger(reconcileMaxPages) && reconcileMaxPages > 0 && reconcileMaxPages <= 8,
  'ROUND_INDEXER_RECONCILE_MAX_PAGES must be between 1 and 8',
);
assert.ok(
  Number.isInteger(reconcileGapBatch) && reconcileGapBatch > 0 && reconcileGapBatch <= 32,
  'ROUND_INDEXER_GAP_BATCH must be between 1 and 32',
);
assert.ok(
  Number.isInteger(closedProofMaxRows) && closedProofMaxRows > 0 && closedProofMaxRows <= 250_000,
  'ROUND_INDEXER_CLOSED_PROOF_MAX_ROWS must be between 1 and 250000',
);
assert.ok(
  Number.isInteger(settlementRepairMaxRows)
    && settlementRepairMaxRows > 0
    && settlementRepairMaxRows <= 250_000,
  'ROUND_INDEXER_SETTLEMENT_REPAIR_MAX_ROWS must be between 1 and 250000',
);
assert.ok(
  Number.isInteger(settlementRepairBatch)
    && settlementRepairBatch > 0
    && settlementRepairBatch <= settlementRepairMaxRows,
  'ROUND_INDEXER_SETTLEMENT_REPAIR_BATCH must be within the settlement repair row bound',
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finalizedChainTimeSeconds = async () => {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const slot = await provider.connection.getSlot('finalized');
      for (let offset = 0; offset < 32 && slot >= offset; offset += 1) {
        try {
          const blockTime = await provider.connection.getBlockTime(slot - offset);
          if (Number.isInteger(blockTime)) return blockTime;
        } catch (error) {
          lastError = error;
          if (Number(error?.code) !== -32004) break;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(4_000, 250 * (2 ** attempt)));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Finalized chain time is temporarily unavailable${detail}`);
};
const asString = (value) => value?.toString?.() ?? String(value ?? 0);
const u64Seed = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(asString(value)));
  return buffer;
};
const receiptPda = (roundId, authority, nonce) => PublicKey.findProgramAddressSync([
  Buffer.from('bet'), u64Seed(roundId), new PublicKey(authority).toBuffer(), u64Seed(nonce),
], PROGRAM_ID)[0];
const roundPda = (roundId) => PublicKey.findProgramAddressSync([
  Buffer.from('round'), u64Seed(roundId),
], PROGRAM_ID)[0];
const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];
const indexedConfig = await program.account.protocolConfig.fetch(configPda);
assert.equal(Number(indexedConfig.version), 6, 'Round indexer requires protocol fee schedule v6');
const indexedNetwork = requireMatchingSolanaNetwork({
  genesisHash: await provider.connection.getGenesisHash(),
  randomnessProgram: indexedConfig.randomnessProgram.toBase58(),
  serverRandomnessProgram: process.env.MYNE_SERVER_RANDOMNESS_ACK === PROGRAM_ID.toBase58()
    ? PROGRAM_ID.toBase58()
    : null,
});
if (indexedNetwork === 'mainnet-beta' && !projectOnly) {
  assert.equal(
    requireBuybackEvidence,
    true,
    'Mainnet indexer requires ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE=1',
  );
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.ok(response.ok, `Supabase ${method} ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Page an exact, immutable round relation without PostgREST's 1,000-row cap.
 * Callers must supply a deterministic order and only use this after the chain
 * counters prove no more rows can be appended.
 */
async function restImmutableRoundRows(
  path,
  { pageSize = 1000, maxRows = closedProofMaxRows } = {},
) {
  assert.match(path, /round_id=eq\.[^&]+/);
  assert.match(path, /(?:^|&)order=/);
  assert.ok(Number.isInteger(maxRows) && maxRows >= 0 && maxRows <= 250_000,
    'Immutable round relation row bound must be 0..250000');
  const rows = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let offset = 0; offset <= maxRows; offset += pageSize) {
    const limit = Math.min(pageSize, maxRows + 1 - offset);
    const chunk = await rest(`${path}${separator}limit=${limit}&offset=${offset}`);
    rows.push(...(chunk || []));
    assert.ok(rows.length <= maxRows, 'Immutable round relation exceeds the archive row bound');
    if (!chunk || chunk.length < limit) return rows;
  }
  throw new Error('Immutable round relation exceeds the archive row bound');
}

/** Read a mutable exact-round relation without accepting a truncated proof. */
async function restBoundedRoundRows(path, { pageSize = 1000, maxRows } = {}) {
  assert.match(path, /round_id=eq\.[^&]+/);
  assert.match(path, /(?:^|&)order=/);
  assert.ok(Number.isInteger(maxRows) && maxRows > 0 && maxRows <= 250_000);
  const rows = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let offset = 0; offset <= maxRows; offset += pageSize) {
    const limit = Math.min(pageSize, maxRows + 1 - offset);
    const chunk = await rest(`${path}${separator}limit=${limit}&offset=${offset}`);
    rows.push(...(chunk || []));
    assert.ok(rows.length <= maxRows, 'Exact-round relation exceeds the reviewed repair bound');
    if (!chunk || chunk.length < limit) return rows;
  }
  throw new Error('Exact-round relation exceeds the reviewed repair bound');
}

async function acquireIndexerLease() {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/acquire_mine_keeper_lease`, {
    method: 'POST',
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_lease_name: `round-indexer:${PROGRAM_ID.toBase58()}:rounds:v2`,
      p_holder: indexerInstanceId,
      p_ttl_seconds: 120,
    }),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `Round indexer lease request failed (${response.status})`);
  return body === true;
}

const upsert = (table, rows, conflict) => rest(
  `${table}?on_conflict=${encodeURIComponent(conflict)}`,
  { method: 'POST', body: Array.isArray(rows) ? rows : [rows], prefer: 'resolution=merge-duplicates,return=minimal' },
);

async function requireIndexerSchema() {
  const rows = await rest(
    'mine_worker_schema_capabilities?select=release&release=eq.round-projection-v2&limit=1',
  );
  assert.equal(
    rows?.length,
    1,
    'Round index schema is incomplete; apply every Supabase migration through 20260808134500_round_projection_completeness.sql',
  );
}

async function ensureRound(roundId) {
  // Several events defensively ensure their parent row exists. A merge upsert
  // touched the row timestamp even when it already existed, creating a Realtime storm
  // during canonical replay. Ignore the conflict so this is insert-only.
  await rest('mine_rounds?on_conflict=round_id', {
    method: 'POST',
    body: [{ round_id: asString(roundId) }],
    prefer: 'resolution=ignore-duplicates,return=minimal',
  });
}

async function sendMeasured(instructions) {
  const latest = await provider.connection.getLatestBlockhash('confirmed');
  const simulationTransaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...instructions);
  const simulation = await provider.connection.simulateTransaction(simulationTransaction, [payer]);
  assert.equal(
    simulation.value.err,
    null,
    `Archive simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).join('\n')}`,
  );
  const measured = Math.max(50_000, Number(simulation.value.unitsConsumed || 200_000));
  const priority = Math.max(
    0,
    Math.min(1_000_000, Number(process.env.KEEPER_PRIORITY_MICROLAMPORTS || 0)),
  );
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: Math.min(1_400_000, Math.ceil(measured * 1.1)),
    }),
    ...(priority > 0
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority })]
      : []),
    ...instructions,
  );
  return sendAndConfirmTransaction(provider.connection, transaction, [payer], {
    commitment: 'confirmed', skipPreflight: false,
  });
}

function bytes(value) {
  return Buffer.from(Array.from(value || [], Number));
}

function eventHex32(value, label) {
  const encoded = bytes(value);
  assert.equal(encoded.length, 32, `${label} must contain exactly 32 bytes`);
  return encoded.toString('hex');
}

function eventU64(value, label) {
  const encoded = BigInt(asString(value));
  assert.ok(encoded >= 0n && encoded <= ((1n << 64n) - 1n), `${label} is not a u64`);
  return encoded;
}

async function processEvent(event, signature, slot, { canonicalReplay = false } = {}) {
  const data = normalizeAnchorEventData(event.data);
  const eventName = normalizeAnchorEventName(event.name);
  // Forward cursor writes carry their finalized transaction slot. Historical
  // canonical replay deliberately omits it: replay fills missing evidence but
  // must not claim to be a newer observation than the live cursor.
  const roundSource = {
    projection_version: ROUND_PROJECTION_VERSION,
    ...(canonicalReplay ? {} : { source_slot: asString(slot) }),
  };
  switch (eventName) {
    case 'RoundOpened': {
      await upsert('mine_rounds', {
        round_id: asString(data.roundId),
        rent_payer: new PublicKey(data.rentPayer).toBase58(),
        opened_at: asString(data.openedAt),
        betting_ends_at: asString(data.bettingEndsAt),
        settles_at: asString(data.settlesAt),
        refund_at: asString(data.refundAt),
        ...roundSource,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundRandomnessBound': {
      const commitSlot = eventU64(data.randomnessCommitSlot, 'Switchboard commit slot');
      assert.ok(
        commitSlot <= SIGNED_BIGINT_MAX,
        'Server-tagged slot cannot be indexed as a Switchboard commit slot',
      );
      await upsert('mine_rounds', {
        round_id: asString(data.roundId),
        randomness_provider_kind: SWITCHBOARD_PROVIDER_KIND,
        randomness_id: new PublicKey(data.randomnessAccount).toBase58(),
        randomness_commit_slot: commitSlot.toString(),
        ...roundSource,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundRandomnessCommitted': {
      const commitSlot = eventU64(data.randomnessCommitSlot, 'Switchboard commit slot');
      assert.ok(
        commitSlot > 0n && commitSlot <= SIGNED_BIGINT_MAX,
        'Server-tagged slot cannot be indexed as a Switchboard commit slot',
      );
      await upsert('mine_rounds', {
        round_id: asString(data.roundId),
        randomness_provider_kind: SWITCHBOARD_PROVIDER_KIND,
        randomness_id: new PublicKey(data.randomnessAccount).toBase58(),
        randomness_commit_slot: commitSlot.toString(),
        ...roundSource,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundServerCommitmentBound': {
      const roundId = asString(data.roundId);
      await ensureRound(roundId);
      await upsert('mine_rounds', {
        round_id: roundId,
        randomness_provider_kind: SERVER_PROVIDER_KIND,
        randomness_id: null,
        randomness_commit_slot: null,
        randomness_commitment_hex: eventHex32(data.commitment, 'Server commitment'),
        randomness_commitment_signature: signature,
        randomness_commitment_tx_slot: asString(slot),
        ...roundSource,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundServerEntropyLocked': {
      const roundId = asString(data.roundId);
      const targetSlot = eventU64(data.targetSlot, 'Server target slot');
      assert.ok(targetSlot > 0n, 'Server target slot must be positive');
      await ensureRound(roundId);
      await upsert('mine_rounds', {
        round_id: roundId,
        randomness_provider_kind: SERVER_PROVIDER_KIND,
        randomness_id: null,
        randomness_commit_slot: null,
        randomness_target_slot: targetSlot.toString(),
        randomness_lock_signature: signature,
        randomness_lock_tx_slot: asString(slot),
        ...roundSource,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundServerEntropyRevealed': {
      const roundId = asString(data.roundId);
      const targetSlot = eventU64(data.targetSlot, 'Server target slot');
      const entropySlot = eventU64(data.entropySlot, 'Server entropy slot');
      assert.ok(targetSlot > 0n && entropySlot >= targetSlot, 'Invalid server entropy slots');
      const randomnessHex = eventHex32(data.randomness, 'Server randomness output');
      await ensureRound(roundId);
      await upsert('mine_rounds', {
        round_id: roundId,
        randomness_provider_kind: SERVER_PROVIDER_KIND,
        randomness_id: null,
        randomness_commit_slot: null,
        randomness_commitment_hex: eventHex32(data.commitment, 'Server commitment'),
        randomness_reveal_hex: eventHex32(data.reveal, 'Server reveal'),
        randomness_target_slot: targetSlot.toString(),
        randomness_entropy_slot: entropySlot.toString(),
        randomness_entropy_hash_hex: eventHex32(data.slotHash, 'Server entropy hash'),
        randomness_value: BigInt(`0x${randomnessHex}`).toString(),
        randomness_hex: randomnessHex,
        randomness_reveal_signature: signature,
        randomness_reveal_tx_slot: asString(slot),
        ...roundSource,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'DeploymentCreated': {
      const roundId = asString(data.roundId);
      await ensureRound(roundId);
      const receipt = new PublicKey(data.receipt).toBase58();
      const authority = new PublicKey(data.authority).toBase58();
      const rows = data.amounts.map((amount, square) => ({
        round_id: roundId,
        receipt,
        // Base58 public keys are case-sensitive. Store the canonical address;
        // lowercasing changes the key and breaks indexed identity lookups.
        bettor: authority,
        nonce: asString(data.nonce),
        square,
        amount_wei: asString(amount),
        cumulative_start_wei: asString(data.cumulativeStarts[square]),
        reward_mode: Number(data.rewardMode),
        deployment_signature: signature,
        deployment_slot: slot,
      })).filter((row) => BigInt(row.amount_wei) > 0n);
      if (rows.length) {
        if (!canonicalReplay) {
          // A row previously proven complete becomes provisional as soon as a
          // newer finalized deployment is observed. Invalidate before adding
          // the new rows so no reader can cache a partial roster as complete.
          // The false-only filter avoids update/realtime churn.
          await rest(
            `mine_rounds?round_id=eq.${roundId}&projection_complete=eq.true`,
            {
              method: 'PATCH',
              body: { projection_complete: false, ...roundSource },
              prefer: 'return=minimal',
            },
          );
        }
        await upsert('mine_round_bets', rows, 'round_id,receipt,square');
        // One exact indexed read resolves a short social referral code. Never scan program
        // accounts or wildcard-query the ever-growing bet ledger in production.
        await upsert('mine_referral_codes', {
          code: compactReferralCode(authority), wallet_address: authority,
        }, 'wallet_address');
      }
      break;
    }
    case 'AutoPlanConfigured': {
      await upsert('mine_auto_plans', {
        authority: new PublicKey(data.authority).toBase58(),
        active: Boolean(data.active),
        reward_mode: Number(data.rewardMode),
        per_round_lamports: asString(data.perRoundLamports),
        balance_lamports: asString(data.balanceLamports),
        updated_slot: slot,
        updated_at: new Date().toISOString(),
      }, 'authority');
      break;
    }
    case 'AutoPlanFunded': {
      await upsert('mine_auto_plans', {
        authority: new PublicKey(data.authority).toBase58(),
        balance_lamports: asString(data.balanceLamports),
        updated_slot: slot,
        updated_at: new Date().toISOString(),
      }, 'authority');
      break;
    }
    case 'AutoPlanCancelled': {
      await upsert('mine_auto_plans', {
        authority: new PublicKey(data.authority).toBase58(),
        active: false,
        balance_lamports: '0',
        updated_slot: slot,
        updated_at: new Date().toISOString(),
      }, 'authority');
      break;
    }
    case 'AutoPlanExecuted': {
      await upsert('mine_auto_plans', {
        authority: new PublicKey(data.authority).toBase58(),
        balance_lamports: asString(data.balanceLamports),
        last_round: asString(data.roundId),
        next_nonce: (BigInt(asString(data.nonce)) + 1n).toString(),
        updated_slot: slot,
        updated_at: new Date().toISOString(),
      }, 'authority');
      break;
    }
    case 'RoundFeesDistributed': {
      const roundId = asString(data.roundId);
      await ensureRound(roundId);
      await upsert('mine_rounds', {
        round_id: roundId,
        total_fee_lamports: asString(data.totalFeeLamports),
        staking_gross_lamports: asString(data.stakingGrossLamports),
        staking_admin_lamports: asString(data.stakingAdminLamports),
        staking_net_lamports: asString(data.stakingNetLamports),
        buyback_lamports: asString(data.buybackLamports),
        motherlode_fee_lamports: asString(data.motherlodeLamports),
        mining_admin_lamports: asString(data.miningAdminLamports),
        admin_total_lamports: asString(data.adminTotalLamports),
        admin_fee_wallet: new PublicKey(data.adminFeeWallet).toBase58(),
        ...roundSource,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundSettled': {
      const roundId = asString(data.roundId);
      await ensureRound(roundId);
      const winningSquare = Number(data.winningTile);
      const roundState = await program.account.round.fetch(roundPda(roundId));
      const winnerTotal = BigInt(asString(roundState.tileLamports[winningSquare]));
      const prize = BigInt(asString(data.prizeLamports));
      const payoutMul = winnerTotal > 0n ? (prize * 1_000_000_000_000_000_000n) / winnerTotal : 0n;
      const soloSample = BigInt(asString(data.soloSample));
      const digest = (await fetchProjectionDigests([BigInt(roundId)])).get(roundId) ?? null;
      const projectionComplete = roundProjectionMatchesChain(roundState, digest);
      const soloWinner = data.soloMode && projectionComplete
        ? await indexedSoloWinner(roundId, winningSquare, soloSample)
        : null;
      const randomness = bytes(data.randomness);
      assert.equal(randomness.length, 32, 'Round randomness output must contain 32 bytes');
      const rawCommitSlot = eventU64(data.randomnessCommitSlot, 'Round randomness commit slot');
      const serverRound = (rawCommitSlot & SERVER_RANDOMNESS_SLOT_FLAG) !== 0n;
      let providerFields;
      if (serverRound) {
        const proofRows = await rest(
          `mine_rounds?round_id=eq.${roundId}`
          + '&select=randomness_provider_kind,randomness_id,randomness_commit_slot,'
          + 'randomness_commitment_hex,randomness_reveal_hex,randomness_target_slot,'
          + 'randomness_entropy_slot,randomness_entropy_hash_hex,'
          + 'randomness_commitment_signature,randomness_commitment_tx_slot,'
          + 'randomness_lock_signature,randomness_lock_tx_slot,'
          + 'randomness_reveal_signature,randomness_reveal_tx_slot',
        );
        const proof = {
          ...(proofRows?.[0] || {}),
          round_id: roundId,
          randomness_provider_kind: SERVER_PROVIDER_KIND,
          randomness_id: null,
          randomness_commit_slot: null,
          randomness_hex: randomness.toString('hex'),
          settlement_signature: signature,
          settlement_slot: asString(slot),
        };
        requireRoundRandomnessProof(proof, {
          programIdBytes: PROGRAM_ID.toBuffer(),
          mintBytes: indexedConfig.mint.toBuffer(),
        });
        assert.equal(
          (rawCommitSlot & SERVER_RANDOMNESS_SLOT_MASK).toString(),
          String(proof.randomness_entropy_slot),
          'Tagged round slot disagrees with the separately indexed entropy slot',
        );
        providerFields = {
          randomness_provider_kind: SERVER_PROVIDER_KIND,
          // The on-chain Round reuses these legacy fields internally. The
          // index never exposes a commitment as an Explorer account or writes
          // its high-bit-tagged u64 into PostgreSQL bigint.
          randomness_id: null,
          randomness_commit_slot: null,
        };
      } else {
        assert.ok(
          rawCommitSlot <= SIGNED_BIGINT_MAX,
          'Switchboard commit slot exceeds PostgreSQL signed bigint',
        );
        providerFields = {
          randomness_provider_kind: SWITCHBOARD_PROVIDER_KIND,
          randomness_id: new PublicKey(data.randomnessAccount).toBase58(),
          randomness_commit_slot: rawCommitSlot.toString(),
        };
      }
      await upsert('mine_rounds', {
        round_id: roundId,
        resolved: true,
        winning_square: winningSquare,
        jackpot_hit: Boolean(data.motherlodeHit),
        single_miner_round: Boolean(data.soloMode),
        winner: soloWinner,
        total_wager_wei: asString(data.grossDeployedLamports),
        winner_total_wei: winnerTotal.toString(),
        pot_for_winners_wei: prize.toString(),
        bullion_for_winners_wei: asString(data.baseEmission),
        payout_mul_wad: payoutMul.toString(),
        randomness_value: BigInt(`0x${randomness.toString('hex') || '0'}`).toString(),
        randomness_hex: randomness.toString('hex'),
        ...providerFields,
        solo_sample: soloSample.toString(),
        total_receipts: asString(data.totalReceipts),
        projection_complete: projectionComplete,
        settlement_signature: signature,
        settlement_slot: slot,
        ...roundSource,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'ReceiptClaimed':
    case 'ReceiptRewardAccruedV1':
    case 'ReceiptRefunded':
    case 'ReceiptClosed': {
      const roundId = asString(data.roundId);
      const authority = new PublicKey(data.authority).toBase58();
      const nonce = asString(data.nonce);
      const status = receiptSettlementStatus(eventName);
      assert.ok(status, `Unsupported receipt lifecycle event ${eventName}`);
      await upsert('mine_receipt_settlements', {
        round_id: roundId,
        receipt: receiptPda(roundId, authority, nonce).toBase58(),
        authority,
        nonce,
        // `claimed` is retained for historical transactions whose receipt
        // processor also transferred SOL directly to the wallet. New program
        // releases emit `accrued`: receipt rewards are safely in the claim
        // vault, but still require the owner-signed SOL claim instruction.
        status,
        sol_lamports: asString(data.solLamports || data.lamports || 0),
        myne_base_units: asString(data.myneBaseUnits || 0),
        motherlode_base_units: asString(data.motherlodeBaseUnits || 0),
        signature,
        slot,
        updated_at: new Date().toISOString(),
      }, 'round_id,receipt,status');
      // Aggregate in Postgres. An unbounded PostgREST select silently caps at
      // 1,000 rows and previously froze these counters on large rounds.
      const digest = (await fetchProjectionDigests([BigInt(roundId)])).get(roundId);
      assert.ok(digest, `Missing participant digest for round ${roundId}`);
      await rest(`mine_rounds?round_id=eq.${roundId}`, {
        method: 'PATCH',
        body: eventName === 'ReceiptClosed'
          ? { closed_receipts: digest.indexed_closed_receipts, ...roundSource, updated_at: new Date().toISOString() }
          : { processed_receipts: digest.indexed_processed_receipts, ...roundSource, updated_at: new Date().toISOString() },
        prefer: 'return=minimal',
      });
      break;
    }
    case 'BuybackCompleted': {
      await rest(`mine_rounds?round_id=eq.${asString(data.roundId)}`, {
        method: 'PATCH', body: { buyback_completed: true, ...roundSource, updated_at: new Date().toISOString() }, prefer: 'return=minimal',
      });
      break;
    }
    case 'RoundArchived': {
      await upsert('mine_rounds', {
        round_id: asString(data.roundId),
        archive_hash: bytes(data.archiveHash).toString('hex'),
        archive_slot: asString(data.slot),
        archived_at: new Date().toISOString(),
        ...roundSource,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundClosed': {
      await rest(`mine_rounds?round_id=eq.${asString(data.roundId)}`, {
        method: 'PATCH', body: { closed_signature: signature, closed_slot: slot, ...roundSource, updated_at: new Date().toISOString() }, prefer: 'return=minimal',
      });
      break;
    }
    default:
      break;
  }
}

async function state(id = INDEXER_ID) {
  const rows = await rest(`mine_indexer_state?id=eq.${encodeURIComponent(id)}&select=*`);
  if (rows?.[0]) return rows[0];

  // One-time endpoint-keyed cursor adoption. The signature stream is the same
  // canonical Mainnet history across honest RPCs, so the newest existing
  // program projection is a safe starting point for the stable v2 identity.
  // Persist the adopted row before returning; later failovers use only v2.
  const candidates = await rest(
    'mine_indexer_state?select=*&order=newest_slot.desc&limit=64',
  );
  const referralCursor = id === REFERRAL_INDEXER_ID;
  const legacy = (candidates || []).find((candidate) => {
    const candidateId = String(candidate.id || '');
    if (!candidateId.startsWith(`${PROGRAM_ID.toBase58()}:`)) return false;
    return referralCursor
      ? candidateId.includes(':referrals:')
      : !candidateId.includes(':referrals:')
        && !candidateId.includes(':historical-gaps:')
        && candidateId !== INDEXER_ID;
  });
  if (!legacy) return null;
  const adopted = {
    ...legacy,
    id,
    updated_at: new Date().toISOString(),
  };
  await upsert('mine_indexer_state', adopted, 'id');
  return adopted;
}

async function registeredReferrer(authority) {
  const rows = await rest(
    `mine_referral_miners_v1?authority=eq.${encodeURIComponent(authority)}&select=referrer&limit=1`,
  );
  return rows?.[0]?.referrer ?? null;
}

async function processReferralEvents(events, signature, slot) {
  const normalizedEvents = events.map((event) => ({
    ...event,
    name: normalizeAnchorEventName(event.name),
    data: normalizeAnchorEventData(event.data),
  }));
  const pairedRoutes = new Set();
  for (let eventIndex = 0; eventIndex < normalizedEvents.length; eventIndex += 1) {
    const event = normalizedEvents[eventIndex];
    if (event.name === 'MinerRegistered') {
      const registration = minerRegistrationProjection({
        data: event.data, signature, slot, eventIndex,
      });
      // The conflict target is the immutable event identity. A second registration event for the
      // same authority fails the table's unique constraint instead of rewriting attribution.
      await upsert(
        'mine_referral_miners_v1',
        registration,
        'registration_signature,registration_event_index',
      );
      await upsert('mine_referral_codes', {
        code: compactReferralCode(registration.authority),
        wallet_address: registration.authority,
      }, 'wallet_address');
      continue;
    }
    if (event.name !== 'MyneClaimed') continue;

    // v2 is a companion event rather than an in-place MyneClaimed layout change, preserving
    // decoding of historical logs. It is emitted immediately after the stable claim event.
    const next = normalizedEvents[eventIndex + 1];
    const route = next?.name === 'ClaimFeeRoutedV2' ? next : null;
    if (route) pairedRoutes.add(eventIndex + 1);
    const claimant = new PublicKey(event.data.authority).toBase58();
    const projection = myneClaimProjection({
      data: event.data,
      routingData: route?.data ?? null,
      mappedReferrer: await registeredReferrer(claimant),
      signature,
      slot,
      eventIndex,
      routingEventIndex: route ? eventIndex + 1 : null,
    });
    await upsert(
      'mine_referral_claims_v1',
      projection,
      'claim_signature,claim_event_index',
    );
  }

  const orphanedRoute = normalizedEvents.findIndex(
    (event, index) => event.name === 'ClaimFeeRoutedV2' && !pairedRoutes.has(index),
  );
  assert.equal(
    orphanedRoute,
    -1,
    'ClaimFeeRoutedV2 must immediately follow the MyneClaimed event it audits',
  );
}

async function replayTransactions(signatures) {
  let transactions = 0;
  let events = 0;
  for (const signature of signatures) {
    assert.match(signature, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/, 'Replay signature is not valid base58');
    const transaction = await provider.connection.getTransaction(signature, {
      commitment: 'finalized', maxSupportedTransactionVersion: 0,
    });
    assert.ok(transaction?.meta?.logMessages, `Finalized replay transaction ${signature} is unavailable`);
    assert.equal(transaction.meta.err, null, `Replay transaction ${signature} failed on chain`);
    const parsed = [...parser.parseLogs(transaction.meta.logMessages)];
    assert.ok(parsed.length > 0, `Replay transaction ${signature} contains no MYNE events`);
    for (const event of parsed) {
      await processEvent(event, signature, transaction.slot, { canonicalReplay: true });
    }
    await processReferralEvents(parsed, signature, transaction.slot);
    transactions += 1;
    events += parsed.length;
  }
  return { transactions, events };
}

async function signaturesSince(previous, minimumSlot = startSlot) {
  const gathered = [];
  let before;
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await provider.connection.getSignaturesForAddress(PROGRAM_ID, {
      limit: 1000,
      ...(before ? { before } : {}),
      ...(previous ? { until: previous } : {}),
    }, 'finalized');
    if (!rows.length) break;
    gathered.push(...rows.filter((row) => row.err == null && (previous || row.slot >= minimumSlot)));
    before = rows.at(-1).signature;
    if (rows.length < 1000 || (!previous && rows.at(-1).slot < minimumSlot)) break;
    assert.notEqual(page, maxPages - 1, 'Indexer page limit reached; raise ROUND_INDEXER_MAX_PAGES before continuing');
  }
  return gathered.reverse();
}

async function indexTransactions() {
  const cursor = await state();
  if (!cursor) assert.ok(startSlot >= 0, 'Set ROUND_INDEXER_START_SLOT for the first production backfill');
  const rows = await signaturesSince(cursor?.newest_signature || null);
  for (const row of rows) {
    const transaction = await provider.connection.getTransaction(row.signature, {
      commitment: 'finalized', maxSupportedTransactionVersion: 0,
    });
    assert.ok(
      transaction?.meta?.logMessages,
      `Finalized transaction ${row.signature} is temporarily unavailable; cursor not advanced`,
    );
    for (const event of parser.parseLogs(transaction.meta.logMessages)) {
      await processEvent(event, row.signature, row.slot);
    }
    await upsert('mine_indexer_state', {
      id: INDEXER_ID,
      newest_signature: row.signature,
      newest_slot: row.slot,
      updated_at: new Date().toISOString(),
    }, 'id');
  }
  return rows.length;
}

/**
 * Referral projection has its own versioned cursor so adding it to an already-running round
 * indexer performs a finalized log backfill instead of starting at the round cursor's head.
 * This scans transaction history only; it never performs full program-account enumeration.
 */
async function indexReferralTransactions() {
  const cursor = await state(REFERRAL_INDEXER_ID);
  if (!cursor) {
    assert.ok(
      referralStartSlot >= 0,
      'Set REFERRAL_INDEXER_START_SLOT to the program deployment slot for the referral v1 backfill',
    );
  }
  const rows = await signaturesSince(cursor?.newest_signature || null, referralStartSlot);
  for (const row of rows) {
    const transaction = await provider.connection.getTransaction(row.signature, {
      commitment: 'finalized', maxSupportedTransactionVersion: 0,
    });
    assert.ok(
      transaction?.meta?.logMessages,
      `Finalized referral transaction ${row.signature} is temporarily unavailable; cursor not advanced`,
    );
    const events = [...parser.parseLogs(transaction.meta.logMessages)];
    await processReferralEvents(events, row.signature, row.slot);
    await upsert('mine_indexer_state', {
      id: REFERRAL_INDEXER_ID,
      newest_signature: row.signature,
      newest_slot: row.slot,
      updated_at: new Date().toISOString(),
    }, 'id');
  }
  return rows.length;
}

async function canonicalRoundSignatures(address) {
  const gathered = [];
  let before;
  for (let page = 0; page < reconcileMaxPages; page += 1) {
    const rows = await provider.connection.getSignaturesForAddress(address, {
      limit: 1000,
      ...(before ? { before } : {}),
    }, 'finalized');
    gathered.push(...rows);
    if (rows.length < 1000) return canonicalSignatureOrder(gathered);
    before = rows.at(-1).signature;
  }
  throw new Error(
    `Round ${address.toBase58()} exceeds the bounded canonical replay history; `
    + 'raise ROUND_INDEXER_RECONCILE_MAX_PAGES after capacity review',
  );
}

function canonicalReceiptSettlement(event, signature, slot, roundId) {
  const eventName = normalizeAnchorEventName(event.name);
  const status = receiptSettlementStatus(eventName);
  if (!status) return null;
  const data = normalizeAnchorEventData(event.data);
  const authority = new PublicKey(data.authority).toBase58();
  const nonce = asString(data.nonce);
  return {
    round_id: asString(roundId),
    receipt: receiptPda(roundId, authority, nonce).toBase58(),
    status,
    signature,
    slot: asString(slot),
  };
}

async function pruneDisprovedSettlementRows(roundId, canonicalRows, historyComplete) {
  if (!historyComplete || !canonicalRows.length) return 0;
  const indexedRows = await restBoundedRoundRows(
    `mine_receipt_settlements?round_id=eq.${asString(roundId)}`
      + '&select=round_id,receipt,status,signature,slot'
      + '&order=receipt.asc,status.asc',
    { maxRows: settlementRepairMaxRows },
  );
  const staleRows = staleReceiptSettlementRows({
    roundId,
    indexedRows,
    canonicalRows,
    finalizedHistoryComplete: historyComplete,
    maxRows: settlementRepairMaxRows,
    maxDeletes: settlementRepairBatch,
  });
  let deleted = 0;
  for (const row of staleRows) {
    // Exact event identity guards make this safe if the forward cursor writes
    // a later genuine status between the proof read and this DELETE.
    const removed = await rest(
      `mine_receipt_settlements?round_id=eq.${asString(roundId)}`
        + `&receipt=eq.${encodeURIComponent(row.receipt)}`
        + `&status=eq.${encodeURIComponent(row.status)}`
        + `&signature=eq.${encodeURIComponent(row.signature)}`
        + `&slot=eq.${asString(row.slot)}`,
      { method: 'DELETE', prefer: 'return=representation' },
    );
    deleted += removed?.length || 0;
  }
  return deleted;
}

/**
 * Rebuild one exact round oldest-to-newest. Settlement depends on commitment,
 * lock, reveal, fee and bet events, so replaying only the settlement transaction
 * cannot repair a missing prerequisite. Every projection is an idempotent
 * upsert and the global cursor is deliberately untouched.
 */
async function replayCanonicalRoundHistory(
  roundId,
  address,
  { roundAccountAvailable = true } = {},
) {
  const signatures = await canonicalRoundSignatures(address);
  let transactions = 0;
  let settlementSignature = null;
  let historyComplete = true;
  const canonicalSettlements = [];
  for (const row of signatures) {
    const transaction = await provider.connection.getTransaction(row.signature, {
      commitment: 'finalized', maxSupportedTransactionVersion: 0,
    });
    if (!transaction?.meta?.logMessages || transaction.meta.err) {
      historyComplete = false;
      continue;
    }
    const events = [...parser.parseLogs(transaction.meta.logMessages)];
    const roundEvents = events.filter((event) => {
      const data = normalizeAnchorEventData(event.data);
      return data.roundId !== undefined && asString(data.roundId) === asString(roundId);
    });
    if (!roundEvents.length) continue;
    for (const event of roundEvents) {
      const eventName = normalizeAnchorEventName(event.name);
      const settlement = canonicalReceiptSettlement(
        event,
        row.signature,
        transaction.slot,
        roundId,
      );
      if (settlement) canonicalSettlements.push(settlement);
      // A closed Round PDA cannot satisfy RoundSettled's live account fetch.
      // Its already-verified archive retains those facts; replay still applies
      // every lifecycle, archive and close event needed to repair the index.
      if (roundAccountAvailable || eventName !== 'RoundSettled') {
        await processEvent(event, row.signature, transaction.slot, { canonicalReplay: true });
      }
      if (eventName === 'RoundSettled') {
        settlementSignature = row.signature;
      }
    }
    transactions += 1;
  }
  const settlementRowsPruned = await pruneDisprovedSettlementRows(
    roundId,
    canonicalSettlements,
    historyComplete,
  );
  return {
    transactions,
    settlementSignature,
    historyComplete,
    settlementRowsPruned,
  };
}

async function fetchProjectionDigests(roundIds) {
  if (!roundIds.length) return new Map();
  assert.ok(roundIds.length <= 128, 'Projection digest round batch exceeds the reviewed bound');
  const rows = await rest('rpc/mine_round_projection_digest', {
    method: 'POST',
    body: { p_round_ids: roundIds.map(asString) },
  });
  return new Map((rows || []).map((row) => [String(row.round_id), row]));
}

/**
 * Prove the alternate unresolved terminal state from finalized chain time and
 * exact immutable participant/refund rows. Aggregate counters alone cannot
 * distinguish a fully refunded round from a damaged projection.
 */
async function finalizedRefundProjectionMatches(roundId, state, digest, chainNow) {
  if (!state || state.settled || !digest
      || BigInt(chainNow) < BigInt(asString(state.refundAt))
      || BigInt(asString(state.processedReceipts)) !== BigInt(asString(state.totalReceipts))
      || BigInt(asString(state.grossDeployedLamports)) !== 0n
      || BigInt(asString(state.prizeLamports)) !== 0n) return false;
  const bets = await restImmutableRoundRows(
    `mine_round_bets?round_id=eq.${asString(roundId)}`
      + '&select=round_id,receipt,square,amount_wei&order=receipt.asc,square.asc',
    { maxRows: closedProofMaxRows },
  );
  const settlements = await restImmutableRoundRows(
    `mine_receipt_settlements?round_id=eq.${asString(roundId)}`
      + '&status=in.(claimed,accrued,refunded)'
      + '&select=round_id,receipt,status,sol_lamports,myne_base_units,motherlode_base_units'
      + '&order=receipt.asc,status.asc',
    { maxRows: closedProofMaxRows - bets.length },
  );
  return refundedRoundProjectionMatchesChain({
    chainRound: state,
    indexedProjection: digest,
    bets,
    settlements,
    finalizedChainTime: chainNow,
  });
}

async function indexedSoloWinner(roundId, winningSquare, soloSample) {
  const rows = await rest(
    `mine_round_bets?round_id=eq.${roundId}&square=eq.${winningSquare}`
      + `&cumulative_start_wei=lte.${soloSample}`
      + '&select=bettor,cumulative_start_wei,amount_wei'
      + '&order=cumulative_start_wei.desc&limit=1',
  );
  const candidate = rows?.[0];
  if (!candidate) return null;
  const start = BigInt(candidate.cumulative_start_wei);
  const amount = BigInt(candidate.amount_wei);
  return soloSample >= start && soloSample < start + amount ? candidate.bettor : null;
}

const chainRoundProjection = (
  roundId,
  state,
  { projectionComplete = false, soloWinner = null } = {},
) => {
  const settled = Boolean(state.settled);
  const winningSquare = Number(state.winningTile);
  const gross = BigInt(asString(state.grossDeployedLamports));
  const winnerTotal = settled && winningSquare >= 0 && winningSquare < 25
    ? BigInt(asString(state.tileLamports[winningSquare]))
    : 0n;
  const prize = BigInt(asString(state.prizeLamports));
  return {
    round_id: asString(roundId),
    rent_payer: state.rentPayer.toBase58(),
    opened_at: asString(state.openedAt),
    betting_ends_at: asString(state.bettingEndsAt),
    settles_at: asString(state.settlesAt),
    refund_at: asString(state.refundAt),
    resolved: settled,
    winning_square: settled ? winningSquare : null,
    jackpot_hit: settled ? Boolean(state.motherlodeHit) : false,
    single_miner_round: settled ? Boolean(state.soloMode) : false,
    winner: settled && Boolean(state.soloMode) && projectionComplete ? soloWinner : null,
    total_wager_wei: gross.toString(),
    winner_total_wei: winnerTotal.toString(),
    pot_for_winners_wei: prize.toString(),
    bullion_for_winners_wei: asString(state.baseEmission),
    payout_mul_wad: winnerTotal > 0n
      ? ((prize * 1_000_000_000_000_000_000n) / winnerTotal).toString()
      : '0',
    solo_sample: asString(state.soloSample),
    total_receipts: Number(asString(state.totalReceipts)),
    processed_receipts: Number(asString(state.processedReceipts)),
    closed_receipts: Number(asString(state.closedReceipts)),
    buyback_completed: Boolean(state.buybackCompleted),
    projection_complete: Boolean(projectionComplete),
    projection_version: ROUND_PROJECTION_VERSION,
  };
};

function requireRoundStateRandomnessEvidence(state, indexedRound) {
  assert.ok(state?.settled, 'Randomness evidence requires a settled Round account');
  const randomnessHex = bytes(state.randomness).toString('hex');
  assert.equal(randomnessHex.length, 64, 'Finalized Round randomness must contain 32 bytes');
  assert.equal(indexedRound.randomness_hex, randomnessHex,
    'Indexed randomness output disagrees with the finalized Round account');
  assert.equal(String(indexedRound.randomness_value), BigInt(`0x${randomnessHex}`).toString(),
    'Indexed randomness numeric output disagrees with the finalized Round account');
  const encodedSlot = BigInt(asString(state.randomnessCommitSlot));
  const serverRound = (encodedSlot & SERVER_RANDOMNESS_SLOT_FLAG) !== 0n;
  if (serverRound) {
    assert.equal(indexedRound.randomness_provider_kind, SERVER_PROVIDER_KIND,
      'Indexed provider disagrees with the finalized server-tagged Round account');
    assert.equal(indexedRound.randomness_id, null,
      'Server commitment must not be indexed as an account');
    assert.equal(indexedRound.randomness_commit_slot, null,
      'Server-tagged slot must not be indexed as a signed bigint');
    assert.equal(
      String(indexedRound.randomness_entropy_slot),
      (encodedSlot & SERVER_RANDOMNESS_SLOT_MASK).toString(),
      'Indexed server entropy slot disagrees with the finalized Round account',
    );
  } else {
    assert.ok(encodedSlot > 0n && encodedSlot <= SIGNED_BIGINT_MAX,
      'Finalized Switchboard commit slot is invalid');
    assert.equal(indexedRound.randomness_provider_kind, SWITCHBOARD_PROVIDER_KIND,
      'Indexed provider disagrees with the finalized Switchboard Round account');
    assert.equal(indexedRound.randomness_id, state.randomnessAccount.toBase58(),
      'Indexed Switchboard account disagrees with the finalized Round account');
    assert.equal(String(indexedRound.randomness_commit_slot), encodedSlot.toString(),
      'Indexed Switchboard commit slot disagrees with the finalized Round account');
  }
}

const sameProjectionValue = (left, right) => {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  if (typeof right === 'boolean') return (left === true || String(left) === 'true') === right;
  return String(left) === String(right);
};

/** Return only changed authoritative fields; no-op ticks emit no database update. */
const changedRoundProjection = (indexedRound, projection) => {
  if (!indexedRound) return { ...projection, updated_at: new Date().toISOString() };
  const changed = Object.fromEntries(
    Object.entries(projection).filter(([key, value]) => !sameProjectionValue(indexedRound[key], value)),
  );
  return Object.keys(changed).length
    ? { round_id: projection.round_id, ...changed, updated_at: new Date().toISOString() }
    : null;
};

/**
 * Walk the entire historical id range in a small persistent round-robin batch.
 * Recent-window reconciliation repairs fresh failures quickly; this watermark
 * eventually discovers an older row that is wholly absent (and therefore
 * cannot appear in a `resolved=false` database query).
 */
async function historicalGapPlan(currentRoundId) {
  const rows = await rest(
    `mine_indexer_state?id=eq.${encodeURIComponent(ROUND_GAP_CURSOR_ID)}`
      + '&select=newest_slot&limit=1',
  );
  const { ids, nextRoundId } = historicalRoundGapBatch({
    currentRoundId,
    recentDepth: reconcileDepth,
    nextRoundId: rows?.[0]?.newest_slot ?? 0n,
    batchSize: reconcileGapBatch,
  });
  return { ids, next: nextRoundId };
}

async function advanceHistoricalGapCursor(nextRoundId) {
  await upsert('mine_indexer_state', {
    id: ROUND_GAP_CURSOR_ID,
    newest_signature: null,
    newest_slot: asString(nextRoundId),
    updated_at: new Date().toISOString(),
  }, 'id');
}

/**
 * Reconcile both indexed stale rows and a fixed recent schedule window. The
 * latter discovers entirely missing database rows from deterministic Round PDA
 * addresses without a program-wide account scan. The same persistent gap walk
 * also revisits closed PDAs fairly: those can only recover completeness from a
 * recomputed, formerly on-chain-verified archive proof, never from absence.
 */
async function reconcileCanonicalRounds() {
  const chainNow = await finalizedChainTimeSeconds();
  const initializedAt = BigInt(asString(indexedConfig.initializedAt));
  const duration = BigInt(asString(indexedConfig.roundDurationSeconds));
  const currentRoundId = BigInt(chainNow) < initializedAt
    ? 0n
    : (BigInt(chainNow) - initializedAt) / duration;
  const recentIds = recentScheduledRoundIds(currentRoundId, reconcileDepth);
  const gapPlan = await historicalGapPlan(currentRoundId);
  const staleRows = await rest(
    'mine_rounds?closed_signature=is.null&resolved=eq.false'
      + `&settles_at=lte.${chainNow}`
      + '&select=round_id&order=round_id.desc&limit=32',
  );
  const ids = [...new Set([
    ...recentIds.map(String),
    ...(staleRows || []).map((row) => String(row.round_id)),
    ...gapPlan.ids.map(String),
  ])].map(BigInt);
  assert.ok(ids.length <= 128, 'Round reconciliation batch exceeds the reviewed bound');
  if (!ids.length) {
    await advanceHistoricalGapCursor(gapPlan.next);
    return {
      reconciled: 0,
      reconciliationFailures: 0,
      closedProofChecks: 0,
      closedProjectionRepairs: 0,
      settlementRowsPruned: 0,
    };
  }
  const addresses = ids.map(roundPda);
  const idFilter = ids.map(String).join(',');
  const [states, indexedRows, projectionDigests] = await Promise.all([
    program.account.round.fetchMultiple(addresses),
    rest(
      `mine_rounds?round_id=in.(${idFilter})&select=*`,
    ),
    fetchProjectionDigests(ids),
  ]);
  const indexedById = new Map((indexedRows || []).map((row) => [String(row.round_id), row]));
  const closedProofIds = ids.filter((_, index) => {
    const indexedRound = indexedById.get(String(ids[index]));
    return !states[index]
      && (indexedRound?.archive_verified === true || Boolean(indexedRound?.closed_signature));
  });
  const proofRows = closedProofIds.length
    ? await rest(
      `mine_round_proofs?round_id=in.(${closedProofIds.map(String).join(',')})`
        + '&select=round_id,archive_hash,canonical_snapshot',
    )
    : [];
  const proofById = new Map((proofRows || []).map((proof) => [String(proof.round_id), proof]));
  let reconciled = 0;
  let reconciliationFailures = 0;
  let closedProofChecks = 0;
  let closedProjectionRepairs = 0;
  let settlementRowsPruned = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const state = states[index];
    const roundId = ids[index];
    const key = String(roundId);
    const indexedRound = indexedById.get(key);
    if (!state) {
      if (!indexedRound
          || (indexedRound.archive_verified !== true && !indexedRound.closed_signature)) continue;
      closedProofChecks += 1;
      try {
        let checkedRound = indexedRound;
        let checkedDigest = projectionDigests.get(key) ?? null;
        let checkedProof = proofById.get(key) ?? null;
        let canonicalRoundProjection = null;
        let projectionComplete = roundProjectionMatchesArchivedProof({
          programId: PROGRAM_ID.toBase58(),
          indexedRound: checkedRound,
          storedProof: checkedProof,
          indexedProjection: checkedDigest,
          programIdBytes: PROGRAM_ID.toBuffer(),
          mintBytes: indexedConfig.mint.toBuffer(),
          maxRows: closedProofMaxRows,
        });
        if (closedRoundNeedsCanonicalReplay({
          indexedRound: checkedRound,
          projectionMatchesProof: projectionComplete,
        })) {
          if (checkedRound.projection_complete === true) {
            await rest(
              `mine_rounds?round_id=eq.${key}&projection_complete=eq.true`,
              {
                method: 'PATCH',
                body: {
                  projection_complete: false,
                  projection_version: ROUND_PROJECTION_VERSION,
                  updated_at: new Date().toISOString(),
                },
                prefer: 'return=minimal',
              },
            );
          }
          const replay = await replayCanonicalRoundHistory(
            roundId,
            addresses[index],
            { roundAccountAvailable: false },
          );
          settlementRowsPruned += replay.settlementRowsPruned;
          reconciled += 1;
          const [refreshedRows, refreshedDigests, refreshedProofs] = await Promise.all([
            rest(`mine_rounds?round_id=eq.${key}&select=*`),
            fetchProjectionDigests([roundId]),
            rest(
              `mine_round_proofs?round_id=eq.${key}`
                + '&select=round_id,archive_hash,canonical_snapshot&limit=1',
            ),
          ]);
          checkedRound = refreshedRows?.[0] ?? null;
          checkedDigest = refreshedDigests.get(key) ?? null;
          checkedProof = refreshedProofs?.[0] ?? null;
          assert.ok(checkedRound, `Archived round ${key} disappeared during canonical replay`);
          indexedById.set(key, checkedRound);
          canonicalRoundProjection = verifiedArchivedRoundProjection({
            programId: PROGRAM_ID.toBase58(),
            indexedRound: checkedRound,
            storedProof: checkedProof,
            programIdBytes: PROGRAM_ID.toBuffer(),
            mintBytes: indexedConfig.mint.toBuffer(),
            maxRows: closedProofMaxRows,
          }).roundProjection;
          const repairedRound = {
            ...checkedRound,
            ...canonicalRoundProjection,
            ...(checkedDigest ? {
              total_receipts: asString(checkedDigest.indexed_total_receipts),
              processed_receipts: asString(checkedDigest.indexed_processed_receipts),
              closed_receipts: asString(checkedDigest.indexed_closed_receipts),
            } : {}),
          };
          projectionComplete = replay.historyComplete && roundProjectionMatchesArchivedProof({
            programId: PROGRAM_ID.toBase58(),
            indexedRound: repairedRound,
            storedProof: checkedProof,
            indexedProjection: checkedDigest,
            programIdBytes: PROGRAM_ID.toBuffer(),
            mintBytes: indexedConfig.mint.toBuffer(),
            maxRows: closedProofMaxRows,
          });
        }
        const patch = changedRoundProjection(checkedRound, {
          ...(canonicalRoundProjection || {}),
          round_id: key,
          projection_complete: projectionComplete,
          projection_version: ROUND_PROJECTION_VERSION,
          ...(projectionComplete ? {
            total_receipts: asString(checkedDigest.indexed_total_receipts),
            processed_receipts: asString(checkedDigest.indexed_processed_receipts),
            closed_receipts: asString(checkedDigest.indexed_closed_receipts),
          } : {}),
        });
        if (patch) {
          await upsert('mine_rounds', patch, 'round_id');
          if (projectionComplete) closedProjectionRepairs += 1;
        }
        if (!projectionComplete) reconciliationFailures += 1;
      } catch (error) {
        reconciliationFailures += 1;
        console.error(JSON.stringify({
          at: new Date().toISOString(),
          event: 'closed-round-reconciliation-error',
          round: key,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      continue;
    }
    try {
      let digest = projectionDigests.get(key) ?? null;
      let refundProjectionComplete = await finalizedRefundProjectionMatches(
        roundId,
        state,
        digest,
        chainNow,
      );
      if (!refundProjectionComplete && roundNeedsCanonicalReplay({
        indexedRound,
        chainRound: state,
        indexedProjection: digest,
      })) {
        if (indexedRound?.projection_complete === true) {
          // A replay can take several paged RPC reads. Withdraw the health
          // assertion first so the frontend never treats its intermediate
          // writes as a final participant roster.
          await rest(
            `mine_rounds?round_id=eq.${key}&projection_complete=eq.true`,
            {
              method: 'PATCH',
              body: {
                projection_complete: false,
                projection_version: ROUND_PROJECTION_VERSION,
                updated_at: new Date().toISOString(),
              },
              prefer: 'return=minimal',
            },
          );
          indexedById.set(key, { ...indexedRound, projection_complete: false });
        }
        const replay = await replayCanonicalRoundHistory(roundId, addresses[index]);
        settlementRowsPruned += replay.settlementRowsPruned;
        digest = (await fetchProjectionDigests([roundId])).get(key) ?? null;
        refundProjectionComplete = await finalizedRefundProjectionMatches(
          roundId,
          state,
          digest,
          chainNow,
        );
        reconciled += 1;
      }
      const projectionComplete = refundProjectionComplete
        || roundProjectionMatchesChain(state, digest);
      const winningSquare = Number(state.winningTile);
      const soloWinner = state.settled && state.soloMode && projectionComplete
        ? await indexedSoloWinner(roundId, winningSquare, BigInt(asString(state.soloSample)))
        : null;
      // Counters and winner facts come directly from the account after event
      // replay, so a stale read model can never leave the public ledger stuck
      // on `unsettled` or processed_receipts=0.
      const projection = chainRoundProjection(roundId, state, { projectionComplete, soloWinner });
      const patch = changedRoundProjection(indexedById.get(key), projection);
      if (patch) await upsert('mine_rounds', patch, 'round_id');
    } catch (error) {
      reconciliationFailures += 1;
      console.error(JSON.stringify({
        at: new Date().toISOString(),
        event: 'round-reconciliation-error',
        round: key,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  await advanceHistoricalGapCursor(gapPlan.next);
  return {
    reconciled,
    reconciliationFailures,
    closedProofChecks,
    closedProjectionRepairs,
    settlementRowsPruned,
  };
}

async function archiveReadyRounds() {
  // Do not let old settled rounds awaiting buyback evidence starve newer
  // zero-volume or refund-only rounds that are already archival-ready. Each
  // queue is independently bounded; on-chain state remains authoritative.
  const [settledCandidates, refundCandidates] = await Promise.all([
    rest('mine_rounds?archive_verified=eq.false&closed_signature=is.null&resolved=eq.true&buyback_completed=eq.true&select=*&order=round_id.desc&limit=20'),
    rest('mine_rounds?archive_verified=eq.false&closed_signature=is.null&resolved=eq.false&select=*&order=round_id.desc&limit=20'),
  ]);
  const rounds = [...new Map(
    [...(settledCandidates || []), ...(refundCandidates || [])]
      .map((round) => [String(round.round_id), round]),
  ).values()];
  const chainNow = await finalizedChainTimeSeconds();
  let archived = 0;
  for (const round of rounds || []) {
    const address = roundPda(round.round_id);
    const state = await program.account.round.fetchNullable(address);
    if (!state) continue;
    if (!state.settled && BigInt(chainNow) < BigInt(asString(state.refundAt))) continue;
    if (Number(state.processedReceipts.toString()) !== Number(state.totalReceipts.toString())) continue;
    if (state.settled && !state.buybackCompleted) continue;
    const chainReceiptCount = Number(state.totalReceipts.toString());
    const digest = (await fetchProjectionDigests([BigInt(round.round_id)]))
      .get(String(round.round_id));
    if (!digest) continue;
    if (state.settled && !roundProjectionMatchesChain(state, digest)) continue;
    if (Number(digest.indexed_processed_receipts) !== chainReceiptCount) continue;
    const winningSquare = Number(state.winningTile);
    const soloWinner = state.settled && state.soloMode
      ? await indexedSoloWinner(
        BigInt(round.round_id),
        winningSquare,
        BigInt(asString(state.soloSample)),
      )
      : null;
    const authoritativeProjection = chainRoundProjection(
      BigInt(round.round_id),
      state,
      { projectionComplete: true, soloWinner },
    );
    const indexedRound = { ...round, ...authoritativeProjection };
    const bets = await restImmutableRoundRows(
      `mine_round_bets?round_id=eq.${round.round_id}&select=*&order=receipt.asc,square.asc`,
      { maxRows: closedProofMaxRows },
    );
    const settlements = await restImmutableRoundRows(
      `mine_receipt_settlements?round_id=eq.${round.round_id}`
        + '&status=in.(claimed,accrued,refunded)&select=*&order=receipt.asc,status.asc',
      { maxRows: closedProofMaxRows - bets.length },
    );
    if (!state.settled && !refundedRoundProjectionMatchesChain({
      chainRound: state,
      indexedProjection: digest,
      bets,
      settlements,
      finalizedChainTime: chainNow,
    })) continue;
    // A settled v6 round is not archival-ready until its exact on-chain fee
    // event has been indexed and the allocation conserves every lamport.
    // Refund-only rounds never distribute fees and therefore skip this gate.
    const feeAudit = state.settled ? requireRoundFeeAudit(indexedRound) : null;
    const buybacks = await restImmutableRoundRows(
      `mine_buyback_executions?round_id=eq.${round.round_id}&select=*&order=sequence.asc`,
      { maxRows: closedProofMaxRows - bets.length - settlements.length },
    );
    assert.ok(bets.length + settlements.length + buybacks.length <= closedProofMaxRows,
      'Archive snapshot exceeds the reviewed total row bound');
    if (requireBuybackEvidence && state.settled) {
      // Compare evidence to the amount emitted and indexed for this round. Do
      // not duplicate a version-specific basis-point formula in the indexer.
      const allocation = feeAudit.buyback_lamports;
      const evidenced = (buybacks || []).reduce(
        (sum, entry) => sum + BigInt(entry.spend_lamports), 0n,
      );
      if (evidenced !== allocation) continue;
    }
    if (state.settled) {
      requireRoundStateRandomnessEvidence(state, indexedRound);
      requireRoundRandomnessProof(indexedRound, {
        programIdBytes: PROGRAM_ID.toBuffer(),
        mintBytes: indexedConfig.mint.toBuffer(),
      });
    }
    // Future closed-PDA recovery can trust the snapshot only if every core
    // outcome/timing/economic field came from this finalized Round account.
    // Fee and provider evidence remain exact event proofs and were validated
    // above before this single authoritative projection write.
    const authoritativePatch = changedRoundProjection(round, authoritativeProjection);
    if (authoritativePatch) await upsert('mine_rounds', authoritativePatch, 'round_id');
    const snapshot = buildArchiveSnapshot({
      program: PROGRAM_ID.toBase58(), round: indexedRound, bets, settlements, buybacks,
    });
    archivedSnapshotRoundProjection(snapshot, {
      programId: PROGRAM_ID.toBase58(),
      expectedRoundId: String(round.round_id),
      programIdBytes: PROGRAM_ID.toBuffer(),
      mintBytes: indexedConfig.mint.toBuffer(),
    });
    archivedSnapshotProjectionDigest(snapshot, { maxRows: closedProofMaxRows });
    const snapshotHash = archiveHash(snapshot);
    const existingProofs = await rest(`mine_round_proofs?round_id=eq.${round.round_id}&select=archive_hash`);
    if (existingProofs?.length) {
      assert.equal(
        existingProofs[0].archive_hash,
        snapshotHash,
        `Stored archive proof for round ${round.round_id} disagrees with canonical history`,
      );
    }
    await upsert('mine_round_proofs', {
      round_id: round.round_id,
      archive_hash: snapshotHash,
      canonical_snapshot: snapshot,
      provider_kind: round.randomness_provider_kind,
      randomness_account: round.randomness_provider_kind === SWITCHBOARD_PROVIDER_KIND
        ? round.randomness_id : null,
      randomness_commit_slot: round.randomness_provider_kind === SWITCHBOARD_PROVIDER_KIND
        ? round.randomness_commit_slot : null,
      randomness_hex: round.randomness_hex,
      commitment_hex: round.randomness_commitment_hex,
      reveal_hex: round.randomness_reveal_hex,
      target_slot: round.randomness_target_slot,
      entropy_slot: round.randomness_entropy_slot,
      entropy_hash_hex: round.randomness_entropy_hash_hex,
      commitment_signature: round.randomness_commitment_signature,
      commitment_tx_slot: round.randomness_commitment_tx_slot,
      lock_signature: round.randomness_lock_signature,
      lock_tx_slot: round.randomness_lock_tx_slot,
      reveal_signature: round.randomness_reveal_signature,
      reveal_tx_slot: round.randomness_reveal_tx_slot,
      settlement_signature: round.settlement_signature,
    }, 'round_id');
    let attestedState = state;
    if (Number(attestedState.archivedAtSlot.toString()) === 0) {
      const instruction = await program.methods.archiveRound([...Buffer.from(snapshotHash, 'hex')]).accounts({
        config: PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0],
        round: address,
        randomnessAuthority: payer.publicKey,
      }).instruction();
      const signature = await sendMeasured([instruction]);
      await rest(`mine_round_proofs?round_id=eq.${round.round_id}`, {
        method: 'PATCH', body: { archived_signature: signature }, prefer: 'return=minimal',
      });
      attestedState = await program.account.round.fetch(address);
    }
    assert.equal(
      Buffer.from(attestedState.archiveHash).toString('hex'),
      snapshotHash,
      `On-chain archive hash for round ${round.round_id} disagrees with canonical history`,
    );
    await rest(`mine_rounds?round_id=eq.${round.round_id}`, {
      method: 'PATCH',
      body: {
        archive_hash: snapshotHash,
        archive_verified: true,
        total_receipts: chainReceiptCount,
        processed_receipts: Number(state.processedReceipts.toString()),
        buyback_completed: Boolean(state.buybackCompleted),
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      prefer: 'return=minimal',
    });
    archived += 1;
  }
  return archived;
}

export async function indexerTick() {
  if (!(await acquireIndexerLease())) {
    return {
      indexed: 0,
      reconciled: 0,
      reconciliationFailures: 0,
      closedProofChecks: 0,
      closedProjectionRepairs: 0,
      settlementRowsPruned: 0,
      archived: 0,
      referralsIndexed: 0,
      skipped: true,
      reason: 'round-indexer-lease-held-by-another-instance',
    };
  }
  // Repair exact recent/stale round histories before advancing the global
  // cursor. Otherwise a cursor that reaches RoundSettled while its earlier
  // proof event is absent fails before the recovery path can run.
  const {
    reconciled,
    reconciliationFailures,
    closedProofChecks,
    closedProjectionRepairs,
    settlementRowsPruned,
  } = await reconcileCanonicalRounds();
  const indexed = await indexTransactions();
  // Projection-only instances are safe to keep alive during a protocol pause
  // or stateful-worker shutdown. They read finalized accounts/logs and repair
  // Supabase, but cannot enter any archive/sign/send transaction path.
  const archived = projectOnly ? 0 : await archiveReadyRounds();
  const referralsIndexed = await indexReferralTransactions();
  return {
    indexed,
    reconciled,
    reconciliationFailures,
    closedProofChecks,
    closedProjectionRepairs,
    settlementRowsPruned,
    archived,
    referralsIndexed,
    projectOnly,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await requireIndexerSchema();
  const replaySignatures = process.argv
    .filter((argument) => argument.startsWith('--replay-signature='))
    .map((argument) => argument.slice('--replay-signature='.length));
  if (replaySignatures.length) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      event: 'round-indexer-replay',
      ...(await replayTransactions(replaySignatures)),
    }));
    process.exit(0);
  }
  const once = process.argv.includes('--once');
  const wake = createWakeSignal();
  if (!once) {
    try {
      await attachProgramWake({ connection: provider.connection, programId: PROGRAM_ID, wake });
      console.log(JSON.stringify({ at: new Date().toISOString(), event: 'round-indexer-realtime-ready' }));
    } catch (error) {
      console.warn(JSON.stringify({
        at: new Date().toISOString(), event: 'round-indexer-realtime-unavailable', message: String(error),
      }));
    }
  }
  do {
    emitWorkerHeartbeat('round-indexer', 'tick-start');
    try {
      const result = await runWorkerTick({
        worker: 'round-indexer',
        timeoutMs: tickTimeoutMs,
        task: indexerTick,
        onTimeout: (error) => {
          console.error(JSON.stringify({
            at: new Date().toISOString(),
            event: 'worker-tick-timeout',
            worker: 'round-indexer',
            timeoutMs: tickTimeoutMs,
            message: error.message,
          }));
          emitWorkerHeartbeat('round-indexer', 'tick-error', 'tick-timeout');
          process.exit(75);
        },
      });
      emitWorkerHeartbeat(
        'round-indexer',
        'tick-complete',
        result.skipped
          ? result.reason
          : result.reconciliationFailures > 0
            ? `partial-error:${result.reconciliationFailures}`
            : 'ok',
      );
      console.log(JSON.stringify({ at: new Date().toISOString(), event: 'round-indexer', ...result }));
    } catch (error) {
      emitWorkerHeartbeat('round-indexer', 'tick-error', error?.code || 'tick-error');
      console.error(JSON.stringify({ at: new Date().toISOString(), event: 'round-indexer-error', message: String(error) }));
      if (process.env.FAIL_FAST === '1') {
        process.exitCode = 1;
        break;
      }
    }
    if (!once && await wake.wait(intervalMs) === 'event') await sleep(realtimeDebounceMs);
  } while (!once);
}
