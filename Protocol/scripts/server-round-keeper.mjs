/*
 * Server commit–reveal round keeper.
 *
 * One explicit process owns one scheduled round. The production host overlaps
 * these processes and starts each during the bounded provider preparation
 * window, so `open_round` + commitment binding land before `opened_at` while
 * the exact 60-second betting interval remains schedule-anchored on chain.
 *
 * The random preimage is fsynced to mounted durable storage before its
 * commitment can be submitted. Settlement mixes that committed preimage with
 * a future SlotHashes entry fixed permissionlessly only after betting closes.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { requireMatchingSolanaNetwork } from './production-network-policy.mjs';
import {
  PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS,
  ROUND_KEEPER_DEFERRED_EXIT_CODE,
  ROUND_KEEPER_MISSED_EXIT_CODE,
  requireExactSettlementWindow,
  settlementConfirmedWithinResultWindow,
} from './round-schedule-policy.mjs';
import {
  SERVER_RANDOMNESS_PENDING,
  decodeServerEntropySlot,
  loadOrCreateServerReveal,
  serverEntropyAvailable,
  serverRandomnessCommitment,
} from './server-randomness-policy.mjs';
import {
  executeAutoPlansDuringWindow,
  withOperationTimeout,
} from './auto-plan-executor.mjs';
import {
  WORKER_HEARTBEAT_TYPE,
  createWorkerHeartbeat,
} from './event-driven-loop.mjs';

import {
  classifyFinalizedRoundSettlementEvidence,
  findFinalizedRoundSettlementEvidence,
} from './round-settlement-evidence.mjs';

const {
  AnchorProvider, EventParser, Program, Wallet,
} = anchor;
const PROGRAM_ID = new PublicKey(
  process.env.MYNE_PROGRAM_ID || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e',
);
const commitment = 'confirmed';
const txOpts = { commitment, skipPreflight: false, maxRetries: 3 };

const requiredEnv = (name) => {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
};
const rpcUrl = requiredEnv('ANCHOR_PROVIDER_URL');
const walletPath = requiredEnv('ANCHOR_WALLET');
const stateDir = requiredEnv('SERVER_RANDOMNESS_STATE_DIR');
const supabaseUrl = requiredEnv('SUPABASE_URL').replace(/\/$/, '');
const serviceRole = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
assert.match(rpcUrl, /^https:\/\//, 'ANCHOR_PROVIDER_URL must use HTTPS');
assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS');
const secret = JSON.parse(await readFile(walletPath, 'utf8'));
assert.ok(Array.isArray(secret) && secret.length === 64, 'ANCHOR_WALLET must contain a keypair');
assert.ok(
  secret.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
  'ANCHOR_WALLET contains an invalid byte',
);
const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(rpcUrl, { commitment });
const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment });
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const program = new Program(idl, provider);
const eventParser = new EventParser(PROGRAM_ID, program.coder);

const explicitRoundId = requiredEnv('MYNE_ROUND_ID');
assert.match(explicitRoundId, /^\d+$/, 'MYNE_ROUND_ID must be an unsigned integer');
const ROUND_ID = BigInt(explicitRoundId);
const ROUND_ID_BN = new anchor.BN(ROUND_ID.toString());
const LIVE_AUTHORIZED = process.env.SERVER_RANDOMNESS_KEEPER_LIVE === PROGRAM_ID.toBase58();
assert.ok(
  LIVE_AUTHORIZED,
  `Set SERVER_RANDOMNESS_KEEPER_LIVE=${PROGRAM_ID.toBase58()} only after server-mode approval`,
);

const boundedInteger = (value, fallback, minimum, maximum, name) => {
  const parsed = Number(value ?? fallback);
  assert.ok(
    Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum,
    `${name} must be between ${minimum} and ${maximum}`,
  );
  return parsed;
};
const rpcTimeoutMs = boundedInteger(
  process.env.ROUND_KEEPER_RPC_TIMEOUT_MS,
  8_000,
  500,
  30_000,
  'ROUND_KEEPER_RPC_TIMEOUT_MS',
);
const transactionTimeoutMs = boundedInteger(
  process.env.ROUND_KEEPER_TRANSACTION_TIMEOUT_MS,
  12_000,
  2_000,
  30_000,
  'ROUND_KEEPER_TRANSACTION_TIMEOUT_MS',
);
const transactionFlowTimeoutMs = boundedInteger(
  process.env.ROUND_KEEPER_TRANSACTION_FLOW_TIMEOUT_MS,
  30_000,
  5_000,
  55_000,
  'ROUND_KEEPER_TRANSACTION_FLOW_TIMEOUT_MS',
);
const autoPlanOperationTimeoutMs = boundedInteger(
  process.env.AUTO_PLAN_OPERATION_TIMEOUT_MS,
  8_000,
  500,
  30_000,
  'AUTO_PLAN_OPERATION_TIMEOUT_MS',
);
const keeperPriorityMicrolamports = boundedInteger(
  process.env.KEEPER_PRIORITY_MICROLAMPORTS,
  0,
  0,
  1_000_000,
  'KEEPER_PRIORITY_MICROLAMPORTS',
);
const serverRoundPriorityMicrolamports = boundedInteger(
  process.env.SERVER_ROUND_PRIORITY_MICROLAMPORTS,
  50_000,
  0,
  1_000_000,
  'SERVER_ROUND_PRIORITY_MICROLAMPORTS',
);
// Fifteen Mainnet canary rounds consumed exactly 11,139 CU for entropy lock
// and at most 38,723 CU for settlement. These fixed limits retain substantial
// headroom while removing a redundant simulation/blockhash round trip from
// the five-second result path. sendTransaction still confirms the exact bytes.
const SERVER_ENTROPY_LOCK_COMPUTE_LIMIT = 30_000;
const SERVER_SETTLEMENT_COMPUTE_LIMIT = 80_000;
const settlementLateSeconds = Number(process.env.ROUND_KEEPER_SETTLEMENT_LATE_SECONDS ?? 5);
assert.ok(
  Number.isSafeInteger(settlementLateSeconds) && settlementLateSeconds > 0,
  'ROUND_KEEPER_SETTLEMENT_LATE_SECONDS must be a positive integer',
);
const prebindGraceSeconds = boundedInteger(
  process.env.ROUND_KEEPER_PREBIND_GRACE_SECONDS,
  15,
  2,
  45,
  'ROUND_KEEPER_PREBIND_GRACE_SECONDS',
);

const boundedRpc = (label, operation, timeoutMs = rpcTimeoutMs) => withOperationTimeout(
  operation,
  { timeoutMs, label },
);

let heartbeatStage = 'preflight';
let heartbeatDeadlines = {};
const emitRoundHeartbeat = (phase, stage = heartbeatStage, outcome = null) => {
  heartbeatStage = stage;
  const message = {
    ...createWorkerHeartbeat('round-keeper', phase, outcome),
    type: WORKER_HEARTBEAT_TYPE,
    roundId: ROUND_ID.toString(),
    stage,
    deadlines: heartbeatDeadlines,
  };
  if (typeof process.send === 'function' && process.connected !== false) {
    try { process.send(message, () => {}); } catch { /* Host may be shutting down. */ }
  }
  return message;
};
const emitTerminalRoundHeartbeat = async (phase, stage = heartbeatStage, outcome = null) => {
  heartbeatStage = stage;
  const message = {
    ...createWorkerHeartbeat('round-keeper', phase, outcome),
    type: WORKER_HEARTBEAT_TYPE,
    roundId: ROUND_ID.toString(),
    stage,
    deadlines: heartbeatDeadlines,
  };
  if (typeof process.send === 'function' && process.connected !== false) {
    await new Promise((resolve) => {
      try { process.send(message, () => resolve()); } catch { resolve(); }
    });
  }
  return message;
};
emitRoundHeartbeat('tick-start', 'preflight', 'starting');
process.once('uncaughtExceptionMonitor', (error) => {
  emitRoundHeartbeat(
    'tick-error',
    heartbeatStage,
    error instanceof Error ? error.message : String(error),
  );
});

const pda = (seed, ...extra) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), ...extra.map((value) => Buffer.from(value))],
  PROGRAM_ID,
)[0];
const config = pda('config');
const stakePool = pda('stake_pool');
const liquidityGate = pda('liquidity_gate');
const configState = await boundedRpc(
  'Protocol config read',
  () => program.account.protocolConfig.fetch(config),
);
assert.equal(Number(configState.version), 6, 'Server round keeper requires protocol fee schedule v6');
if (configState.paused) {
  emitRoundHeartbeat('tick-complete', 'deferred', 'protocol-paused');
  console.log(JSON.stringify({ event: 'server-round-idle', reason: 'protocol-paused' }));
  process.exit(ROUND_KEEPER_DEFERRED_EXIT_CODE);
}
assert.ok(
  configState.randomnessProgram.equals(PROGRAM_ID),
  'Server keeper requires the MYNE program-id randomness mode',
);
assert.ok(
  configState.randomnessAuthority.equals(keypair.publicKey),
  'Keeper wallet must equal config.randomness_authority',
);
requireExactSettlementWindow({
  roundDurationSeconds: Number(configState.roundDurationSeconds.toString()),
  bettingDurationSeconds: Number(configState.bettingDurationSeconds.toString()),
  settlementLateSeconds,
});
requireMatchingSolanaNetwork({
  genesisHash: await boundedRpc('Genesis hash read', () => connection.getGenesisHash()),
  randomnessProgram: configState.randomnessProgram.toBase58(),
  serverRandomnessProgram: PROGRAM_ID.toBase58(),
});

const roundIdNumber = Number(ROUND_ID);
assert.ok(Number.isSafeInteger(roundIdNumber), 'MYNE_ROUND_ID exceeds the safe schedule range');
const scheduledOpenedAt = Number(configState.initializedAt.toString())
  + roundIdNumber * Number(configState.roundDurationSeconds.toString());
const scheduledBettingEndsAt = scheduledOpenedAt
  + Number(configState.bettingDurationSeconds.toString());
// v6 settlement becomes eligible exactly when betting closes. The remaining
// difference between round_duration_seconds (65) and betting_duration_seconds
// (60) is the winner-display interval, not an additional settlement delay.
const scheduledSettlesAt = scheduledBettingEndsAt;
heartbeatDeadlines = {
  prebindAt: scheduledOpenedAt
    - Number(configState.bettingDurationSeconds.toString())
    + PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS
    + prebindGraceSeconds,
  prepareAt: scheduledOpenedAt,
  lockAt: scheduledSettlesAt,
  settleAt: scheduledSettlesAt + settlementLateSeconds,
};
emitRoundHeartbeat('tick-start', 'preflight-complete', 'configuration-verified');

const roundSeed = Buffer.alloc(8);
roundSeed.writeBigUInt64LE(ROUND_ID);
const round = pda('round', roundSeed);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const asBigInt = (value) => BigInt(value?.toString?.() ?? value ?? 0);
const readChainTimeSeconds = async (cancelled = () => false) => {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (cancelled()) throw new Error('Confirmed chain-time observation cancelled');
    try {
      const slot = await boundedRpc('Confirmed slot read', () => connection.getSlot('confirmed'));
      for (let offset = 0; offset < 16 && slot >= offset; offset += 1) {
        if (cancelled()) throw new Error('Confirmed chain-time observation cancelled');
        try {
          const blockTime = await boundedRpc(
            `Block time read for slot ${slot - offset}`,
            () => connection.getBlockTime(slot - offset),
          );
          if (Number.isInteger(blockTime)) return blockTime;
        } catch (error) {
          lastError = error;
          if (Number(error?.code) !== -32004) break;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(2_000, 200 * (2 ** attempt)));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Confirmed chain time is temporarily unavailable${detail}`);
};
const chainTimeSeconds = () => {
  let cancelled = false;
  return withOperationTimeout(() => readChainTimeSeconds(() => cancelled), {
    timeoutMs: Math.min(30_000, rpcTimeoutMs * 2),
    label: 'Confirmed chain-time observation',
    onTimeout: () => { cancelled = true; },
  });
};
const waitForChainTimestamp = async (target) => {
  for (;;) {
    const remaining = target - await chainTimeSeconds();
    if (remaining <= 0) return;
    emitRoundHeartbeat('tick-start', heartbeatStage, `waiting:${remaining}s`);
    await sleep(Math.min(4_000, Math.max(250, remaining * 1_000)));
  }
};
const fetchRoundWithRetry = async (predicate, label) => {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    emitRoundHeartbeat('tick-start', heartbeatStage, `${label}:attempt-${attempt + 1}`);
    try {
      const state = await boundedRpc(
        `${label} round read`,
        () => program.account.round.fetchNullable(round),
      );
      if (state && predicate(state)) return state;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(3_000, 200 * (2 ** attempt)));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${label} did not become visible${detail}`);
};

const finalizedTransactionTimeSeconds = async (signature, label) => {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    emitRoundHeartbeat(
      'tick-start',
      'awaiting-settlement-finality',
      `${label}:attempt-${attempt + 1}`,
    );
    try {
      const transaction = await boundedRpc(
        `${label} finalized transaction read`,
        () => connection.getTransaction(signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        }),
      );
      if (Number.isSafeInteger(transaction?.blockTime)) return transaction.blockTime;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(1_500, 250 * (2 ** Math.min(attempt, 3))));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${label} finalized chain time is unavailable${detail}`);
};
const auditRecoveredSettlement = async (recoveryReason) => {
  let evidence = null;
  let evidenceError = null;
  try {
    evidence = await findFinalizedRoundSettlementEvidence({
      connection,
      eventParser,
      roundAddress: round,
      roundId: ROUND_ID,
      rpcCall: boundedRpc,
    });
  } catch (error) {
    evidenceError = error instanceof Error ? error.message : String(error);
  }
  const result = classifyFinalizedRoundSettlementEvidence({
    evidence,
    roundId: ROUND_ID,
    resultDeadlineAt: heartbeatDeadlines.settleAt,
  });
  const outcome = evidenceError
    ? `finalized-settlement-evidence-unavailable:${evidenceError};deadline-exclusive:${heartbeatDeadlines.settleAt}`
    : result.outcome;
  if (result.deadlineMet) {
    await emitTerminalRoundHeartbeat('tick-complete', 'settled', outcome);
  } else {
    // Recovery is not allowed to turn a missed winner interval into success.
    // Await IPC delivery before exiting so the host can fsync its incident.
    await emitTerminalRoundHeartbeat('tick-error', 'settlement-deadline-missed', outcome);
  }
  console[result.deadlineMet ? 'log' : 'error'](JSON.stringify({
    ok: result.deadlineMet,
    event: 'server-round-settlement-recovered',
    round: ROUND_ID.toString(),
    recoveryReason,
    settlementSignature: evidence?.signature || null,
    finalizedSettlementAt: evidence?.blockTime ?? null,
    resultDeadlineAt: heartbeatDeadlines.settleAt,
    settlementDeadlineMet: result.deadlineMet,
    message: evidenceError,
  }));
  return result.deadlineMet;
};
const indexedRows = async (path) => {
  emitRoundHeartbeat('tick-start', 'auto-plan-index', 'reading-active-plans');
  const controller = new AbortController();
  const response = await withOperationTimeout(
    () => fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
      signal: controller.signal,
    }),
    {
      timeoutMs: autoPlanOperationTimeoutMs,
      label: 'Auto-plan index HTTP request',
      onTimeout: () => controller.abort(),
    },
  );
  const text = await boundedRpc(
    'Auto-plan index response body',
    () => response.text(),
    autoPlanOperationTimeoutMs,
  );
  assert.ok(response.ok, `Indexed read failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : [];
};

// A finalized blockhash adds avoidable latency to the five-second result
// window. The transaction itself is still simulated, sent and confirmed; a
// fresh confirmed blockhash is the appropriate liveness boundary here.
const buildKeeperTransaction = async (
  ixs,
  units,
  blockhashCommitment = 'confirmed',
  priorityMicrolamports = keeperPriorityMicrolamports,
) => {
  const { blockhash, lastValidBlockHeight } = await boundedRpc(
    `Latest ${blockhashCommitment} blockhash`,
    () => connection.getLatestBlockhash(blockhashCommitment),
  );
  const message = new TransactionMessage({
    recentBlockhash: blockhash,
    payerKey: keypair.publicKey,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ...(priorityMicrolamports > 0
        ? [ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityMicrolamports,
        })]
        : []),
      ...ixs,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([keypair]);
  return { transaction, blockhash, lastValidBlockHeight };
};
const sendKeeperInstructions = async (ixs, label = 'Keeper transaction', {
  fixedComputeLimit = null,
  priorityMicrolamports = keeperPriorityMicrolamports,
  skipPreflight = false,
} = {}) => {
  assert.ok(
    fixedComputeLimit == null
      || (Number.isSafeInteger(fixedComputeLimit) && fixedComputeLimit >= 10_000 && fixedComputeLimit <= 1_400_000),
    `${label} fixed compute limit is invalid`,
  );
  let timedOut = false;
  const assertFlowActive = () => {
    if (!timedOut) return;
    const error = new Error(`${label} transaction flow timed out`);
    error.code = 'MYNE_OPERATION_TIMEOUT';
    throw error;
  };
  return withOperationTimeout(async () => {
    let measuredUnits = null;
    let computeLimit = fixedComputeLimit;
    if (computeLimit == null) {
      const simulationBuild = await buildKeeperTransaction(ixs, 1_400_000);
      assertFlowActive();
      const simulation = await boundedRpc(
        `${label} simulation`,
        () => connection.simulateTransaction(simulationBuild.transaction, {
          commitment,
          sigVerify: false,
          replaceRecentBlockhash: true,
        }),
        transactionTimeoutMs,
      );
      assertFlowActive();
      assert.equal(
        simulation.value.err,
        null,
        `Keeper simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).join('\n')}`,
      );
      emitRoundHeartbeat('tick-start', heartbeatStage, `${label}:simulated`);
      measuredUnits = Math.max(50_000, Number(simulation.value.unitsConsumed || 1_400_000));
      computeLimit = Math.min(1_400_000, Math.ceil(measuredUnits * 1.1));
    } else {
      emitRoundHeartbeat('tick-start', heartbeatStage, `${label}:fixed-compute:${computeLimit}`);
    }
    const finalBuild = await buildKeeperTransaction(
      ixs,
      computeLimit,
      'confirmed',
      priorityMicrolamports,
    );
    assertFlowActive();
    const signature = await boundedRpc(
      `${label} send`,
      () => connection.sendTransaction(finalBuild.transaction, {
        ...txOpts,
        skipPreflight,
      }),
      transactionTimeoutMs,
    );
    assertFlowActive();
    emitRoundHeartbeat('tick-start', heartbeatStage, `${label}:sent:${signature}`);
    const confirmation = await boundedRpc(
      `${label} confirmation`,
      () => connection.confirmTransaction({
        signature,
        blockhash: finalBuild.blockhash,
        lastValidBlockHeight: finalBuild.lastValidBlockHeight,
      }, commitment),
      transactionTimeoutMs,
    );
    assertFlowActive();
    assert.equal(confirmation.value.err, null, `Keeper transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    emitRoundHeartbeat('tick-start', heartbeatStage, `${label}:confirmed:${signature}`);
    return { signature, measuredUnits, computeLimit };
  }, {
    timeoutMs: transactionFlowTimeoutMs,
    label: `${label} transaction flow`,
    onTimeout: () => { timedOut = true; },
  });
};

let roundState = await boundedRpc(
  'Initial round read',
  () => program.account.round.fetchNullable(round),
);
if (roundState?.settled) {
  await auditRecoveredSettlement('already-settled-at-startup');
  process.exit(0);
}

if (!roundState) {
  if ((await chainTimeSeconds()) >= scheduledOpenedAt) {
    emitRoundHeartbeat('tick-error', 'prepare-deadline-missed', `deadline:${scheduledOpenedAt}`);
    console.error(JSON.stringify({
      event: 'server-round-window-missed',
      round: ROUND_ID.toString(),
      scheduledOpenedAt,
    }));
    process.exit(ROUND_KEEPER_MISSED_EXIT_CODE);
  }
}

// Persist before constructing either on-chain instruction. Never print this
// preimage: it remains secret until permissionless settlement publishes it.
const reveal = await loadOrCreateServerReveal({ stateDir, roundId: ROUND_ID });
const roundCommitment = serverRandomnessCommitment({
  programId: PROGRAM_ID,
  mint: configState.mint,
  roundId: ROUND_ID,
  reveal,
});
let bindSignature = null;
if (!roundState) {
  emitRoundHeartbeat('tick-start', 'preparing', 'opening-and-binding');
  const openIx = await program.methods
    .openRound(ROUND_ID_BN)
    .accounts({ config, round, payer: keypair.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  const bindIx = await program.methods
    .bindRoundServerCommitment(ROUND_ID_BN, Array.from(roundCommitment))
    .accounts({ config, round, authority: keypair.publicKey })
    .instruction();
  bindSignature = (await sendKeeperInstructions(
    [openIx, bindIx],
    'Atomic round preparation',
  )).signature;
  roundState = await fetchRoundWithRetry(
    (state) => Buffer.from(state.randomnessAccount.toBytes()).equals(roundCommitment),
    'Atomic round opening and server commitment binding',
  );
  const prebindCompletedAt = await chainTimeSeconds();
  if (prebindCompletedAt > heartbeatDeadlines.prebindAt) {
    emitRoundHeartbeat(
      'tick-error',
      'next-prebind-deadline-missed',
      `late-by:${prebindCompletedAt - heartbeatDeadlines.prebindAt}s`,
    );
  }
} else {
  assert.ok(
    Buffer.from(roundState.randomnessAccount.toBytes()).equals(roundCommitment),
    'Persisted reveal does not match the round commitment; refusing an unrecoverable settlement',
  );
  assert.ok(
    asBigInt(roundState.randomnessCommitSlot) === SERVER_RANDOMNESS_PENDING
      || asBigInt(roundState.randomnessCommitSlot) > 0n,
    'Existing round is not a bound server commit–reveal round',
  );
}

const openedAt = Number(roundState.openedAt.toString());
const bettingEndsAt = Number(roundState.bettingEndsAt.toString());
const settlesAt = Number(roundState.settlesAt.toString());
const refundAt = Number(roundState.refundAt.toString());
assert.equal(openedAt, scheduledOpenedAt, 'Round opened_at disagrees with the canonical schedule');
assert.equal(bettingEndsAt, scheduledBettingEndsAt, 'Round betting deadline disagrees with config');
assert.equal(settlesAt, scheduledSettlesAt, 'Round settlement time disagrees with config');
heartbeatDeadlines = {
  prebindAt: scheduledOpenedAt
    - Number(configState.bettingDurationSeconds.toString())
    + PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS
    + prebindGraceSeconds,
  prepareAt: openedAt,
  lockAt: settlesAt,
  settleAt: settlesAt + settlementLateSeconds,
  refundAt,
};
emitRoundHeartbeat('tick-start', 'commitment-bound', bindSignature || 'recovered');
console.log(JSON.stringify({
  ok: true,
  event: 'server-round-commitment-bound',
  round: ROUND_ID.toString(),
  openedAt,
  bettingEndsAt,
  bindSignature,
}));

// A pre-created round exists before betting but the program rejects both
// manual and automated deployments until its scheduled `opened_at`.
heartbeatStage = 'awaiting-betting-open';
await waitForChainTimestamp(openedAt);
emitRoundHeartbeat('tick-start', 'betting-open', `closes:${bettingEndsAt}`);
if ((await chainTimeSeconds()) < bettingEndsAt) {
  const receiptRent = BigInt(await boundedRpc(
    'Bet receipt rent exemption read',
    () => connection.getMinimumBalanceForRentExemption(468),
  ));
  await executeAutoPlansDuringWindow({
    bettingEndsAt,
    nowSeconds: chainTimeSeconds,
    sleep,
    indexedRows,
    buildEntry: async ({ authority: indexedAuthority }) => {
      emitRoundHeartbeat('tick-start', 'auto-plan-read', indexedAuthority);
      const authority = new PublicKey(indexedAuthority);
      const autoPlan = pda('auto_plan', authority.toBuffer());
      const plan = await boundedRpc(
        `Auto-plan read for ${authority.toBase58()}`,
        () => program.account.autoPlan.fetchNullable(autoPlan),
        autoPlanOperationTimeoutMs,
      );
      if (!plan || !plan.authority.equals(authority)) return null;
      const perRound = plan.amounts.reduce((sum, amount) => sum + asBigInt(amount), 0n);
      if (!plan.active || asBigInt(plan.balanceLamports) < perRound + receiptRent
          || asBigInt(plan.lastRound) === ROUND_ID) return null;
      const nonce = asBigInt(plan.nextNonce);
      const nonceSeed = Buffer.alloc(8);
      nonceSeed.writeBigUInt64LE(nonce);
      const miner = pda('miner', authority.toBuffer());
      const receipt = pda('bet', roundSeed, authority.toBuffer(), nonceSeed);
      const ix = await program.methods
        .executeAutoPlan(ROUND_ID_BN, new anchor.BN(nonce.toString()))
        .accounts({
          config, autoPlan, miner, round, receipt, executor: keypair.publicKey,
          randomnessAccount: null, systemProgram: SystemProgram.programId,
        })
        .instruction();
      return { authority: authority.toBase58(), ix };
    },
    sendBatch: (batch) => {
      emitRoundHeartbeat('tick-start', 'auto-plan-send', `batch:${batch.length}`);
      return sendKeeperInstructions(
        batch.map(({ ix }) => ix),
        'Auto-plan execution',
      );
    },
    operationTimeoutMs: autoPlanOperationTimeoutMs,
    sendTimeoutMs: transactionFlowTimeoutMs + 1_000,
    onEvent: (event) => {
      emitRoundHeartbeat('tick-start', 'auto-plans', event.event);
      console[event.error ? 'error' : 'log'](JSON.stringify({
        ...event, round: ROUND_ID.toString(),
      }));
    },
  });
}

heartbeatStage = 'awaiting-betting-close';
await waitForChainTimestamp(bettingEndsAt);
emitRoundHeartbeat('tick-start', 'betting-closed', `lock-deadline:${settlesAt}`);
roundState = await boundedRpc('Betting-close round read', () => program.account.round.fetch(round));
if (!roundState.settled && asBigInt(roundState.randomnessCommitSlot) === SERVER_RANDOMNESS_PENDING) {
  const lockIx = await program.methods
    .lockRoundServerEntropy(ROUND_ID_BN)
    .accounts({ config, round, executor: keypair.publicKey })
    .instruction();
  const lockSignature = (await sendKeeperInstructions(
    [lockIx],
    'Server entropy lock',
    {
      fixedComputeLimit: SERVER_ENTROPY_LOCK_COMPUTE_LIMIT,
      priorityMicrolamports: serverRoundPriorityMicrolamports,
      skipPreflight: true,
    },
  )).signature;
  roundState = await fetchRoundWithRetry(
    (state) => asBigInt(state.randomnessCommitSlot) !== SERVER_RANDOMNESS_PENDING,
    'Future server entropy slot lock',
  );
  const lockCompletedAt = await chainTimeSeconds();
  // Locking only becomes legal at `settles_at`. Allow the bounded result
  // interval for confirmation; treating the first legal second as already
  // late would permanently poison health on every normal round.
  if (lockCompletedAt >= heartbeatDeadlines.settleAt) {
    emitRoundHeartbeat(
      'tick-error',
      'lock-deadline-missed',
      `late-by:${lockCompletedAt - heartbeatDeadlines.lockAt}s`,
    );
  }
  console.log(JSON.stringify({
    event: 'server-entropy-locked',
    round: ROUND_ID.toString(),
    signature: lockSignature,
  }));
  emitRoundHeartbeat('tick-start', 'entropy-locked', lockSignature);
}
if (roundState.settled) {
  await auditRecoveredSettlement('settled-during-lock-recovery');
  process.exit(0);
}
assert.ok((await chainTimeSeconds()) < refundAt, 'Round reached its refund window before server settlement');
const targetSlot = decodeServerEntropySlot(roundState.randomnessCommitSlot);
let lastEntropyHeartbeatAt = 0;
for (;;) {
  assert.ok((await chainTimeSeconds()) < refundAt, 'Future entropy slot was not retained before refund');
  const slotHashes = await boundedRpc(
    'SlotHashes sysvar read',
    () => connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, commitment),
  );
  if (slotHashes && serverEntropyAvailable(slotHashes.data, targetSlot)) break;
  if (Date.now() - lastEntropyHeartbeatAt >= 1_000) {
    emitRoundHeartbeat('tick-start', 'awaiting-entropy', `target-slot:${targetSlot}`);
    lastEntropyHeartbeatAt = Date.now();
  }
  await sleep(150);
}

heartbeatStage = 'awaiting-settlement-window';
await waitForChainTimestamp(settlesAt);
const settlementStartedAt = await chainTimeSeconds();
if (settlementStartedAt >= heartbeatDeadlines.settleAt) {
  emitRoundHeartbeat(
    'tick-error',
    'settlement-deadline-missed',
    `late-by:${settlementStartedAt - heartbeatDeadlines.settleAt}s`,
  );
} else {
  emitRoundHeartbeat('tick-start', 'settlement-ready', `deadline:${heartbeatDeadlines.settleAt}`);
}
const gateState = await boundedRpc(
  'Liquidity gate read',
  () => program.account.liquidityGate.fetch(liquidityGate),
);
assert.equal(gateState.verified, true, 'Liquidity gate is not verified');
assert.ok(gateState.myneVault && gateState.solVault, 'Liquidity gate has no verified token vaults');
const settleIx = await program.methods
  .settleRoundServer(Array.from(reveal))
  .accounts({
    config,
    stakePool,
    round,
    liquidityGate,
    liquidityPool: gateState.pool,
    myneVault: gateState.myneVault,
    solVault: gateState.solVault,
    slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    buybackWallet: configState.buybackWallet,
    adminFeeWallet: configState.adminFeeWallet,
    executor: keypair.publicKey,
  })
  .instruction();
const settlementSignature = (await sendKeeperInstructions(
  [settleIx],
  'Server round settlement',
  {
    fixedComputeLimit: SERVER_SETTLEMENT_COMPUTE_LIMIT,
    priorityMicrolamports: serverRoundPriorityMicrolamports,
    skipPreflight: true,
  },
)).signature;
roundState = await fetchRoundWithRetry((state) => state.settled, 'Server round settlement');
let finalizedSettlementAt = null;
let settlementDeadlineError = null;
try {
  finalizedSettlementAt = await finalizedTransactionTimeSeconds(
    settlementSignature,
    'Server round settlement',
  );
} catch (error) {
  settlementDeadlineError = error instanceof Error ? error.message : String(error);
}
const settlementDeadlineMet = finalizedSettlementAt !== null
  && settlementConfirmedWithinResultWindow({
    confirmedAt: finalizedSettlementAt,
    resultDeadlineAt: heartbeatDeadlines.settleAt,
  });
if (settlementDeadlineMet) {
  emitRoundHeartbeat('tick-complete', 'settled', settlementSignature);
} else {
  const outcome = settlementDeadlineError
    ? `finalized-time-unavailable:${settlementDeadlineError}`
    : `confirmed-at:${finalizedSettlementAt};deadline-exclusive:${heartbeatDeadlines.settleAt}`;
  // Do not follow this with tick-complete: the host must retain the missed
  // winner interval as a deadline violation even though settlement succeeded.
  await emitTerminalRoundHeartbeat('tick-error', 'settlement-deadline-missed', outcome);
  console.error(JSON.stringify({
    event: 'server-round-settlement-deadline-missed',
    round: ROUND_ID.toString(),
    finalizedSettlementAt,
    resultDeadlineAt: heartbeatDeadlines.settleAt,
    message: settlementDeadlineError,
  }));
}
console.log(JSON.stringify({
  ok: settlementDeadlineMet,
  event: 'server-round-settled',
  round: ROUND_ID.toString(),
  settlementSignature,
  finalizedSettlementAt,
  resultDeadlineAt: heartbeatDeadlines.settleAt,
  settlementDeadlineMet,
}));
