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
import {
  PROVIDER_PREPARATION_LEAD_SECONDS,
  roundIdsToPrepare,
} from './round-schedule-policy.mjs';

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
  assert.ok(mode === 'standby' || mode === 'live', 'MYNE_WORKER_MODE must be standby or live');
  return mode;
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
  return [
    {
      name: 'round-indexer',
      script: 'round-indexer.mjs',
      walletPath: randomnessWalletPath,
      env: {
        FAIL_FAST: '1',
        ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE: '1',
      },
    },
    {
      name: 'round-lifecycle',
      script: 'round-lifecycle-keeper.mjs',
      walletPath: randomnessWalletPath,
      env: { FAIL_FAST: '1' },
    },
    {
      name: 'buyback-keeper',
      script: 'buyback-keeper.mjs',
      walletPath: buybackWalletPath,
      env: {
        FAIL_FAST: '1',
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

export function childEnvironment(env, overrides = {}) {
  const childEnv = { ...env, ...overrides };
  delete childEnv.MYNE_RANDOMNESS_KEYPAIR_B64;
  delete childEnv.MYNE_BUYBACK_KEYPAIR_B64;
  return childEnv;
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

function publicHealth(state) {
  return {
    ok: state.ready && !state.error,
    mode: state.mode,
    checkedAt: state.checkedAt,
    revision: state.revision,
    workers: Object.fromEntries(
      [...state.workers.entries()].map(([name, value]) => [name, {
        running: value.running,
        restarts: value.restarts,
      }]),
    ),
  };
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

  const randomness = keypairFromBase64(
    requiredEnv(env, 'MYNE_RANDOMNESS_KEYPAIR_B64'),
    'MYNE_RANDOMNESS_KEYPAIR_B64',
  );
  const buyback = keypairFromBase64(
    requiredEnv(env, 'MYNE_BUYBACK_KEYPAIR_B64'),
    'MYNE_BUYBACK_KEYPAIR_B64',
  );
  assert.ok(!randomness.publicKey.equals(buyback.publicKey), 'Operational wallets must be distinct');

  const dataDir = safeDataDir(env, mode);
  const secretDir = '/tmp/myne-worker-secrets';
  const state = {
    mode,
    ready: false,
    error: null,
    checkedAt: null,
    revision: env.RAILWAY_GIT_COMMIT_SHA || env.MYNE_RELEASE_COMMIT || 'local',
    workers: new Map(WORKER_NAMES.map((name) => [name, { running: false, restarts: 0 }])),
  };

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

  const validate = async () => {
    const genesisHash = await connection.getGenesisHash();
    const config = await program.account.protocolConfig.fetch(configAddress);
    const serverRandomness = config.randomnessProgram.equals(programId);
    const network = requireMatchingSolanaNetwork({
      genesisHash,
      randomnessProgram: config.randomnessProgram.toBase58(),
      serverRandomnessProgram: programId.toBase58(),
    });
    assert.equal(network, 'mainnet-beta', 'Production worker host requires Solana Mainnet');
    assert.equal(Number(config.version), 6, 'Production worker host requires protocol v6');
    assert.ok(config.mint.equals(mint), 'Configured MYNE mint does not match MYNE_MINT_ADDRESS');
    assert.ok(
      config.randomnessAuthority.equals(randomness.publicKey),
      'Randomness keypair does not match the configured authority',
    );
    assert.ok(config.buybackWallet.equals(buyback.publicKey), 'Buyback keypair does not match config');
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
    const gate = await program.account.liquidityGate.fetch(gateAddress);
    assert.equal(gate.verified, true, 'Meteora liquidity gate is not verified');
    assert.ok(!gate.pool.equals(PublicKey.default), 'Meteora liquidity pool is missing');
    if (mode === 'standby') assert.equal(config.paused, true, 'Standby host refuses an active protocol');

    const response = await fetch(`${supabaseUrl}/rest/v1/mine_rounds?select=round_id&limit=1`, {
      headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
    });
    assert.ok(response.ok, `Supabase service-role check failed (${response.status})`);
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
    });
    const specs = liveWorkerSpecs({
      programId: programIdText,
      randomnessWalletPath,
      buybackWalletPath,
      dataDir,
      randomnessMode: validatedRandomnessMode,
    });

    const startWorker = (spec) => {
      if (stopping) return;
      const status = state.workers.get(spec.name);
      const startedAt = Date.now();
      const child = spawn(process.execPath, [fileURLToPath(new URL(spec.script, import.meta.url))], {
        env: { ...commonEnv, ...spec.env, ANCHOR_WALLET: spec.walletPath },
        stdio: 'inherit',
      });
      children.set(spec.name, child);
      status.running = true;
      console.log(JSON.stringify({ event: 'worker-started', worker: spec.name, pid: child.pid }));
      child.once('exit', (code, signal) => {
        children.delete(spec.name);
        status.running = false;
        if (stopping) return;
        const healthyRun = Date.now() - startedAt >= 60_000;
        status.restarts = healthyRun ? 1 : status.restarts + 1;
        const delay = Math.min(60_000, 1_000 * (2 ** Math.min(status.restarts, 6)));
        console.error(JSON.stringify({
          event: 'worker-exited', worker: spec.name, code, signal, restartInMs: delay,
        }));
        schedule(() => startWorker(spec), delay);
      });
    };

    const roundSpec = specs.find((spec) => spec.perRound);
    assert.ok(roundSpec, 'A per-round randomness keeper is required');
    const launchedRounds = new Set();
    const roundRestartAttempts = new Map();
    const roundInstance = (roundId) => `${roundSpec.name}:${roundId}`;
    const refreshRoundWorkerStatus = () => {
      const status = state.workers.get(roundSpec.name);
      status.running = [...children.keys()].some((name) => name.startsWith(`${roundSpec.name}:`));
    };
    const startRoundWorker = (roundId) => {
      const id = String(roundId);
      if (stopping || launchedRounds.has(id)) return;
      launchedRounds.add(id);
      const instance = roundInstance(id);
      const status = state.workers.get(roundSpec.name);
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
          stdio: 'inherit',
        },
      );
      children.set(instance, child);
      refreshRoundWorkerStatus();
      console.log(JSON.stringify({
        event: 'round-worker-started',
        worker: roundSpec.name,
        provider: validatedRandomnessMode,
        round: id,
        pid: child.pid,
      }));
      child.once('exit', (code, signal) => {
        children.delete(instance);
        refreshRoundWorkerStatus();
        if (stopping || code === 0) {
          roundRestartAttempts.delete(id);
          return;
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
    const scheduleRoundWorkers = () => {
      if (stopping) return;
      const roundIds = roundIdsToPrepare({
        now: Math.floor(Date.now() / 1_000),
        initializedAt: validatedRoundSchedule.initializedAt,
        roundDurationSeconds: validatedRoundSchedule.roundDurationSeconds,
      });
      for (const roundId of roundIds) startRoundWorker(roundId);

      // Completed identifiers no longer need memory once they are well behind
      // the active schedule. Running/retrying children retain their entries.
      const oldestRetained = (roundIds[0] ?? 0) - 2;
      for (const id of launchedRounds) {
        if (Number(id) < oldestRetained && !children.has(roundInstance(id))) {
          launchedRounds.delete(id);
          roundRestartAttempts.delete(id);
        }
      }
      schedule(scheduleRoundWorkers, 500);
    };
    scheduleRoundWorkers();
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
