/**
 * Permissionless receipt settlement/refund and rent-recovery keeper.
 *
 * Supabase is used only as a durable address index. Every receipt, round,
 * beneficiary, counter and close precondition is fetched and enforced by the
 * on-chain program before a transaction can succeed.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { requireMatchingSolanaNetwork } from './production-network-policy.mjs';
import {
  historicalLifecycleQuery,
  nextHistoricalLifecycleCursor,
  processLifecycleRoundQueue,
  selectLifecycleRoundBatch,
} from './lifecycle-queue-policy.mjs';
import {
  attachProgramWake,
  createWakeSignal,
  emitWorkerHeartbeat,
  runWorkerTick,
} from './event-driven-loop.mjs';
import {
  BET_RECEIPT_ACCOUNT_SIZE,
  exactReceiptRecoveryScanOptions,
  validateRecoveredReceiptAccounts,
} from './receipt-recovery-policy.mjs';

const { AnchorProvider, Program, setProvider } = anchor;
const PROGRAM_ID = new PublicKey(process.env.MYNE_PROGRAM_ID
  || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed lifecycle keeper wallet is required');
const program = new Program(idl, provider);
assert.equal(
  program.coder.accounts.size('BetReceipt'),
  BET_RECEIPT_ACCOUNT_SIZE,
  'BetReceipt layout changed; review the exact recovery filter before running lifecycle',
);
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS');
assert.ok(serviceRole, 'SUPABASE_SERVICE_ROLE_KEY is required for indexed keeper reads');

const intervalMs = Math.max(1000, Number(process.env.LIFECYCLE_KEEPER_INTERVAL_MS || 5000));
const tickTimeoutMs = Number(process.env.LIFECYCLE_TICK_TIMEOUT_MS || 120_000);
const realtimeDebounceMs = Number(process.env.LIFECYCLE_REALTIME_DEBOUNCE_MS || 750);
const roundBatchSize = Number(process.env.LIFECYCLE_ROUND_BATCH_SIZE || 12);
const receiptRecoveryMaxAccounts = Number(
  process.env.LIFECYCLE_RECEIPT_RECOVERY_MAX_ACCOUNTS || 2048,
);
assert.ok(
  Number.isInteger(tickTimeoutMs) && tickTimeoutMs >= 15_000 && tickTimeoutMs <= 600_000,
  'LIFECYCLE_TICK_TIMEOUT_MS must be between 15000 and 600000',
);
assert.ok(
  Number.isInteger(realtimeDebounceMs) && realtimeDebounceMs >= 250 && realtimeDebounceMs <= 5_000,
  'LIFECYCLE_REALTIME_DEBOUNCE_MS must be between 250 and 5000',
);
assert.ok(
  Number.isInteger(roundBatchSize) && roundBatchSize >= 4 && roundBatchSize <= 50,
  'LIFECYCLE_ROUND_BATCH_SIZE must be between 4 and 50',
);
assert.ok(
  Number.isInteger(receiptRecoveryMaxAccounts)
    && receiptRecoveryMaxAccounts >= 1
    && receiptRecoveryMaxAccounts <= 10_000,
  'LIFECYCLE_RECEIPT_RECOVERY_MAX_ACCOUNTS must be between 1 and 10000',
);
const settleBatchSize = Math.max(1, Math.min(5, Number(process.env.RECEIPT_SETTLE_BATCH_SIZE || 3)));
const closeBatchSize = Math.max(1, Math.min(8, Number(process.env.RECEIPT_CLOSE_BATCH_SIZE || 6)));
const randomnessRetentionSeconds = Math.max(
  3600,
  Number(process.env.RANDOMNESS_RETENTION_SECONDS || 86_400),
);
// Keep the authoritative Round and receipt accounts readable beyond the result
// window. Settlement/reward accrual remains immediate; only rent cleanup waits.
// Two 65-second cycles lets a freshly opened or briefly disconnected client
// reconstruct the winner and participant card directly from confirmed PDAs.
const roundAccountRetentionSeconds = Math.max(
  65,
  Number(process.env.ROUND_ACCOUNT_RETENTION_SECONDS || 130),
);
// Recovery mode is intentionally narrower than the normal worker: it may
// close only receipts/rounds already proven processed and archived. This lets
// operators reclaim protocol rent during an upgrade without running an older
// receipt processor that could pay or mutate outstanding player rewards.
const recoveryCloseOnly = process.env.LIFECYCLE_RECOVERY_CLOSE_ONLY === '1';
const commitment = 'confirmed';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asBig = (value) => BigInt(value?.toString?.() ?? value ?? 0);
const u64Seed = (value) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
};
const pda = (seed, ...extra) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), ...extra.map((value) => Buffer.from(value))],
  PROGRAM_ID,
)[0];
const config = pda('config');
const miningPool = pda('mining_pool');
const stakePool = pda('stake_pool');
const lifecycleConfig = await program.account.protocolConfig.fetch(config);
assert.equal(Number(lifecycleConfig.version), 6, 'Lifecycle keeper requires protocol fee schedule v6');
requireMatchingSolanaNetwork({
  genesisHash: await provider.connection.getGenesisHash(),
  randomnessProgram: lifecycleConfig.randomnessProgram.toBase58(),
  serverRandomnessProgram: process.env.MYNE_SERVER_RANDOMNESS_ACK === PROGRAM_ID.toBase58()
    ? PROGRAM_ID.toBase58()
    : null,
});
const roundPda = (roundId) => pda('round', u64Seed(roundId));
const receiptPda = (roundId, authority, nonce) => PublicKey.findProgramAddressSync(
  [Buffer.from('bet'), u64Seed(roundId), authority.toBuffer(), u64Seed(nonce)],
  PROGRAM_ID,
);
const minerPda = (authority) => pda('miner', new PublicKey(authority).toBuffer());
const stakePda = (authority) => pda('stake_position', new PublicKey(authority).toBuffer());
let historicalRoundCursor = null;

async function rest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      ...(body ? { 'Content-Type': 'application/json', Prefer: 'return=minimal' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.ok(response.ok, `Supabase ${method} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function buildTransaction(instructions, units) {
  const latest = await provider.connection.getLatestBlockhash(commitment);
  const priority = Math.max(0, Math.min(1_000_000, Number(process.env.KEEPER_PRIORITY_MICROLAMPORTS || 0)));
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ...(priority ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority })] : []),
      ...instructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  return { transaction, latest };
}

async function sendMeasured(instructions) {
  const simulated = await buildTransaction(instructions, 1_400_000);
  const simulation = await provider.connection.simulateTransaction(simulated.transaction, {
    commitment,
    sigVerify: false,
  });
  assert.equal(
    simulation.value.err,
    null,
    `Lifecycle simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).join('\n')}`,
  );
  const measuredUnits = Math.max(50_000, Number(simulation.value.unitsConsumed || 1_400_000));
  const computeLimit = Math.min(1_400_000, Math.ceil(measuredUnits * 1.1));
  const built = await buildTransaction(instructions, computeLimit);
  const signature = await provider.connection.sendTransaction(built.transaction, {
    maxRetries: 3,
    skipPreflight: false,
  });
  const confirmation = await provider.connection.confirmTransaction(
    { signature, ...built.latest }, commitment,
  );
  assert.equal(confirmation.value.err, null, `Lifecycle transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return { signature, measuredUnits, computeLimit };
}

async function indexedReceipts(roundId) {
  const rows = await rest(`mine_round_bets?round_id=eq.${roundId}&select=receipt,bettor&order=receipt.asc`);
  const unique = new Map();
  for (const row of rows || []) unique.set(row.receipt, row);
  return [...unique.values()];
}

async function recoverReceiptRows(roundId, roundState) {
  const totalReceipts = asBig(roundState.totalReceipts);
  const closedReceipts = asBig(roundState.closedReceipts);
  assert.ok(closedReceipts <= totalReceipts, 'Round closed-receipt count exceeds its total');
  const expectedLiveCount = totalReceipts - closedReceipts;
  const scanOptions = exactReceiptRecoveryScanOptions({
    roundId,
    expectedLiveCount,
    maxAccounts: receiptRecoveryMaxAccounts,
  });
  if (expectedLiveCount === 0n) return [];
  const accounts = await provider.connection.getProgramAccounts(PROGRAM_ID, scanOptions);
  return validateRecoveredReceiptAccounts({
    accounts,
    expectedLiveCount,
    roundId,
    programId: PROGRAM_ID,
    decodeReceipt: (data) => program.coder.accounts.decode('BetReceipt', data),
    deriveReceiptPda: (authority, nonce) => receiptPda(roundId, authority, nonce),
  });
}

async function fetchReceiptStates(rows) {
  const entries = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const addresses = batch.map((row) => new PublicKey(row.receipt));
    const states = await program.account.betReceipt.fetchMultiple(addresses);
    entries.push(...batch.map((row, index) => ({ row, receipt: addresses[index], state: states[index] })));
  }
  return entries;
}

async function settleOrRefund(roundAddress, roundState, rows) {
  const instructions = [];
  for (const { row, receipt, state: receiptState } of await fetchReceiptStates(rows)) {
    if (!receiptState || receiptState.claimed || receiptState.refunded) continue;
    const beneficiary = receiptState.authority;
    assert.equal(beneficiary.toBase58(), row.bettor, 'Discovered bettor does not match on-chain receipt');
    const method = roundState.settled
      ? program.methods.settleReceipt().accounts({
        config,
        miningPool,
        stakePool,
        miner: minerPda(beneficiary),
        stakePosition: stakePda(beneficiary),
        round: roundAddress,
        receipt,
        beneficiary,
        executor: payer.publicKey,
      })
      : program.methods.refundReceiptPermissionless().accounts({
        round: roundAddress,
        receipt,
        beneficiary,
        executor: payer.publicKey,
      });
    instructions.push(await method.instruction());
  }
  const sent = [];
  for (let offset = 0; offset < instructions.length; offset += settleBatchSize) {
    sent.push(await sendMeasured(instructions.slice(offset, offset + settleBatchSize)));
  }
  return sent;
}

async function closeReceipts(roundAddress, rows) {
  const instructions = [];
  for (const { receipt, state: receiptState } of await fetchReceiptStates(rows)) {
    if (!receiptState) continue;
    assert.ok(receiptState.claimed || receiptState.refunded, 'Discovered receipt is unprocessed and cannot close');
    instructions.push(await program.methods.closeReceipt().accounts({
      round: roundAddress,
      receipt,
      beneficiary: receiptState.authority,
      executor: payer.publicKey,
    }).instruction());
  }
  const sent = [];
  for (let offset = 0; offset < instructions.length; offset += closeBatchSize) {
    sent.push(await sendMeasured(instructions.slice(offset, offset + closeBatchSize)));
  }
  return sent;
}

async function maybeCloseRandomness(indexedRound) {
  if (!indexedRound.archive_verified || !indexedRound.randomness_id || indexedRound.randomness_closed_at) return null;
  const archivedAt = Date.parse(indexedRound.archived_at || '');
  if (!Number.isFinite(archivedAt) || Date.now() - archivedAt < randomnessRetentionSeconds * 1000) return null;
  const randomness = new PublicKey(indexedRound.randomness_id);
  if (!(await provider.connection.getAccountInfo(randomness, commitment))) {
    await rest(`mine_rounds?round_id=eq.${indexedRound.round_id}`, {
      method: 'PATCH',
      body: { randomness_closed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    });
    return { alreadyClosed: true };
  }
  const { Randomness, switchboardProgram } = await loadSwitchboardCloseContext();
  const client = new Randomness(switchboardProgram, randomness);
  const instruction = await client.closeIx();
  const sent = await sendMeasured([instruction]);
  await rest(`mine_rounds?round_id=eq.${indexedRound.round_id}`, {
    method: 'PATCH',
    body: {
      randomness_closed_signature: sent.signature,
      randomness_closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  return sent;
}

let switchboardCloseContextPromise = null;
async function loadSwitchboardCloseContext() {
  if (!switchboardCloseContextPromise) {
    switchboardCloseContextPromise = (async () => {
      const [{ Randomness }, { loadExplicitSwitchboardEnv }] = await Promise.all([
        import('@switchboard-xyz/on-demand'),
        import('./production-switchboard-env.mjs'),
      ]);
      const { program: switchboardProgram } = await loadExplicitSwitchboardEnv();
      assert.equal(
        switchboardProgram.provider.wallet.publicKey.toBase58(),
        payer.publicKey.toBase58(),
        'Lifecycle keeper and Switchboard close authority must use the same wallet',
      );
      return { Randomness, switchboardProgram };
    })();
  }
  try {
    return await switchboardCloseContextPromise;
  } catch (error) {
    // A transient historical-cleanup failure must be retryable on a later tick.
    switchboardCloseContextPromise = null;
    throw error;
  }
}

async function processRound(indexedRound) {
  const address = roundPda(indexedRound.round_id);
  let roundState = await program.account.round.fetchNullable(address);
  const randomness = await maybeCloseRandomness(indexedRound);
  if (!roundState) return { round: String(indexedRound.round_id), randomness, state: 'round-already-closed' };
  let receipts = await indexedReceipts(indexedRound.round_id);
  const chainReceiptCount = asBig(roundState.totalReceipts);
  assert.ok(
    BigInt(receipts.length) <= chainReceiptCount,
    'Indexed receipt count exceeds the authoritative chain count',
  );
  let receiptSource = 'supabase-index';
  if (BigInt(receipts.length) < chainReceiptCount) {
    // The projection is an optimization, never an availability dependency.
    // Recover only this round's currently live receipt PDAs at confirmed
    // commitment and validate their exact count, owner, data and seed tuple.
    receipts = await recoverReceiptRows(indexedRound.round_id, roundState);
    receiptSource = 'confirmed-round-scan';
  }
  const now = Math.floor(Date.now() / 1000);
  const settledAt = Number(roundState.settlesAt.toString());
  const resultRetentionElapsed = !roundState.settled
    || now >= settledAt + roundAccountRetentionSeconds;
  let processed = [];
  if (!recoveryCloseOnly
      && asBig(roundState.processedReceipts) < asBig(roundState.totalReceipts)
      && (roundState.settled || now >= Number(roundState.refundAt.toString()))) {
    processed = await settleOrRefund(address, roundState, receipts);
    roundState = await program.account.round.fetch(address);
  }
  let closedReceipts = [];
  if (resultRetentionElapsed
      && asBig(roundState.archivedAtSlot) > 0n
      && indexedRound.archive_verified === true
      && asBig(roundState.closedReceipts) < asBig(roundState.totalReceipts)) {
    closedReceipts = await closeReceipts(address, receipts);
    roundState = await program.account.round.fetch(address);
  }
  let closedRound = null;
  if (resultRetentionElapsed
      && asBig(roundState.archivedAtSlot) > 0n
      && indexedRound.archive_verified === true
      && asBig(roundState.processedReceipts) === asBig(roundState.totalReceipts)
      && asBig(roundState.closedReceipts) === asBig(roundState.totalReceipts)
      && (!roundState.settled || roundState.buybackCompleted)) {
    closedRound = await sendMeasured([
      await program.methods.closeRound().accounts({
        round: address,
        rentPayer: roundState.rentPayer,
        executor: payer.publicKey,
      }).instruction(),
    ]);
  }
  return {
    round: String(indexedRound.round_id),
    processed,
    closedReceipts,
    closedRound,
    randomness,
    receiptSource,
    resultRetentionElapsed,
    recoveryCloseOnly,
  };
}

export async function lifecycleTick() {
  const [recentReceiptRows, unprocessedRows, historicalRows, randomnessRows] = await Promise.all([
    // Keep current receipt-bearing rounds at the front of every tick even
    // while the historical cursor is walking an older backlog.
    rest('mine_rounds?closed_signature=is.null&total_receipts=gt.0&select=*&order=round_id.desc&limit=25'),
    // Reward processing must not be starved by old rounds that are waiting on
    // an unrelated buyback/archive precondition. Fully unprocessed rows are a
    // bounded recovery queue for historical receipts.
    rest('mine_rounds?closed_signature=is.null&total_receipts=gt.0&processed_receipts=eq.0&select=*&order=round_id.asc&limit=25'),
    // A descending keyset cursor covers partially processed historical rounds
    // as well as zero-receipt cleanup without an unbounded query or offset.
    rest(historicalLifecycleQuery(historicalRoundCursor)),
    rest('mine_rounds?randomness_id=not.is.null&archive_verified=eq.true&randomness_closed_at=is.null&select=*&order=round_id.asc&limit=25'),
  ]);
  historicalRoundCursor = nextHistoricalLifecycleCursor(historicalRows);
  const queue = selectLifecycleRoundBatch(
    roundBatchSize,
    recentReceiptRows,
    unprocessedRows,
    historicalRows,
    randomnessRows,
  );
  // One malformed/stale indexed row must not block unrelated users from
  // receiving permissionless settlement or refunds in the same tick.
  return processLifecycleRoundQueue(queue, processRound);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const once = process.argv.includes('--once');
  const wake = createWakeSignal();
  if (!once) {
    try {
      await attachProgramWake({
        connection: provider.connection,
        programId: PROGRAM_ID,
        wake,
        commitment,
        // The indexer is event-driven too, but its durable Supabase write can finish just after
        // this worker's first read. Follow-ups keep rewards responsive without a busy loop.
        followUpDelays: [750, 2_000],
      });
      console.log(JSON.stringify({ at: new Date().toISOString(), event: 'lifecycle-realtime-ready' }));
    } catch (error) {
      console.warn(JSON.stringify({
        at: new Date().toISOString(), event: 'lifecycle-realtime-unavailable', message: String(error),
      }));
    }
  }
  do {
    emitWorkerHeartbeat('round-lifecycle', 'tick-start');
    try {
      const results = await runWorkerTick({
        worker: 'round-lifecycle',
        timeoutMs: tickTimeoutMs,
        task: lifecycleTick,
        onTimeout: (error) => {
          console.error(JSON.stringify({
            at: new Date().toISOString(),
            event: 'worker-tick-timeout',
            worker: 'round-lifecycle',
            timeoutMs: tickTimeoutMs,
            message: error.message,
          }));
          emitWorkerHeartbeat('round-lifecycle', 'tick-error', 'tick-timeout');
          process.exit(75);
        },
      });
      const failedRounds = results.filter((row) => row?.state === 'round-processing-error').length;
      emitWorkerHeartbeat(
        'round-lifecycle',
        'tick-complete',
        failedRounds > 0 ? `partial-error:${failedRounds}` : 'ok',
      );
      console.log(JSON.stringify({ at: new Date().toISOString(), event: 'lifecycle-tick', results }));
    } catch (error) {
      emitWorkerHeartbeat('round-lifecycle', 'tick-error', error?.code || 'tick-error');
      console.error(JSON.stringify({ at: new Date().toISOString(), event: 'lifecycle-error', message: String(error) }));
      if (process.env.FAIL_FAST === '1') {
        process.exitCode = 1;
        break;
      }
    }
    if (!once && await wake.wait(intervalMs) === 'event') await sleep(realtimeDebounceMs);
  } while (!once);
}
