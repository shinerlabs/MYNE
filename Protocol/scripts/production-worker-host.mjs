/**
 * Durable MYNE production-worker supervisor.
 *
 * Standby is the default and never starts a transaction-producing child.
 * Live mode requires an exact program-id acknowledgement, two distinct
 * operational keypairs supplied as base64-encoded JSON, and a mounted durable
 * data directory for the buyback journal.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import anchor from '@anchor-lang/core';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { requireMatchingSolanaNetwork } from './production-network-policy.mjs';
import { withOperationTimeout } from './auto-plan-executor.mjs';
import {
  PROVIDER_PREPARATION_LEAD_SECONDS,
  PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS,
  ROUND_KEEPER_DEFERRED_EXIT_CODE,
  ROUND_KEEPER_MISSED_EXIT_CODE,
  firstSafeResumeRoundId,
  roundIdsToPrepare,
} from './round-schedule-policy.mjs';
import { recordWorkerHeartbeat, workerHeartbeatFresh } from './event-driven-loop.mjs';
import { SERVER_RANDOMNESS_PENDING } from './server-randomness-policy.mjs';

const { AnchorProvider, Program, Wallet } = anchor;
export const DEFAULT_PROGRAM_ID = 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e';
export const WORKER_NAMES = Object.freeze([
  'round-indexer',
  'round-lifecycle',
  'buyback-keeper',
  'round-keeper',
]);

export function requiredEnv(env, name) {
  const value = String(env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
}

export function keypairFromBase64(value, name) {
  let decoded;
  try {
    decoded = Buffer.from(String(value || ''), 'base64').toString('utf8');
  } catch {
    throw new Error(`${name} is not valid base64`);
  }
  let secret;
  try {
    secret = JSON.parse(decoded);
  } catch {
    throw new Error(`${name} must encode a JSON keypair array`);
  }
  assert.ok(Array.isArray(secret) && secret.length === 64, `${name} must contain 64 bytes`);
  assert.ok(
    secret.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    `${name} contains an invalid byte`,
  );
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function workerMode(env) {
  const mode = String(env.MYNE_WORKER_MODE || 'standby').trim().toLowerCase();
  assert.ok(
    mode === 'standby' || mode === 'observe' || mode === 'live',
    'MYNE_WORKER_MODE must be standby, observe, or live',
  );
  return mode;
}

const BENIGN_BUYBACK_OUTCOMES = new Set([
  'devnet-liquidity-pool-not-required',
  'no-settled-round-yet',
  'no-indexed-buyback-backlog',
  'round-buyback-completed-on-chain',
  'round-already-processed',
]);

/** Only a completed useful check advances readiness freshness. */
export const isSuccessfulWorkerOutcome = (outcome, worker = '') => outcome === 'ok'
  || (worker === 'buyback-keeper' && BENIGN_BUYBACK_OUTCOMES.has(outcome));

export function firstManagedRoundId(env, randomnessMode) {
  if (randomnessMode !== 'server') return 0;
  const value = requiredEnv(env, 'MYNE_FIRST_SERVER_ROUND_ID');
  assert.match(value, /^\d+$/, 'MYNE_FIRST_SERVER_ROUND_ID must be an unsigned integer');
  const roundId = Number(value);
  assert.ok(Number.isSafeInteger(roundId), 'MYNE_FIRST_SERVER_ROUND_ID exceeds the safe integer range');
  return roundId;
}

export function liveWorkerSpecs({
  programId,
  randomnessWalletPath,
  buybackWalletPath,
  dataDir,
  randomnessMode = 'switchboard',
}) {
  assert.ok(
    randomnessMode === 'switchboard' || randomnessMode === 'server',
    'randomnessMode must be switchboard or server',
  );
  const serverProviderAcknowledgement = randomnessMode === 'server'
    ? { MYNE_SERVER_RANDOMNESS_ACK: programId }
    : {};
  return [
    {
      name: 'round-indexer',
      script: 'round-indexer.mjs',
      walletPath: randomnessWalletPath,
      env: {
        ...serverProviderAcknowledgement,
        FAIL_FAST: '1',
        ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE: '1',
      },
    },
    {
      name: 'round-lifecycle',
      script: 'round-lifecycle-keeper.mjs',
      walletPath: randomnessWalletPath,
      env: { ...serverProviderAcknowledgement, FAIL_FAST: '1' },
    },
    {
      name: 'buyback-keeper',
      script: 'buyback-keeper.mjs',
      walletPath: buybackWalletPath,
      env: {
        ...serverProviderAcknowledgement,
        // Quote/API errors are retried by the same lease holder on the next
        // one-minute tick. The host also keeps that holder stable across a
        // watchdog restart so the replacement does not fence itself.
        FAIL_FAST: '0',
        DRY_RUN: '0',
        BUYBACK_KEEPER_LIVE: programId,
        BUYBACK_STATE_PATH: `${dataDir}/buyback-state.json`,
      },
    },
    {
      name: 'round-keeper',
      script: randomnessMode === 'server'
        ? 'server-round-keeper.mjs'
        : 'switchboard-round-keeper.mjs',
      walletPath: randomnessWalletPath,
      env: randomnessMode === 'server'
        ? {
          SERVER_RANDOMNESS_KEEPER_LIVE: programId,
          SERVER_RANDOMNESS_STATE_DIR: `${dataDir}/server-randomness`,
        }
        : { SWITCHBOARD_KEEPER_LIVE: programId },
      perRound: true,
    },
  ];
}

export function observeWorkerSpecs({ programId, randomnessWalletPath, randomnessMode }) {
  assert.ok(
    randomnessMode === 'switchboard' || randomnessMode === 'server',
    'randomnessMode must be switchboard or server',
  );
  return [{
    name: 'round-indexer',
    script: 'round-indexer.mjs',
    walletPath: randomnessWalletPath,
    env: {
      ...(randomnessMode === 'server' ? { MYNE_SERVER_RANDOMNESS_ACK: programId } : {}),
      FAIL_FAST: '1',
      ROUND_INDEXER_PROJECT_ONLY: '1',
      ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE: '0',
    },
  }];
}

export function childEnvironment(env, overrides = {}) {
  const childEnv = { ...env, ...overrides };
  delete childEnv.MYNE_RANDOMNESS_KEYPAIR_B64;
  delete childEnv.MYNE_BUYBACK_KEYPAIR_B64;
  return childEnv;
}

export function minimumWorkerHeartbeatTimeoutMs(env) {
  const configuredDurations = [
    Number(env.ROUND_INDEXER_TICK_TIMEOUT_MS || 120_000),
    Number(env.LIFECYCLE_TICK_TIMEOUT_MS || 120_000),
    Number(env.BUYBACK_TICK_TIMEOUT_MS || 120_000),
    Number(env.ROUND_INDEXER_INTERVAL_MS || 3_000),
    Number(env.LIFECYCLE_KEEPER_INTERVAL_MS || 5_000),
    Number(env.BUYBACK_INTERVAL_MS || 60_000),
  ];
  assert.ok(
    configuredDurations.every((value) => Number.isInteger(value) && value >= 0),
    'Worker tick and interval durations must be non-negative integers',
  );
  return Math.max(...configuredDurations) + 30_000;
}

export const DEFAULT_ROUND_SETTLEMENT_LATE_SECONDS = 5;
export const DEFAULT_REPEATED_TICK_ERROR_LIMIT = 3;
export const DEFAULT_NEXT_ROUND_PREBIND_GRACE_SECONDS = 15;
export const DEFAULT_WORKER_SUCCESS_FRESHNESS_MS = Object.freeze({
  'round-indexer': 30_000,
  'round-lifecycle': 30_000,
  'buyback-keeper': 150_000,
});

/**
 * Maximum age of the last genuinely successful tick for each essential
 * non-round worker. Heartbeats prove only that a process is alive; these
 * cadence-aware bounds prove that it is still completing useful checks.
 */
export function workerSuccessFreshnessMs(env = {}) {
  const definitions = [
    ['round-indexer', 'ROUND_INDEXER_INTERVAL_MS', 3_000, 'ROUND_INDEXER_SUCCESS_FRESHNESS_MS', 3, 0],
    ['round-lifecycle', 'LIFECYCLE_KEEPER_INTERVAL_MS', 5_000, 'LIFECYCLE_SUCCESS_FRESHNESS_MS', 3, 0],
    ['buyback-keeper', 'BUYBACK_INTERVAL_MS', 60_000, 'BUYBACK_SUCCESS_FRESHNESS_MS', 2, 30_000],
  ];
  return Object.fromEntries(definitions.map(([
    name, cadenceName, defaultCadence, overrideName, cadenceMultiplier, graceMs,
  ]) => {
    const cadenceMs = Number(env[cadenceName] || defaultCadence);
    assert.ok(
      Number.isSafeInteger(cadenceMs) && cadenceMs >= 0,
      `${cadenceName} must be a non-negative integer`,
    );
    const defaultFreshness = Math.max(
      DEFAULT_WORKER_SUCCESS_FRESHNESS_MS[name],
      cadenceMs * cadenceMultiplier + graceMs,
    );
    const freshnessMs = Number(env[overrideName] || defaultFreshness);
    assert.ok(
      Number.isSafeInteger(freshnessMs)
        && freshnessMs >= Math.max(1_000, cadenceMs)
        && freshnessMs <= 1_800_000,
      `${overrideName} must be between the worker cadence and 1800000`,
    );
    return [name, freshnessMs];
  }));
}
const ROUND_DEADLINE_VIOLATION_STAGES = new Set([
  'prepare-deadline-missed',
  'next-prebind-deadline-missed',
  'lock-deadline-missed',
  'settlement-deadline-missed',
]);

export function canonicalRoundDeadlines({
  roundId,
  initializedAt,
  roundDurationSeconds,
  bettingDurationSeconds = PROVIDER_PREPARATION_LEAD_SECONDS,
  preparationSafetyMarginSeconds = PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS,
  nextRoundPrebindGraceSeconds = DEFAULT_NEXT_ROUND_PREBIND_GRACE_SECONDS,
  settlementLateSeconds = DEFAULT_ROUND_SETTLEMENT_LATE_SECONDS,
}) {
  for (const [name, value] of Object.entries({
    roundId,
    initializedAt,
    roundDurationSeconds,
    bettingDurationSeconds,
    preparationSafetyMarginSeconds,
    nextRoundPrebindGraceSeconds,
    settlementLateSeconds,
  })) assert.ok(Number.isSafeInteger(value), `${name} must be a safe integer`);
  assert.ok(roundId >= 0, 'roundId must be non-negative');
  assert.ok(roundDurationSeconds > bettingDurationSeconds, 'Round duration must exceed betting duration');
  assert.ok(
    preparationSafetyMarginSeconds >= 0
      && nextRoundPrebindGraceSeconds > 0
      && preparationSafetyMarginSeconds + nextRoundPrebindGraceSeconds < bettingDurationSeconds,
    'Next-round prebind deadline must fit inside the preparation window',
  );
  assert.ok(settlementLateSeconds > 0, 'Settlement lateness threshold must be positive');
  const openedAt = initializedAt + roundId * roundDurationSeconds;
  const bettingEndsAt = openedAt + bettingDurationSeconds;
  const settlesAt = openedAt + roundDurationSeconds;
  return {
    preparationStartsAt: openedAt - bettingDurationSeconds + preparationSafetyMarginSeconds,
    prebindAt: openedAt
      - bettingDurationSeconds
      + preparationSafetyMarginSeconds
      + nextRoundPrebindGraceSeconds,
    prepareAt: openedAt,
    bettingEndsAt,
    lockAt: settlesAt,
    settlesAt,
    settleAt: settlesAt + settlementLateSeconds,
  };
}

/**
 * Assess only current schedule obligations. Rows are normalized chain reads;
 * a database projection can never make this health check green.
 */
export function assessRoundScheduleHealth({
  now,
  initializedAt,
  roundDurationSeconds,
  bettingDurationSeconds = PROVIDER_PREPARATION_LEAD_SECONDS,
  preparationSafetyMarginSeconds = PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS,
  nextRoundPrebindGraceSeconds = DEFAULT_NEXT_ROUND_PREBIND_GRACE_SECONDS,
  settlementLateSeconds = DEFAULT_ROUND_SETTLEMENT_LATE_SECONDS,
  minimumManagedRoundId = 0,
  lookbackRounds = 8,
  protocolPaused = false,
  rows = [],
}) {
  for (const [name, value] of Object.entries({
    now,
    initializedAt,
    roundDurationSeconds,
    bettingDurationSeconds,
    preparationSafetyMarginSeconds,
    nextRoundPrebindGraceSeconds,
    settlementLateSeconds,
    minimumManagedRoundId,
    lookbackRounds,
  })) assert.ok(Number.isSafeInteger(value), `${name} must be a safe integer`);
  assert.ok(lookbackRounds >= 1 && lookbackRounds <= 32, 'lookbackRounds must be between 1 and 32');
  if (now < initializedAt) {
    return {
      ok: true,
      currentRoundId: null,
      nextRoundId: minimumManagedRoundId,
      nextRoundPrebound: false,
      nextRoundPrebindDeadline: null,
      entries: [],
      errors: [],
    };
  }
  const currentRoundId = Math.floor((now - initializedAt) / roundDurationSeconds);
  const rowById = new Map(rows.map((row) => [Number(row.roundId), row]));
  const ids = [
    ...Array.from({ length: lookbackRounds }, (_, offset) => currentRoundId - lookbackRounds + offset),
    currentRoundId,
    currentRoundId + 1,
  ]
    .filter((roundId) => roundId >= minimumManagedRoundId);
  const errors = [];
  const entries = ids.map((roundId) => {
    const deadlines = canonicalRoundDeadlines({
      roundId,
      initializedAt,
      roundDurationSeconds,
      bettingDurationSeconds,
      preparationSafetyMarginSeconds,
      nextRoundPrebindGraceSeconds,
      settlementLateSeconds,
    });
    const row = rowById.get(roundId) || null;
    const role = roundId < currentRoundId ? 'previous' : roundId === currentRoundId ? 'current' : 'next';
    // A missing historical PDA may have been canonically archived and closed;
    // only current/next accounts have an active preparation obligation.
    const preparationDue = role === 'current'
      || (role === 'next' && now >= deadlines.preparationStartsAt);
    const prepared = Boolean(row?.prepared);
    const funded = Boolean(row?.funded);
    const settled = Boolean(row?.settled);
    const entropyLocked = Boolean(row?.entropyLocked);
    let condition = settled ? 'settled' : prepared ? 'prepared' : preparationDue ? 'missing' : 'not-due';

    if (!protocolPaused && preparationDue && now >= deadlines.prepareAt && !prepared) {
      condition = 'prepare-late';
      errors.push(`Round ${roundId} preparation missed ${deadlines.prepareAt}`);
    }
    if (!protocolPaused && role === 'next' && now > deadlines.prebindAt && !prepared) {
      condition = 'next-prebind-late';
      errors.push(`Next round ${roundId} was not prebound by ${deadlines.prebindAt}`);
    }
    if (!protocolPaused && prepared && !settled && now > deadlines.lockAt && !entropyLocked) {
      condition = 'lock-late';
      errors.push(`Round ${roundId} entropy lock missed ${deadlines.lockAt}`);
    }
    if (!protocolPaused && prepared && !settled && now > deadlines.settleAt) {
      condition = funded ? 'funded-settlement-late' : 'settlement-late';
      errors.push(`${funded ? 'Funded r' : 'R'}ound ${roundId} settlement missed ${deadlines.settleAt}`);
    }
    return {
      roundId,
      role,
      condition,
      prepared,
      entropyLocked,
      funded,
      settled,
      ...deadlines,
    };
  });
  const next = entries.find(({ role }) => role === 'next') || null;
  return {
    ok: protocolPaused || errors.length === 0,
    currentRoundId,
    nextRoundId: next?.roundId ?? Math.max(currentRoundId + 1, minimumManagedRoundId),
    nextRoundPrebound: Boolean(next?.prepared),
    nextRoundPrebindDeadline: next?.prebindAt ?? null,
    entries,
    errors,
  };
}

function safeDataDir(env, mode) {
  const value = String(env.RAILWAY_VOLUME_MOUNT_PATH || env.MYNE_WORKER_DATA_DIR || '').trim();
  if (mode === 'live') {
    assert.ok(value, 'Live mode requires a mounted persistent data directory');
  }
  const resolved = value || '/tmp/myne-worker-standby';
  assert.ok(resolved.startsWith('/') && resolved !== '/', 'Worker data directory must be a safe absolute path');
  return resolved.replace(/\/$/, '');
}

export function publicHealth(state) {
  const now = Number.isFinite(state.now) ? state.now : Date.now();
  const heartbeatTimeoutMs = Number.isInteger(state.heartbeatTimeoutMs)
    ? state.heartbeatTimeoutMs
    : 180_000;
  const repeatedTickErrorLimit = Number.isInteger(state.repeatedTickErrorLimit)
    ? state.repeatedTickErrorLimit
    : DEFAULT_REPEATED_TICK_ERROR_LIMIT;
  const projectionFreshnessMs = Number.isInteger(state.projectionFreshnessMs)
    ? state.projectionFreshnessMs
    : 30_000;
  const supervisedMode = state.mode === 'live' || state.mode === 'observe';
  const essentialWorkerNames = state.mode === 'observe'
    ? ['round-indexer']
    : ['round-indexer', 'round-lifecycle'];
  // Buyback is financially important but not on the round/result/claim data
  // path. Treat it as an independently alertable degradation so a Jupiter or
  // pool outage cannot make Railway restart the healthy core workers.
  const auxiliaryWorkerNames = state.mode === 'live' ? ['buyback-keeper'] : [];
  const essentialWorkersRunning = !supervisedMode
    || essentialWorkerNames
      .every((name) => workerHeartbeatFresh(state.workers.get(name), {
        now,
        maxAgeMs: heartbeatTimeoutMs,
      }));
  const successFreshnessMs = state.workerSuccessFreshnessMs
    || DEFAULT_WORKER_SUCCESS_FRESHNESS_MS;
  const liveEssentialWorkersSuccessful = state.mode !== 'live'
    || essentialWorkerNames.every((name) => {
      const lastSuccessfulAt = state.workers.get(name)?.lastSuccessfulAt;
      const maxAgeMs = Number(successFreshnessMs[name]);
      return Number.isFinite(lastSuccessfulAt)
        && Number.isSafeInteger(maxAgeMs)
        && maxAgeMs > 0
        && now - lastSuccessfulAt >= 0
        && now - lastSuccessfulAt <= maxAgeMs;
    });
  const repeatedTickErrorsAbsent = !supervisedMode
    || essentialWorkerNames.every((name) => (
      Number(state.workers.get(name)?.consecutiveErrors || 0) < repeatedTickErrorLimit
    ));
  const auxiliaryWorkersHealthy = state.mode !== 'live'
    || auxiliaryWorkerNames.every((name) => {
      const worker = state.workers.get(name);
      const lastSuccessfulAt = worker?.lastSuccessfulAt;
      const maxAgeMs = Number(successFreshnessMs[name]);
      return workerHeartbeatFresh(worker, { now, maxAgeMs: heartbeatTimeoutMs })
        && Number(worker?.consecutiveErrors || 0) < repeatedTickErrorLimit
        && Number.isFinite(lastSuccessfulAt)
        && Number.isSafeInteger(maxAgeMs)
        && now - lastSuccessfulAt >= 0
        && now - lastSuccessfulAt <= maxAgeMs;
    });
  const observeProjectionFresh = state.mode !== 'observe'
    || (
      Number.isFinite(state.workers.get('round-indexer')?.lastSuccessfulAt)
      && now - state.workers.get('round-indexer').lastSuccessfulAt >= 0
      && now - state.workers.get('round-indexer').lastSuccessfulAt <= projectionFreshnessMs
    );
  const managedRoundProgress = state.roundProgress
    ? [...state.roundProgress.values()].filter((progress) => (
      !Number.isSafeInteger(state.minimumManagedRoundId)
      || Number(progress?.roundId) >= state.minimumManagedRoundId
    ))
    : [];
  const roundTickErrorsAbsent = state.mode !== 'live'
    || managedRoundProgress.every((progress) => (
      Number(progress?.consecutiveErrors || 0) < repeatedTickErrorLimit
    ));
  const roundDeadlinesMet = state.mode !== 'live'
    || managedRoundProgress.every((progress) => !progress?.deadlineViolation);
  const roundScheduleHealthy = state.mode !== 'live'
    || state.protocolPaused === true
    || state.roundHealth?.ok === true;
  const resumeActivationReady = state.mode !== 'live'
    || state.protocolPaused === true
    || !state.resumeActivation
    || state.resumeActivation.prebound === true;
  return {
    ok: state.ready
      && !state.error
      && essentialWorkersRunning
      && liveEssentialWorkersSuccessful
      && repeatedTickErrorsAbsent
      && observeProjectionFresh
      && roundTickErrorsAbsent
      && roundDeadlinesMet
      && roundScheduleHealthy
      && resumeActivationReady,
    degraded: !auxiliaryWorkersHealthy,
    degradedWorkers: auxiliaryWorkersHealthy ? [] : auxiliaryWorkerNames.filter((name) => {
      const worker = state.workers.get(name);
      const lastSuccessfulAt = worker?.lastSuccessfulAt;
      const maxAgeMs = Number(successFreshnessMs[name]);
      return !workerHeartbeatFresh(worker, { now, maxAgeMs: heartbeatTimeoutMs })
        || Number(worker?.consecutiveErrors || 0) >= repeatedTickErrorLimit
        || !Number.isFinite(lastSuccessfulAt)
        || !Number.isSafeInteger(maxAgeMs)
        || now - lastSuccessfulAt < 0
        || now - lastSuccessfulAt > maxAgeMs;
    }),
    mode: state.mode,
    protocolPaused: state.protocolPaused ?? null,
    checkedAt: state.checkedAt,
    revision: state.revision,
    chainTime: Number.isSafeInteger(state.chainTime) ? state.chainTime : null,
    minimumManagedRoundId: Number.isSafeInteger(state.minimumManagedRoundId)
      ? state.minimumManagedRoundId
      : null,
    resumeActivation: state.resumeActivation ? { ...state.resumeActivation } : null,
    rounds: state.roundHealth
      ? {
        ...state.roundHealth,
        workers: state.roundProgress
          ? [...state.roundProgress.values()].map((progress) => ({ ...progress }))
          : [],
      }
      : null,
    workers: Object.fromEntries(
      [...state.workers.entries()].map(([name, value]) => {
        const liveSuccessRequired = state.mode === 'live' && essentialWorkerNames.includes(name);
        const auxiliarySuccessObserved = state.mode === 'live' && auxiliaryWorkerNames.includes(name);
        const observeSuccessRequired = state.mode === 'observe' && name === 'round-indexer';
        const successMaxAgeMs = liveSuccessRequired || auxiliarySuccessObserved
          ? Number(successFreshnessMs[name])
          : observeSuccessRequired ? projectionFreshnessMs : null;
        const successFresh = !liveSuccessRequired && !auxiliarySuccessObserved && !observeSuccessRequired
          ? true
          : Number.isFinite(value.lastSuccessfulAt)
            && Number.isSafeInteger(successMaxAgeMs)
            && now - value.lastSuccessfulAt >= 0
            && now - value.lastSuccessfulAt <= successMaxAgeMs;
        return [name, {
          running: value.running,
          restarts: value.restarts,
          heartbeatFresh: !supervisedMode || workerHeartbeatFresh(value, {
            now,
            maxAgeMs: heartbeatTimeoutMs,
          }),
          lastHeartbeatAt: Number.isFinite(value.lastHeartbeatAt)
            ? new Date(value.lastHeartbeatAt).toISOString()
            : null,
          lastCompletedAt: Number.isFinite(value.lastCompletedAt)
            ? new Date(value.lastCompletedAt).toISOString()
            : null,
          completionFresh: !supervisedMode || (
            Number.isFinite(value.lastCompletedAt)
            && now - value.lastCompletedAt >= 0
            && now - value.lastCompletedAt <= heartbeatTimeoutMs
          ),
          lastSuccessfulAt: Number.isFinite(value.lastSuccessfulAt)
            ? new Date(value.lastSuccessfulAt).toISOString()
            : null,
          successFresh,
          successFreshnessMs: successMaxAgeMs,
          critical: liveSuccessRequired || observeSuccessRequired,
          auxiliary: auxiliarySuccessObserved,
          lastOutcome: value.lastOutcome ?? null,
          consecutiveErrors: Number(value.consecutiveErrors || 0),
        }];
      }),
    ),
  };
}

async function requireProductionIndexSchema({ supabaseUrl, serviceRole, timeoutMs = 8_000 }) {
  const controller = new AbortController();
  const response = await withOperationTimeout(
    () => fetch(
      `${supabaseUrl}/rest/v1/mine_worker_schema_capabilities?select=release&release=eq.round-projection-v2&limit=1`,
      {
        headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
        signal: controller.signal,
      },
    ),
    {
      timeoutMs,
      label: 'Production index schema check',
      onTimeout: () => controller.abort(),
    },
  );
  const body = await withOperationTimeout(
    () => response.json().catch(() => null),
    { timeoutMs, label: 'Production index schema response body' },
  );
  assert.ok(
    response.ok && Array.isArray(body) && body.length === 1,
    'Production index schema is incomplete; apply every Supabase migration through 20260808134500_round_projection_completeness.sql before starting workers',
  );
}

async function writeWallet(path, keypair) {
  await writeFile(path, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}

export async function main(env = process.env) {
  const mode = workerMode(env);
  const programIdText = String(env.MYNE_PROGRAM_ID || DEFAULT_PROGRAM_ID);
  const programId = new PublicKey(programIdText);
  const mint = new PublicKey(requiredEnv(env, 'MYNE_MINT_ADDRESS'));
  const rpcUrl = requiredEnv(env, 'ANCHOR_PROVIDER_URL');
  const supabaseUrl = requiredEnv(env, 'SUPABASE_URL').replace(/\/$/, '');
  const serviceRole = requiredEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
  assert.match(rpcUrl, /^https:\/\//, 'ANCHOR_PROVIDER_URL must use HTTPS');
  assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS');

  // Projection-only observation never receives an operational signer. Anchor
  // still requires a Wallet object for read APIs, so use an ephemeral keypair
  // that is not configured as any protocol authority.
  const randomness = mode === 'observe'
    ? Keypair.generate()
    : keypairFromBase64(
      requiredEnv(env, 'MYNE_RANDOMNESS_KEYPAIR_B64'),
      'MYNE_RANDOMNESS_KEYPAIR_B64',
    );
  const buyback = mode === 'observe'
    ? null
    : keypairFromBase64(
      requiredEnv(env, 'MYNE_BUYBACK_KEYPAIR_B64'),
      'MYNE_BUYBACK_KEYPAIR_B64',
    );
  if (buyback) {
    assert.ok(!randomness.publicKey.equals(buyback.publicKey), 'Operational wallets must be distinct');
  }

  const dataDir = safeDataDir(env, mode);
  const secretDir = '/tmp/myne-worker-secrets';
  const hostExternalTimeoutMs = Number(env.WORKER_HOST_EXTERNAL_TIMEOUT_MS || 8_000);
  assert.ok(
    Number.isSafeInteger(hostExternalTimeoutMs)
      && hostExternalTimeoutMs >= 500
      && hostExternalTimeoutMs <= 30_000,
    'WORKER_HOST_EXTERNAL_TIMEOUT_MS must be between 500 and 30000',
  );
  const repeatedTickErrorLimit = Number(
    env.WORKER_REPEATED_TICK_ERROR_LIMIT || DEFAULT_REPEATED_TICK_ERROR_LIMIT,
  );
  assert.ok(
    Number.isSafeInteger(repeatedTickErrorLimit)
      && repeatedTickErrorLimit >= 1
      && repeatedTickErrorLimit <= 20,
    'WORKER_REPEATED_TICK_ERROR_LIMIT must be between 1 and 20',
  );
  const settlementLateSeconds = Number(
    env.ROUND_KEEPER_SETTLEMENT_LATE_SECONDS || DEFAULT_ROUND_SETTLEMENT_LATE_SECONDS,
  );
  assert.ok(
    Number.isSafeInteger(settlementLateSeconds)
      && settlementLateSeconds >= 2
      && settlementLateSeconds <= 120,
    'ROUND_KEEPER_SETTLEMENT_LATE_SECONDS must be between 2 and 120',
  );
  const nextRoundPrebindGraceSeconds = Number(
    env.ROUND_KEEPER_PREBIND_GRACE_SECONDS || DEFAULT_NEXT_ROUND_PREBIND_GRACE_SECONDS,
  );
  const projectionFreshnessMs = Number(env.OBSERVE_PROJECTION_FRESHNESS_MS || 30_000);
  assert.ok(
    Number.isSafeInteger(projectionFreshnessMs)
      && projectionFreshnessMs >= 10_000
      && projectionFreshnessMs <= 120_000,
    'OBSERVE_PROJECTION_FRESHNESS_MS must be between 10000 and 120000',
  );
  assert.ok(
    Number.isSafeInteger(nextRoundPrebindGraceSeconds)
      && nextRoundPrebindGraceSeconds >= 2
      && nextRoundPrebindGraceSeconds <= 45,
    'ROUND_KEEPER_PREBIND_GRACE_SECONDS must be between 2 and 45',
  );
  const heartbeatTimeoutMs = Number(env.WORKER_HEARTBEAT_TIMEOUT_MS || 180_000);
  assert.ok(
    Number.isInteger(heartbeatTimeoutMs)
      && heartbeatTimeoutMs >= 60_000
      && heartbeatTimeoutMs <= 900_000,
    'WORKER_HEARTBEAT_TIMEOUT_MS must be between 60000 and 900000',
  );
  if (mode === 'live' || mode === 'observe') {
    const minimumHeartbeatTimeoutMs = minimumWorkerHeartbeatTimeoutMs(env);
    assert.ok(
      heartbeatTimeoutMs >= minimumHeartbeatTimeoutMs,
      `WORKER_HEARTBEAT_TIMEOUT_MS must be at least ${minimumHeartbeatTimeoutMs} for configured worker deadlines`,
    );
  }
  const successFreshnessByWorker = workerSuccessFreshnessMs(env);
  const state = {
    mode,
    ready: false,
    error: null,
    checkedAt: null,
    revision: env.RAILWAY_GIT_COMMIT_SHA || env.MYNE_RELEASE_COMMIT || 'local',
    heartbeatTimeoutMs,
    workerSuccessFreshnessMs: successFreshnessByWorker,
    repeatedTickErrorLimit,
    projectionFreshnessMs,
    protocolPaused: null,
    chainTime: null,
    minimumManagedRoundId: null,
    resumeActivation: null,
    roundHealth: null,
    roundProgress: new Map(),
    workers: new Map(WORKER_NAMES.map((name) => [name, {
      running: false,
      restarts: 0,
      lastHeartbeatAt: null,
      lastCompletedAt: null,
      lastOutcome: null,
      lastSuccessfulAt: null,
      consecutiveErrors: 0,
    }])),
  };

  const boundedHostRequest = (label, operation) => withOperationTimeout(
    operation,
    { timeoutMs: hostExternalTimeoutMs, label },
  );

  const port = Number(env.PORT || 8080);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, 'PORT is invalid');
  const server = createServer((request, response) => {
    const health = publicHealth(state);
    response.statusCode = request.url === '/healthz' && health.ok ? 200 : request.url === '/healthz' ? 503 : 404;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(`${JSON.stringify(request.url === '/healthz' ? health : { error: 'not-found' })}\n`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });

  const connection = new Connection(rpcUrl, 'confirmed');
  const idl = JSON.parse(await readFile(
    new URL('../target/idl/myne_protocol.json', import.meta.url),
    'utf8',
  ));
  const provider = new AnchorProvider(connection, new Wallet(randomness), { commitment: 'confirmed' });
  const program = new Program(idl, provider);
  const [configAddress] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  const [gateAddress] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_gate')], programId);
  let validatedRandomnessMode = null;
  let validatedRoundSchedule = null;
  let validatedProtocolPaused = null;

  const validate = async () => {
    const genesisHash = await boundedHostRequest(
      'Worker host genesis hash read',
      () => connection.getGenesisHash(),
    );
    const config = await boundedHostRequest(
      'Worker host protocol config read',
      () => program.account.protocolConfig.fetch(configAddress),
    );
    const serverRandomness = config.randomnessProgram.equals(programId);
    const network = requireMatchingSolanaNetwork({
      genesisHash,
      randomnessProgram: config.randomnessProgram.toBase58(),
      serverRandomnessProgram: programId.toBase58(),
    });
    assert.equal(network, 'mainnet-beta', 'Production worker host requires Solana Mainnet');
    assert.equal(Number(config.version), 6, 'Production worker host requires protocol v6');
    assert.ok(config.mint.equals(mint), 'Configured MYNE mint does not match MYNE_MINT_ADDRESS');
    if (mode !== 'observe') {
      assert.ok(
        config.randomnessAuthority.equals(randomness.publicKey),
        'Randomness keypair does not match the configured authority',
      );
    }
    if (buyback) {
      assert.ok(config.buybackWallet.equals(buyback.publicKey), 'Buyback keypair does not match config');
    }
    const bettingDurationSeconds = Number(config.bettingDurationSeconds.toString());
    const roundDurationSeconds = Number(config.roundDurationSeconds.toString());
    const initializedAt = Number(config.initializedAt.toString());
    assert.equal(
      bettingDurationSeconds,
      PROVIDER_PREPARATION_LEAD_SECONDS,
      'Worker preparation lead must match the deployed v6 betting duration',
    );
    assert.ok(
      Number.isSafeInteger(roundDurationSeconds)
        && roundDurationSeconds > PROVIDER_PREPARATION_LEAD_SECONDS,
      'Configured round duration is invalid',
    );
    assert.ok(Number.isSafeInteger(initializedAt), 'Configured genesis timestamp is invalid');
    validatedRandomnessMode = serverRandomness ? 'server' : 'switchboard';
    validatedRoundSchedule = { initializedAt, roundDurationSeconds };
    validatedProtocolPaused = Boolean(config.paused);
    state.protocolPaused = validatedProtocolPaused;
    const gate = await boundedHostRequest(
      'Worker host liquidity gate read',
      () => program.account.liquidityGate.fetch(gateAddress),
    );
    assert.equal(gate.verified, true, 'Meteora liquidity gate is not verified');
    assert.ok(!gate.pool.equals(PublicKey.default), 'Meteora liquidity pool is missing');
    if (mode === 'standby' || mode === 'observe') {
      assert.equal(config.paused, true, `${mode} host refuses an active protocol`);
    }

    await requireProductionIndexSchema({
      supabaseUrl,
      serviceRole,
      timeoutMs: hostExternalTimeoutMs,
    });
    state.ready = true;
    state.error = null;
    state.checkedAt = new Date().toISOString();
  };

  const validateSafely = async () => {
    try {
      await validate();
    } catch (error) {
      state.ready = false;
      state.error = error instanceof Error ? error.message : String(error);
      state.checkedAt = new Date().toISOString();
      console.error(JSON.stringify({ event: 'worker-host-preflight-error', message: state.error }));
      throw error;
    }
  };

  try {
    await validateSafely();
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  console.log(JSON.stringify({ event: 'worker-host-ready', mode, revision: state.revision }));

  const timers = new Set();
  const children = new Map();
  let stopping = false;
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timer.unref();
    timers.add(timer);
  };

  if (mode === 'standby') {
    const heartbeat = async () => {
      if (stopping) return;
      try {
        await validateSafely();
      } catch {
        // Health remains failed until the next successful check.
      }
      schedule(heartbeat, 30_000);
    };
    schedule(heartbeat, 30_000);
  } else if (mode === 'observe') {
    assert.equal(
      env.MYNE_WORKER_HOST_OBSERVE,
      programIdText,
      `Set MYNE_WORKER_HOST_OBSERVE=${programIdText} to authorize project-only observation`,
    );
    for (const name of ['ROUND_INDEXER_START_SLOT', 'REFERRAL_INDEXER_START_SLOT']) {
      const value = Number(requiredEnv(env, name));
      assert.ok(Number.isSafeInteger(value) && value >= 0, `${name} must be a non-negative integer`);
    }
    await rm(secretDir, { recursive: true, force: true });
    await mkdir(secretDir, { recursive: true, mode: 0o700 });
    const randomnessWalletPath = `${secretDir}/randomness.json`;
    await writeWallet(randomnessWalletPath, randomness);
    const [observeSpec] = observeWorkerSpecs({
      programId: programIdText,
      randomnessWalletPath,
      randomnessMode: validatedRandomnessMode,
    });
    const observeEnv = childEnvironment(env, {
      ANCHOR_PROVIDER_URL: rpcUrl,
      ANCHOR_WALLET: observeSpec.walletPath,
      MYNE_PROGRAM_ID: programIdText,
      MYNE_MINT_ADDRESS: mint.toBase58(),
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceRole,
      ROUND_INDEXER_LEASE_HOLDER: String(
        env.ROUND_INDEXER_LEASE_HOLDER
          || `${programIdText}:observe:${env.RAILWAY_DEPLOYMENT_ID || 'local'}:${env.RAILWAY_REPLICA_ID || process.pid}`,
      ),
      ...observeSpec.env,
    });
    const startObserver = () => {
      if (stopping) return;
      const status = state.workers.get(observeSpec.name);
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL(observeSpec.script, import.meta.url))],
        {
          env: observeEnv,
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        },
      );
      children.set(observeSpec.name, child);
      status.running = true;
      status.lastHeartbeatAt = Date.now();
      status.lastHeartbeatPhase = 'starting';
      status.lastOutcome = 'starting-project-only';
      status.lastSuccessfulAt = null;
      status.watchdogTerminating = false;
      child.on('message', (message) => {
        if (!recordWorkerHeartbeat(status, message, { expectedWorker: observeSpec.name })) return;
        const partialError = message.phase === 'tick-complete'
          && String(message.outcome || '').startsWith('partial-error:');
        if (message.phase === 'tick-error' || partialError) status.consecutiveErrors += 1;
        if (message.phase === 'tick-complete' && !partialError) {
          status.consecutiveErrors = 0;
          if (isSuccessfulWorkerOutcome(message.outcome, observeSpec.name)) {
            status.lastSuccessfulAt = status.lastHeartbeatAt;
          }
        }
      });
      console.log(JSON.stringify({
        event: 'worker-started',
        worker: observeSpec.name,
        mode: 'project-only',
        pid: child.pid,
      }));
      child.once('exit', (code, signal) => {
        const watchdogTerminated = status.watchdogTerminating;
        children.delete(observeSpec.name);
        status.running = false;
        status.watchdogTerminating = false;
        if (stopping) return;
        if (code !== 0 && status.lastHeartbeatPhase !== 'tick-error' && !watchdogTerminated) {
          status.consecutiveErrors += 1;
        }
        status.restarts += 1;
        const delay = Math.min(60_000, 1_000 * (2 ** Math.min(status.restarts, 6)));
        console.error(JSON.stringify({
          event: 'worker-exited',
          worker: observeSpec.name,
          mode: 'project-only',
          code,
          signal,
          restartInMs: delay,
        }));
        schedule(startObserver, delay);
      });
    };
    const superviseObserver = () => {
      if (stopping) return;
      const status = state.workers.get(observeSpec.name);
      const child = children.get(observeSpec.name);
      if (child && !status.watchdogTerminating && !workerHeartbeatFresh(status, {
        now: Date.now(),
        maxAgeMs: heartbeatTimeoutMs,
      })) {
        status.watchdogTerminating = true;
        status.lastOutcome = 'heartbeat-stale';
        console.error(JSON.stringify({
          event: 'worker-heartbeat-stale',
          worker: observeSpec.name,
          mode: 'project-only',
          heartbeatTimeoutMs,
        }));
        child.kill('SIGTERM');
        schedule(() => {
          if (children.get(observeSpec.name) === child
              && child.exitCode === null
              && child.signalCode === null) child.kill('SIGKILL');
        }, 5_000);
      }
      schedule(superviseObserver, Math.max(5_000, Math.floor(heartbeatTimeoutMs / 4)));
    };
    const validateObserver = async () => {
      if (stopping) return;
      try {
        await validateSafely();
      } catch {
        // Observe mode stays read/project-only; health remains failed until the
        // protocol is paused and all preflight dependencies recover.
      }
      schedule(() => void validateObserver(), 30_000);
    };
    startObserver();
    schedule(superviseObserver, Math.max(5_000, Math.floor(heartbeatTimeoutMs / 4)));
    schedule(() => void validateObserver(), 30_000);
  } else {
    assert.equal(
      env.MYNE_WORKER_HOST_LIVE,
      programIdText,
      `Set MYNE_WORKER_HOST_LIVE=${programIdText} to authorize live workers`,
    );
    for (const name of ['ROUND_INDEXER_START_SLOT', 'REFERRAL_INDEXER_START_SLOT']) {
      const value = Number(requiredEnv(env, name));
      assert.ok(Number.isSafeInteger(value) && value >= 0, `${name} must be a non-negative integer`);
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const dataInfo = await stat(dataDir);
    assert.ok(dataInfo.isDirectory(), 'Worker data path is not a directory');
    await rm(secretDir, { recursive: true, force: true });
    await mkdir(secretDir, { recursive: true, mode: 0o700 });
    const randomnessWalletPath = `${secretDir}/randomness.json`;
    const buybackWalletPath = `${secretDir}/buyback.json`;
    await writeWallet(randomnessWalletPath, randomness);
    await writeWallet(buybackWalletPath, buyback);

    const commonEnv = childEnvironment(env, {
      ANCHOR_PROVIDER_URL: rpcUrl,
      MYNE_PROGRAM_ID: programIdText,
      MYNE_MINT_ADDRESS: mint.toBase58(),
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceRole,
      ROUND_INDEXER_LEASE_HOLDER: String(
        env.ROUND_INDEXER_LEASE_HOLDER
          || `${programIdText}:${env.RAILWAY_DEPLOYMENT_ID || 'local'}:${env.RAILWAY_REPLICA_ID || process.pid}`,
      ),
      BUYBACK_LEASE_HOLDER: String(
        env.BUYBACK_LEASE_HOLDER
          || `${programIdText}:${env.RAILWAY_DEPLOYMENT_ID || 'local'}:${env.RAILWAY_REPLICA_ID || process.pid}`,
      ),
    });
    const specs = liveWorkerSpecs({
      programId: programIdText,
      randomnessWalletPath,
      buybackWalletPath,
      dataDir,
      randomnessMode: validatedRandomnessMode,
    });
    const configuredMinimumManagedRoundId = firstManagedRoundId(env, validatedRandomnessMode);
    let minimumManagedRoundId = configuredMinimumManagedRoundId;
    state.minimumManagedRoundId = minimumManagedRoundId;
    const roundHealthLookback = Number(env.ROUND_HEALTH_LOOKBACK || 8);
    assert.ok(
      Number.isSafeInteger(roundHealthLookback)
        && roundHealthLookback >= 1
        && roundHealthLookback <= 32,
      'ROUND_HEALTH_LOOKBACK must be between 1 and 32',
    );
    const roundRequestBudgets = [
      Number(env.ROUND_KEEPER_RPC_TIMEOUT_MS || 8_000) * 2,
      Number(env.ROUND_KEEPER_TRANSACTION_TIMEOUT_MS || 12_000),
      Number(env.ROUND_KEEPER_TRANSACTION_FLOW_TIMEOUT_MS || 30_000),
      Number(env.AUTO_PLAN_OPERATION_TIMEOUT_MS || 8_000),
    ];
    assert.ok(
      roundRequestBudgets.every((value) => Number.isSafeInteger(value) && value > 0),
      'Round keeper operation timeouts must be positive integers',
    );
    const minimumRoundHeartbeatTimeoutMs = Math.max(...roundRequestBudgets) + 5_000;
    const roundHeartbeatTimeoutMs = Number(env.ROUND_KEEPER_HEARTBEAT_TIMEOUT_MS || 40_000);
    assert.ok(
      Number.isSafeInteger(roundHeartbeatTimeoutMs)
        && roundHeartbeatTimeoutMs >= minimumRoundHeartbeatTimeoutMs
        && roundHeartbeatTimeoutMs <= 120_000,
      `ROUND_KEEPER_HEARTBEAT_TIMEOUT_MS must be between ${minimumRoundHeartbeatTimeoutMs} and 120000`,
    );
    let lastRoundAuditAt = 0;

    const roundAddress = (roundId) => {
      const seed = Buffer.alloc(8);
      seed.writeBigUInt64LE(BigInt(roundId));
      return PublicKey.findProgramAddressSync([Buffer.from('round'), seed], programId)[0];
    };

    const confirmedChainTime = async (cancelled = () => false) => {
      if (cancelled()) throw new Error('Round scheduler chain-time observation cancelled');
      const slot = await boundedHostRequest(
        'Round scheduler confirmed slot read',
        () => connection.getSlot('confirmed'),
      );
      let lastError = null;
      for (let offset = 0; offset < 16 && slot >= offset; offset += 1) {
        if (cancelled()) throw new Error('Round scheduler chain-time observation cancelled');
        try {
          const blockTime = await boundedHostRequest(
            `Round scheduler block time ${slot - offset}`,
            () => connection.getBlockTime(slot - offset),
          );
          if (Number.isSafeInteger(blockTime)) return blockTime;
        } catch (error) {
          lastError = error;
          if (Number(error?.code) !== -32004) break;
        }
      }
      const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`Confirmed chain time is unavailable${detail}`);
    };

    const refreshRoundHealth = async ({ force = false } = {}) => {
      if (!force && Date.now() - lastRoundAuditAt < 1_000 && Number.isSafeInteger(state.chainTime)) {
        return state.chainTime;
      }
      let chainTimeCancelled = false;
      const chainNow = await withOperationTimeout(
        () => confirmedChainTime(() => chainTimeCancelled), {
          timeoutMs: Math.min(30_000, hostExternalTimeoutMs * 2),
          label: 'Round scheduler chain-time observation',
          onTimeout: () => { chainTimeCancelled = true; },
        },
      );
      state.chainTime = chainNow;
      const currentRoundId = chainNow < validatedRoundSchedule.initializedAt
        ? null
        : Math.floor(
          (chainNow - validatedRoundSchedule.initializedAt)
            / validatedRoundSchedule.roundDurationSeconds,
        );
      const roundIds = currentRoundId == null
        ? []
        : [
          ...Array.from(
            { length: roundHealthLookback },
            (_, offset) => currentRoundId - roundHealthLookback + offset,
          ),
          currentRoundId,
          currentRoundId + 1,
        ]
          .filter((roundId) => roundId >= minimumManagedRoundId);
      const accounts = roundIds.length === 0
        ? []
        : await boundedHostRequest(
          'Current round-set account reads',
          () => program.account.round.fetchMultiple(roundIds.map(roundAddress)),
        );
      const rows = roundIds.map((roundId, index) => {
        const account = accounts[index];
        if (!account) return { roundId, prepared: false, entropyLocked: false };
        const randomnessCommitSlot = BigInt(account.randomnessCommitSlot?.toString?.() || 0);
        return {
          roundId,
          prepared: !account.randomnessAccount.equals(PublicKey.default),
          entropyLocked: validatedRandomnessMode === 'server'
            ? randomnessCommitSlot !== SERVER_RANDOMNESS_PENDING && randomnessCommitSlot > 0n
            : randomnessCommitSlot > 0n,
          funded: BigInt(account.totalReceipts?.toString?.() || 0) > 0n
            || BigInt(account.grossDeployedLamports?.toString?.() || 0) > 0n,
          settled: Boolean(account.settled),
        };
      });
      const nextRoundHealth = assessRoundScheduleHealth({
        now: chainNow,
        initializedAt: validatedRoundSchedule.initializedAt,
        roundDurationSeconds: validatedRoundSchedule.roundDurationSeconds,
        settlementLateSeconds,
        nextRoundPrebindGraceSeconds,
        minimumManagedRoundId,
        lookbackRounds: roundHealthLookback,
        protocolPaused,
        rows,
      });
      const resumeActivation = state.resumeActivation;
      if (resumeActivation && !resumeActivation.prebound) {
        const activationRow = rows.find(({ roundId }) => roundId === resumeActivation.roundId);
        if (activationRow?.prepared) {
          state.resumeActivation = {
            ...resumeActivation,
            prebound: true,
            preboundAtChainTime: chainNow,
          };
          const recoveredFatalError = Number.isSafeInteger(fatalRoundId)
            && fatalRoundId < resumeActivation.roundId
            ? fatalRoundError
            : null;
          if (recoveredFatalError) {
            fatalRoundError = null;
            fatalRoundId = null;
            if (state.error === recoveredFatalError) {
              state.ready = true;
              state.error = null;
            }
          }
          console.log(JSON.stringify({
            event: 'round-resume-activation-prebound',
            provider: validatedRandomnessMode,
            round: resumeActivation.roundId,
            chainTime: chainNow,
            recoveredFatal: Boolean(recoveredFatalError),
          }));
        }
      }
      for (const entry of nextRoundHealth.entries) {
        if (!entry.condition.endsWith('-late')) continue;
        const progress = state.roundProgress.get(String(entry.roundId));
        if (progress && progress.deadlineViolation !== entry.condition) {
          progress.deadlineViolation = entry.condition;
          progress.lastOutcome = entry.condition;
          progress.consecutiveErrors += 1;
          console.error(JSON.stringify({
            event: 'round-worker-deadline-missed',
            provider: validatedRandomnessMode,
            round: entry.roundId,
            condition: entry.condition,
            chainTime: chainNow,
            prepareAt: entry.prepareAt,
            lockAt: entry.lockAt,
            settleAt: entry.settleAt,
          }));
        }
        if (entry.condition === 'prepare-late') {
          fatalRoundError = `Round ${entry.roundId} was not prepared before its scheduled opened_at`;
          fatalRoundId = entry.roundId;
        }
      }
      state.roundHealth = nextRoundHealth;
      lastRoundAuditAt = Date.now();
      state.checkedAt = new Date().toISOString();
      return chainNow;
    };

    const startWorker = (spec) => {
      if (stopping) return;
      const status = state.workers.get(spec.name);
      const startedAt = Date.now();
      const child = spawn(process.execPath, [fileURLToPath(new URL(spec.script, import.meta.url))], {
        env: { ...commonEnv, ...spec.env, ANCHOR_WALLET: spec.walletPath },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      children.set(spec.name, child);
      status.running = true;
      status.lastHeartbeatAt = startedAt;
      status.lastHeartbeatPhase = 'starting';
      status.lastOutcome = 'starting';
      status.lastSuccessfulAt = null;
      status.watchdogTerminating = false;
      child.on('message', (message) => {
        if (!recordWorkerHeartbeat(status, message, { expectedWorker: spec.name })) return;
        const partialError = message.phase === 'tick-complete'
          && String(message.outcome || '').startsWith('partial-error:');
        if (message.phase === 'tick-error' || partialError) status.consecutiveErrors += 1;
        if (message.phase === 'tick-complete' && !partialError) {
          status.consecutiveErrors = 0;
          if (isSuccessfulWorkerOutcome(message.outcome, spec.name)) {
            status.lastSuccessfulAt = status.lastHeartbeatAt;
          }
        }
      });
      console.log(JSON.stringify({ event: 'worker-started', worker: spec.name, pid: child.pid }));
      child.once('exit', (code, signal) => {
        const watchdogTerminated = status.watchdogTerminating;
        children.delete(spec.name);
        status.running = false;
        status.watchdogTerminating = false;
        if (stopping) return;
        if (code !== 0 && status.lastHeartbeatPhase !== 'tick-error' && !watchdogTerminated) {
          status.consecutiveErrors += 1;
        }
        const healthyRun = Date.now() - startedAt >= 60_000;
        status.restarts = healthyRun ? 1 : status.restarts + 1;
        const delay = Math.min(60_000, 1_000 * (2 ** Math.min(status.restarts, 6)));
        console.error(JSON.stringify({
          event: 'worker-exited', worker: spec.name, code, signal, restartInMs: delay,
        }));
        schedule(() => startWorker(spec), delay);
      });
    };

    const watchdogIntervalMs = Math.max(5_000, Math.min(30_000, Math.floor(heartbeatTimeoutMs / 4)));
    const checkWorkerHeartbeats = () => {
      if (stopping) return;
      const now = Date.now();
      for (const spec of specs.filter((entry) => !entry.perRound)) {
        const status = state.workers.get(spec.name);
        const child = children.get(spec.name);
        if (!child || status.watchdogTerminating || workerHeartbeatFresh(status, {
          now,
          maxAgeMs: heartbeatTimeoutMs,
        })) continue;
        status.watchdogTerminating = true;
        status.lastOutcome = 'heartbeat-stale';
        console.error(JSON.stringify({
          event: 'worker-heartbeat-stale',
          worker: spec.name,
          heartbeatTimeoutMs,
          lastHeartbeatAt: Number.isFinite(status.lastHeartbeatAt)
            ? new Date(status.lastHeartbeatAt).toISOString()
            : null,
        }));
        child.kill('SIGTERM');
        schedule(() => {
          if (children.get(spec.name) === child
              && child.exitCode === null
              && child.signalCode === null) child.kill('SIGKILL');
        }, 5_000);
      }
      for (const [id, progress] of state.roundProgress.entries()) {
        if (!progress.running) continue;
        const instance = roundInstance(id);
        const child = children.get(instance);
        if (!child || progress.watchdogTerminating) continue;
        const heartbeatAgeMs = now - Number(progress.lastHeartbeatAt || 0);
        if (heartbeatAgeMs > roundHeartbeatTimeoutMs) {
          progress.watchdogTerminating = true;
          progress.lastOutcome = 'heartbeat-stale';
          progress.consecutiveErrors += 1;
          console.error(JSON.stringify({
            event: 'round-worker-heartbeat-stale',
            round: id,
            stage: progress.stage,
            heartbeatAgeMs,
            roundHeartbeatTimeoutMs,
          }));
          child.kill('SIGTERM');
          schedule(() => {
            if (children.get(instance) === child
                && child.exitCode === null
                && child.signalCode === null) child.kill('SIGKILL');
          }, 5_000);
        }
      }
      schedule(checkWorkerHeartbeats, watchdogIntervalMs);
    };

    const roundSpec = specs.find((spec) => spec.perRound);
    assert.ok(roundSpec, 'A per-round randomness keeper is required');
    const launchedRounds = new Set();
    const roundRestartAttempts = new Map();
    let protocolPaused = validatedProtocolPaused;
    let lastScheduleConfigReadAt = 0;
    let fatalRoundError = null;
    let fatalRoundId = null;
    const selectResumeActivation = ({ chainNow, reason }) => {
      const safeResumeRoundId = firstSafeResumeRoundId({
        now: chainNow,
        initializedAt: validatedRoundSchedule.initializedAt,
        roundDurationSeconds: validatedRoundSchedule.roundDurationSeconds,
        preparationSafetyMarginSeconds: PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS,
        nextRoundPrebindGraceSeconds,
      });
      minimumManagedRoundId = Math.max(minimumManagedRoundId, safeResumeRoundId);
      state.minimumManagedRoundId = minimumManagedRoundId;
      state.resumeActivation = {
        roundId: minimumManagedRoundId,
        selectedAtChainTime: chainNow,
        prebound: false,
        preboundAtChainTime: null,
        reason,
      };
      state.chainTime = chainNow;
      lastRoundAuditAt = 0;
      console.log(JSON.stringify({
        event: 'round-resume-activation-selected',
        provider: validatedRandomnessMode,
        round: minimumManagedRoundId,
        chainTime: chainNow,
        reason,
        configuredMinimumManagedRoundId,
      }));
    };
    const roundInstance = (roundId) => `${roundSpec.name}:${roundId}`;
    const refreshRoundWorkerStatus = () => {
      const status = state.workers.get(roundSpec.name);
      status.running = [...children.keys()].some((name) => name.startsWith(`${roundSpec.name}:`));
    };
    const startRoundWorker = (roundId) => {
      const id = String(roundId);
      const numericRoundId = Number(roundId);
      if (
        stopping
        || protocolPaused
        || !Number.isSafeInteger(numericRoundId)
        || numericRoundId < minimumManagedRoundId
        || launchedRounds.has(id)
      ) return;
      launchedRounds.add(id);
      const instance = roundInstance(id);
      const status = state.workers.get(roundSpec.name);
      const deadlines = canonicalRoundDeadlines({
        roundId: Number(roundId),
        initializedAt: validatedRoundSchedule.initializedAt,
        roundDurationSeconds: validatedRoundSchedule.roundDurationSeconds,
        settlementLateSeconds,
        nextRoundPrebindGraceSeconds,
      });
      const priorProgress = state.roundProgress.get(id);
      const progress = {
        roundId: Number(roundId),
        running: true,
        stage: 'starting',
        lastHeartbeatAt: Date.now(),
        lastHeartbeatPhase: 'starting',
        lastOutcome: 'starting',
        consecutiveErrors: Number(priorProgress?.consecutiveErrors || 0),
        deadlineViolation: priorProgress?.deadlineViolation || null,
        watchdogTerminating: false,
        ...deadlines,
      };
      state.roundProgress.set(id, progress);
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL(roundSpec.script, import.meta.url))],
        {
          env: {
            ...commonEnv,
            ...roundSpec.env,
            ANCHOR_WALLET: roundSpec.walletPath,
            MYNE_ROUND_ID: id,
          },
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        },
      );
      children.set(instance, child);
      refreshRoundWorkerStatus();
      status.lastHeartbeatAt = Date.now();
      status.lastOutcome = `round-${id}:starting`;
      child.on('message', (message) => {
        if (String(message?.roundId ?? '') !== id) return;
        if (!recordWorkerHeartbeat(status, message, { expectedWorker: roundSpec.name })) return;
        progress.lastHeartbeatAt = status.lastHeartbeatAt;
        progress.lastHeartbeatPhase = message.phase;
        progress.stage = typeof message.stage === 'string' ? message.stage : progress.stage;
        progress.lastOutcome = status.lastOutcome;
        if (message.deadlines && typeof message.deadlines === 'object') {
          for (const name of ['prebindAt', 'prepareAt', 'lockAt', 'settleAt', 'refundAt']) {
            if (Number.isSafeInteger(message.deadlines[name])) progress[name] = message.deadlines[name];
          }
        }
        if (message.phase === 'tick-error') {
          progress.consecutiveErrors += 1;
          status.consecutiveErrors += 1;
          if (ROUND_DEADLINE_VIOLATION_STAGES.has(message.stage)) {
            progress.deadlineViolation = message.stage;
          }
        }
        if (message.phase === 'tick-complete') {
          progress.consecutiveErrors = 0;
          status.consecutiveErrors = 0;
        }
      });
      console.log(JSON.stringify({
        event: 'round-worker-started',
        worker: roundSpec.name,
        provider: validatedRandomnessMode,
        round: id,
        pid: child.pid,
      }));
      child.once('exit', (code, signal) => {
        const watchdogTerminated = progress.watchdogTerminating;
        children.delete(instance);
        progress.running = false;
        progress.watchdogTerminating = false;
        progress.exitCode = code;
        progress.signal = signal;
        progress.lastOutcome = code === 0 ? 'completed' : progress.lastOutcome;
        refreshRoundWorkerStatus();
        if (stopping) return;
        if (code === ROUND_KEEPER_DEFERRED_EXIT_CODE) {
          launchedRounds.delete(id);
          roundRestartAttempts.delete(id);
          console.log(JSON.stringify({
            event: 'round-worker-deferred',
            worker: roundSpec.name,
            provider: validatedRandomnessMode,
            round: id,
            reason: 'protocol-paused',
          }));
          return;
        }
        if (code === ROUND_KEEPER_MISSED_EXIT_CODE) {
          if (Number(id) < minimumManagedRoundId) {
            console.log(JSON.stringify({
              event: 'round-worker-intentionally-skipped',
              worker: roundSpec.name,
              provider: validatedRandomnessMode,
              round: id,
              minimumManagedRoundId,
            }));
            return;
          }
          fatalRoundError = `Round ${id} was not prepared before its scheduled opened_at`;
          fatalRoundId = Number(id);
          state.ready = false;
          state.error = fatalRoundError;
          console.error(JSON.stringify({
            event: 'round-worker-window-missed',
            worker: roundSpec.name,
            provider: validatedRandomnessMode,
            round: id,
          }));
          return;
        }
        if (stopping || code === 0) {
          roundRestartAttempts.delete(id);
          return;
        }
        if (progress.lastHeartbeatPhase !== 'tick-error' && !watchdogTerminated) {
          progress.consecutiveErrors += 1;
          status.consecutiveErrors += 1;
        }
        const attempt = (roundRestartAttempts.get(id) || 0) + 1;
        roundRestartAttempts.set(id, attempt);
        status.restarts += 1;
        const delay = Math.min(30_000, 500 * (2 ** Math.min(attempt, 6)));
        console.error(JSON.stringify({
          event: 'round-worker-exited',
          worker: roundSpec.name,
          provider: validatedRandomnessMode,
          round: id,
          code,
          signal,
          restartInMs: delay,
        }));
        schedule(() => {
          launchedRounds.delete(id);
          startRoundWorker(id);
        }, delay);
      });
    };

    for (const spec of specs.filter((entry) => !entry.perRound)) startWorker(spec);
    schedule(checkWorkerHeartbeats, watchdogIntervalMs);
    const refreshScheduleConfig = async () => {
      if (Date.now() - lastScheduleConfigReadAt < 1_000) return true;
      try {
        const latestConfig = await boundedHostRequest(
          'Round scheduler protocol config read',
          () => program.account.protocolConfig.fetch(configAddress),
        );
        const latestMode = latestConfig.randomnessProgram.equals(programId) ? 'server' : 'switchboard';
        assert.equal(latestMode, validatedRandomnessMode, 'Randomness provider changed; restart the worker host');
        assert.equal(
          Number(latestConfig.initializedAt.toString()),
          validatedRoundSchedule.initializedAt,
          'Protocol schedule origin changed; restart the worker host',
        );
        assert.equal(
          Number(latestConfig.roundDurationSeconds.toString()),
          validatedRoundSchedule.roundDurationSeconds,
          'Protocol round duration changed; restart the worker host',
        );
        const nextProtocolPaused = Boolean(latestConfig.paused);
        if (protocolPaused && !nextProtocolPaused) {
          let chainTimeCancelled = false;
          const resumeChainNow = await withOperationTimeout(
            () => confirmedChainTime(() => chainTimeCancelled), {
              timeoutMs: Math.min(30_000, hostExternalTimeoutMs * 2),
              label: 'Round resume chain-time observation',
              onTimeout: () => { chainTimeCancelled = true; },
            },
          );
          selectResumeActivation({
            chainNow: resumeChainNow,
            reason: 'paused-to-live',
          });
        }
        protocolPaused = nextProtocolPaused;
        state.protocolPaused = protocolPaused;
        lastScheduleConfigReadAt = Date.now();
        state.checkedAt = new Date().toISOString();
        if (!fatalRoundError) {
          state.ready = true;
          state.error = null;
        }
        return true;
      } catch (error) {
        state.ready = false;
        state.error = error instanceof Error ? error.message : String(error);
        state.checkedAt = new Date().toISOString();
        console.error(JSON.stringify({
          event: 'round-schedule-config-error',
          message: state.error,
        }));
        return false;
      }
    };
    const scheduleRoundWorkers = async () => {
      if (stopping) return;
      try {
        const configReadable = await refreshScheduleConfig();
        if (configReadable) {
          const chainNow = await refreshRoundHealth();
          if (!protocolPaused) {
            const missingCurrent = state.roundHealth?.entries.find((entry) => (
              entry.role === 'current'
              && entry.condition === 'prepare-late'
              && entry.prepared === false
            ));
            const priorActivationFinished = !state.resumeActivation
              || (
                state.resumeActivation.prebound === true
                && state.resumeActivation.roundId < Number(missingCurrent?.roundId ?? 0)
              );
            // A live-host restart can occur after governance has unpaused but
            // before the selected future Round PDA exists. The transition was
            // then observed by the previous process. Re-derive a future floor
            // only when the scheduled current PDA is truly absent; an existing
            // current round continues through the normal restart path below.
            if (missingCurrent && priorActivationFinished) {
              selectResumeActivation({
                chainNow,
                reason: 'missing-current-on-live-host',
              });
            }
            const roundIds = roundIdsToPrepare({
              now: chainNow,
              initializedAt: validatedRoundSchedule.initializedAt,
              roundDurationSeconds: validatedRoundSchedule.roundDurationSeconds,
              preparationSafetyMarginSeconds: PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS,
            });
            for (const roundId of roundIds) {
              if (roundId >= minimumManagedRoundId) startRoundWorker(roundId);
            }

            // Completed identifiers no longer need memory once they are well behind
            // the active schedule. Running/retrying children retain their entries.
            const oldestRetained = (roundIds[0] ?? 0) - 2;
            for (const id of launchedRounds) {
              if (Number(id) < oldestRetained && !children.has(roundInstance(id))) {
                launchedRounds.delete(id);
                roundRestartAttempts.delete(id);
                state.roundProgress.delete(id);
              }
            }
          }
        }
      } catch (error) {
        state.ready = false;
        state.error = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: 'round-schedule-error', message: state.error }));
      } finally {
        schedule(() => void scheduleRoundWorkers(), 500);
      }
    };
    void scheduleRoundWorkers();
  }

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    state.ready = false;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    console.log(JSON.stringify({ event: 'worker-host-stopping', signal }));
    for (const child of children.values()) child.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    await Promise.race([
      Promise.all([...children.values()].map((child) => new Promise((resolve) => child.once('exit', resolve)))),
      new Promise((resolve) => setTimeout(resolve, 25_000)),
    ]);
    for (const child of children.values()) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(secretDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'worker-host-fatal',
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
