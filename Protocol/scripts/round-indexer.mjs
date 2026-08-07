/**
 * Durable Solana event indexer and round-archive attestor.
 *
 * The chain is authoritative. Supabase stores a rebuildable, read-only history
 * before temporary receipt/round PDAs are closed. Live mode requires the
 * randomness keeper key because only that configured signer may attest the
 * canonical archive hash on-chain.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  ComputeBudgetProgram, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  archiveHash,
  buildArchiveSnapshot,
  requireRoundFeeAudit,
} from './round-archive-policy.mjs';
import { requireMatchingSolanaNetwork } from './production-network-policy.mjs';
import {
  REFERRAL_PROJECTION_VERSION,
  compactReferralCode,
  minerRegistrationProjection,
  myneClaimProjection,
} from './referral-index-policy.mjs';
import { normalizeAnchorEventData, normalizeAnchorEventName } from './anchor-event-data.mjs';

const { AnchorProvider, EventParser, Program, setProvider } = anchor;
const PROGRAM_ID = new PublicKey(process.env.MYNE_PROGRAM_ID
  || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed randomness/indexer wallet is required');
const program = new Program(idl, provider);
const parser = new EventParser(PROGRAM_ID, program.coder);
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS');
assert.ok(serviceRole, 'SUPABASE_SERVICE_ROLE_KEY is required and must remain server-side');

// RPC URLs commonly carry API keys. Persist only a stable digest as cursor
// identity so service credentials never enter Supabase rows, backups or logs.
const rpcIdentity = createHash('sha256')
  .update(provider.connection.rpcEndpoint)
  .digest('hex')
  .slice(0, 24);
const INDEXER_ID = `${PROGRAM_ID.toBase58()}:${rpcIdentity}`;
const REFERRAL_INDEXER_ID = `${INDEXER_ID}:referrals:v${REFERRAL_PROJECTION_VERSION}`;
const intervalMs = Number(process.env.ROUND_INDEXER_INTERVAL_MS || 3000);
const startSlot = Number(process.env.ROUND_INDEXER_START_SLOT ?? -1);
const referralStartSlot = Number(process.env.REFERRAL_INDEXER_START_SLOT ?? startSlot);
const maxPages = Number(process.env.ROUND_INDEXER_MAX_PAGES || 100);
const requireBuybackEvidence = process.env.ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE === '1';
const indexerInstanceId = randomUUID();
assert.ok(Number.isInteger(intervalMs) && intervalMs >= 1000, 'ROUND_INDEXER_INTERVAL_MS must be >= 1000');
assert.ok(Number.isInteger(referralStartSlot), 'REFERRAL_INDEXER_START_SLOT must be an integer');
assert.ok(Number.isInteger(maxPages) && maxPages > 0, 'ROUND_INDEXER_MAX_PAGES must be positive');

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
});
if (indexedNetwork === 'mainnet-beta') {
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

async function acquireIndexerLease() {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/acquire_mine_keeper_lease`, {
    method: 'POST',
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_lease_name: `round-indexer:${PROGRAM_ID.toBase58()}:${rpcIdentity}`,
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

async function ensureRound(roundId) {
  await upsert('mine_rounds', { round_id: asString(roundId), updated_at: new Date().toISOString() }, 'round_id');
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

async function processEvent(event, signature, slot) {
  const data = normalizeAnchorEventData(event.data);
  switch (normalizeAnchorEventName(event.name)) {
    case 'RoundOpened': {
      await upsert('mine_rounds', {
        round_id: asString(data.roundId),
        rent_payer: new PublicKey(data.rentPayer).toBase58(),
        opened_at: asString(data.openedAt),
        betting_ends_at: asString(data.bettingEndsAt),
        settles_at: asString(data.settlesAt),
        refund_at: asString(data.refundAt),
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundRandomnessBound': {
      await upsert('mine_rounds', {
        round_id: asString(data.roundId),
        randomness_id: new PublicKey(data.randomnessAccount).toBase58(),
        randomness_commit_slot: asString(data.randomnessCommitSlot),
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
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundSettled': {
      const roundId = asString(data.roundId);
      await ensureRound(roundId);
      const bets = await rest(`mine_round_bets?round_id=eq.${roundId}&select=bettor,receipt,square,amount_wei,cumulative_start_wei`);
      const winningSquare = Number(data.winningTile);
      const winners = (bets || []).filter((bet) => Number(bet.square) === winningSquare);
      const winnerTotal = winners.reduce((sum, bet) => sum + BigInt(bet.amount_wei), 0n);
      const prize = BigInt(asString(data.prizeLamports));
      const payoutMul = winnerTotal > 0n ? (prize * 1_000_000_000_000_000_000n) / winnerTotal : 0n;
      const soloSample = BigInt(asString(data.soloSample));
      const soloWinner = data.soloMode
        ? winners.find((bet) => {
          const start = BigInt(bet.cumulative_start_wei);
          return soloSample >= start && soloSample < start + BigInt(bet.amount_wei);
        })?.bettor ?? null
        : null;
      const randomness = bytes(data.randomness);
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
        randomness_id: new PublicKey(data.randomnessAccount).toBase58(),
        randomness_value: BigInt(`0x${randomness.toString('hex') || '0'}`).toString(),
        randomness_hex: randomness.toString('hex'),
        randomness_commit_slot: asString(data.randomnessCommitSlot),
        solo_sample: soloSample.toString(),
        total_receipts: asString(data.totalReceipts),
        settlement_signature: signature,
        settlement_slot: slot,
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'ReceiptClaimed':
    case 'ReceiptRefunded':
    case 'ReceiptClosed': {
      const roundId = asString(data.roundId);
      const authority = new PublicKey(data.authority).toBase58();
      const nonce = asString(data.nonce);
      await upsert('mine_receipt_settlements', {
        round_id: roundId,
        receipt: receiptPda(roundId, authority, nonce).toBase58(),
        authority,
        nonce,
        status: event.name === 'ReceiptClaimed' ? 'claimed' : event.name === 'ReceiptRefunded' ? 'refunded' : 'closed',
        sol_lamports: asString(data.solLamports || data.lamports || 0),
        myne_base_units: asString(data.myneBaseUnits || 0),
        motherlode_base_units: asString(data.motherlodeBaseUnits || 0),
        signature,
        slot,
        updated_at: new Date().toISOString(),
      }, 'round_id,receipt,status');
      const statusFilter = event.name === 'ReceiptClosed' ? 'closed' : 'claimed,refunded';
      const rows = await rest(`mine_receipt_settlements?round_id=eq.${roundId}&status=in.(${statusFilter})&select=receipt`);
      await rest(`mine_rounds?round_id=eq.${roundId}`, {
        method: 'PATCH',
        body: event.name === 'ReceiptClosed'
          ? { closed_receipts: new Set((rows || []).map((row) => row.receipt)).size, updated_at: new Date().toISOString() }
          : { processed_receipts: new Set((rows || []).map((row) => row.receipt)).size, updated_at: new Date().toISOString() },
        prefer: 'return=minimal',
      });
      break;
    }
    case 'BuybackCompleted': {
      await rest(`mine_rounds?round_id=eq.${asString(data.roundId)}`, {
        method: 'PATCH', body: { buyback_completed: true, updated_at: new Date().toISOString() }, prefer: 'return=minimal',
      });
      break;
    }
    case 'RoundArchived': {
      await upsert('mine_rounds', {
        round_id: asString(data.roundId),
        archive_hash: bytes(data.archiveHash).toString('hex'),
        archive_slot: asString(data.slot),
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, 'round_id');
      break;
    }
    case 'RoundClosed': {
      await rest(`mine_rounds?round_id=eq.${asString(data.roundId)}`, {
        method: 'PATCH', body: { closed_signature: signature, closed_slot: slot, updated_at: new Date().toISOString() }, prefer: 'return=minimal',
      });
      break;
    }
    default:
      break;
  }
}

async function state(id = INDEXER_ID) {
  const rows = await rest(`mine_indexer_state?id=eq.${encodeURIComponent(id)}&select=*`);
  return rows?.[0] ?? null;
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
    for (const event of parsed) await processEvent(event, signature, transaction.slot);
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

async function archiveReadyRounds() {
  const rounds = await rest('mine_rounds?archive_verified=eq.false&closed_signature=is.null&select=*&order=round_id.asc&limit=20');
  const chainNow = await finalizedChainTimeSeconds();
  let archived = 0;
  for (const round of rounds || []) {
    if (!round.resolved && (!round.refund_at || Number(round.refund_at) > chainNow)) continue;
    const address = roundPda(round.round_id);
    const state = await program.account.round.fetchNullable(address);
    if (!state) continue;
    if (Number(state.processedReceipts.toString()) !== Number(state.totalReceipts.toString())) continue;
    const bets = await rest(`mine_round_bets?round_id=eq.${round.round_id}&select=*&order=receipt.asc,square.asc`);
    const receiptCount = new Set((bets || []).map((bet) => bet.receipt)).size;
    const chainReceiptCount = Number(state.totalReceipts.toString());
    if (receiptCount !== chainReceiptCount) continue;
    const settlements = await rest(`mine_receipt_settlements?round_id=eq.${round.round_id}&status=in.(claimed,refunded)&select=*&order=receipt.asc`);
    const settlementCount = new Set((settlements || []).map((entry) => entry.receipt)).size;
    if (settlementCount !== chainReceiptCount) continue;
    if (state.settled && !state.buybackCompleted) continue;
    // A settled v6 round is not archival-ready until its exact on-chain fee
    // event has been indexed and the allocation conserves every lamport.
    // Refund-only rounds never distribute fees and therefore skip this gate.
    const feeAudit = state.settled ? requireRoundFeeAudit(round) : null;
    const buybacks = await rest(`mine_buyback_executions?round_id=eq.${round.round_id}&select=*&order=sequence.asc`);
    if (requireBuybackEvidence && state.settled) {
      // Compare evidence to the amount emitted and indexed for this round. Do
      // not duplicate a version-specific basis-point formula in the indexer.
      const allocation = feeAudit.buyback_lamports;
      const evidenced = (buybacks || []).reduce(
        (sum, entry) => sum + BigInt(entry.spend_lamports), 0n,
      );
      if (evidenced !== allocation) continue;
    }
    const indexedRound = {
      ...round,
      total_receipts: chainReceiptCount,
      processed_receipts: Number(state.processedReceipts.toString()),
    };
    const snapshot = buildArchiveSnapshot({
      program: PROGRAM_ID.toBase58(), round: indexedRound, bets, settlements, buybacks,
    });
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
      randomness_account: round.randomness_id,
      randomness_commit_slot: round.randomness_commit_slot,
      randomness_hex: round.randomness_hex,
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
      archived: 0,
      referralsIndexed: 0,
      skipped: true,
      reason: 'round-indexer-lease-held-by-another-instance',
    };
  }
  const indexed = await indexTransactions();
  const archived = await archiveReadyRounds();
  const referralsIndexed = await indexReferralTransactions();
  return { indexed, archived, referralsIndexed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
  do {
    try {
      console.log(JSON.stringify({ at: new Date().toISOString(), event: 'round-indexer', ...(await indexerTick()) }));
    } catch (error) {
      console.error(JSON.stringify({ at: new Date().toISOString(), event: 'round-indexer-error', message: String(error) }));
      if (process.env.FAIL_FAST === '1') {
        process.exitCode = 1;
        break;
      }
    }
    if (!once) await sleep(intervalMs);
  } while (!once);
}
