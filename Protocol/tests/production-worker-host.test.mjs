import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  DEFAULT_NEXT_ROUND_PREBIND_GRACE_SECONDS,
  DEFAULT_PROGRAM_ID,
  DEFAULT_WORKER_SUCCESS_FRESHNESS_MS,
  WORKER_NAMES,
  assessRoundScheduleHealth,
  canonicalRoundDeadlines,
  childEnvironment,
  firstManagedRoundId,
  isSuccessfulWorkerOutcome,
  keypairFromBase64,
  liveWorkerSpecs,
  minimumWorkerHeartbeatTimeoutMs,
  observeWorkerSpecs,
  publicHealth,
  workerSuccessFreshnessMs,
  workerMode,
} from '../scripts/production-worker-host.mjs';

const encodedKeypair = (keypair) => Buffer.from(
  JSON.stringify(Array.from(keypair.secretKey)),
).toString('base64');

test('worker host accepts exact base64 JSON keypairs without exposing secret text', () => {
  const source = Keypair.generate();
  const parsed = keypairFromBase64(encodedKeypair(source), 'TEST_KEYPAIR');
  assert.equal(parsed.publicKey.toBase58(), source.publicKey.toBase58());
  assert.throws(() => keypairFromBase64(Buffer.from('[]').toString('base64'), 'TEST'), /64 bytes/);
  assert.throws(() => keypairFromBase64('not-json', 'TEST'), /JSON keypair array/);
});

test('standby is default and live is explicit', () => {
  assert.equal(workerMode({}), 'standby');
  assert.equal(workerMode({ MYNE_WORKER_MODE: 'OBSERVE' }), 'observe');
  assert.equal(workerMode({ MYNE_WORKER_MODE: 'LIVE' }), 'live');
  assert.throws(() => workerMode({ MYNE_WORKER_MODE: 'maybe' }), /standby, observe, or live/);
});

test('observe mode starts exactly one project-only indexer and no signer worker', () => {
  const specs = observeWorkerSpecs({
    programId: DEFAULT_PROGRAM_ID,
    randomnessWalletPath: '/tmp/randomness.json',
    randomnessMode: 'server',
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].name, 'round-indexer');
  assert.equal(specs[0].script, 'round-indexer.mjs');
  assert.equal(specs[0].walletPath, '/tmp/randomness.json');
  assert.equal(specs[0].env.ROUND_INDEXER_PROJECT_ONLY, '1');
  assert.equal(specs[0].env.ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE, '0');
  assert.equal(specs[0].env.MYNE_SERVER_RANDOMNESS_ACK, DEFAULT_PROGRAM_ID);
  assert.ok(!specs.some(({ name }) => [
    'round-lifecycle', 'buyback-keeper', 'round-keeper',
  ].includes(name)));
});

test('observe runtime requires pause and does not require or write a buyback signer', async () => {
  const source = await readFile(
    new URL('../scripts/production-worker-host.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /mode === 'standby' \|\| mode === 'observe'[\s\S]*refuses an active protocol/);
  assert.match(source, /env\.MYNE_WORKER_HOST_OBSERVE[\s\S]*authorize project-only observation/);
  assert.match(source, /const randomness = mode === 'observe'[\s\S]*\? Keypair\.generate\(\)/);
  assert.match(source, /const buyback = mode === 'observe'[\s\S]*\? null/);
  const observeBranch = source.slice(
    source.indexOf("} else if (mode === 'observe')"),
    source.indexOf("  } else {\n    assert.equal(\n      env.MYNE_WORKER_HOST_LIVE"),
  );
  assert.match(observeBranch, /observeWorkerSpecs/);
  assert.match(observeBranch, /writeWallet\(randomnessWalletPath, randomness\)/);
  assert.doesNotMatch(observeBranch, /writeWallet\([^\n]*buyback/);
  assert.doesNotMatch(observeBranch, /round-lifecycle-keeper|buyback-keeper|server-round-keeper/);
});

test('observe health requires a fresh successful projection tick', () => {
  const workers = new Map(WORKER_NAMES.map((name) => [name, {
    running: name === 'round-indexer',
    restarts: 0,
    lastHeartbeatAt: 20_000,
    lastCompletedAt: 20_000,
    lastSuccessfulAt: null,
    lastOutcome: name === 'round-indexer' ? 'lease-not-held' : null,
    consecutiveErrors: 0,
  }]));
  const state = {
    mode: 'observe',
    ready: true,
    error: null,
    protocolPaused: true,
    checkedAt: 'now',
    revision: 'test',
    workers,
    roundProgress: new Map(),
    now: 25_000,
    heartbeatTimeoutMs: 60_000,
    projectionFreshnessMs: 30_000,
  };
  assert.equal(publicHealth(state).ok, false);
  workers.get('round-indexer').lastSuccessfulAt = 20_000;
  assert.equal(publicHealth(state).ok, true);
  state.now = 50_001;
  assert.equal(publicHealth(state).ok, false);
});

test('heartbeat timeout includes the longest configured tick or sleep budget', () => {
  assert.equal(minimumWorkerHeartbeatTimeoutMs({}), 150_000);
  assert.equal(minimumWorkerHeartbeatTimeoutMs({ BUYBACK_INTERVAL_MS: '600000' }), 630_000);
  assert.equal(minimumWorkerHeartbeatTimeoutMs({ LIFECYCLE_TICK_TIMEOUT_MS: '240000' }), 270_000);
  assert.throws(
    () => minimumWorkerHeartbeatTimeoutMs({ BUYBACK_TICK_TIMEOUT_MS: 'invalid' }),
    /non-negative integers/,
  );
});

test('worker success freshness follows cadence and rejects non-useful outcomes', () => {
  assert.deepEqual(workerSuccessFreshnessMs({}), DEFAULT_WORKER_SUCCESS_FRESHNESS_MS);
  assert.deepEqual(workerSuccessFreshnessMs({
    ROUND_INDEXER_INTERVAL_MS: '20000',
    LIFECYCLE_KEEPER_INTERVAL_MS: '15000',
    BUYBACK_INTERVAL_MS: '120000',
  }), {
    'round-indexer': 60_000,
    'round-lifecycle': 45_000,
    'buyback-keeper': 270_000,
  });
  assert.equal(isSuccessfulWorkerOutcome('ok', 'round-indexer'), true);
  assert.equal(isSuccessfulWorkerOutcome('round-indexer-lease-held-by-another-instance', 'round-indexer'), false);
  assert.equal(isSuccessfulWorkerOutcome('no-indexed-buyback-backlog', 'buyback-keeper'), true);
  assert.equal(isSuccessfulWorkerOutcome('no-indexed-buyback-backlog', 'round-indexer'), false);
  assert.equal(isSuccessfulWorkerOutcome('pending-swap-status-ambiguous-manual-reconciliation-required', 'buyback-keeper'), false);
  assert.equal(isSuccessfulWorkerOutcome(null, 'buyback-keeper'), false);
  assert.throws(
    () => workerSuccessFreshnessMs({ ROUND_INDEXER_SUCCESS_FRESHNESS_MS: '1000' }),
    /between the worker cadence and 1800000/,
  );
});

test('round supervision settles at betting close inside the five-second winner interval', () => {
  assert.equal(DEFAULT_NEXT_ROUND_PREBIND_GRACE_SECONDS, 15);
  assert.deepEqual(canonicalRoundDeadlines({
    roundId: 1,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
  }), {
    preparationStartsAt: 1_007,
    prebindAt: 1_022,
    prepareAt: 1_065,
    bettingEndsAt: 1_125,
    lockAt: 1_125,
    settlesAt: 1_125,
    settleAt: 1_130,
  });
  assert.throws(() => canonicalRoundDeadlines({
    roundId: 1,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    settlementLateSeconds: 6,
  }), /must equal the 5-second result window/);
});

test('round health treats the inter-round gap as the settlement deadline window', () => {
  const base = {
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    rows: [
      { roundId: 0, prepared: true, entropyLocked: false, funded: true, settled: false },
      { roundId: 1, prepared: true, entropyLocked: false, funded: false, settled: false },
    ],
  };
  const revealing = assessRoundScheduleHealth({ ...base, now: 1_061 });
  const round = revealing.entries.find(({ roundId }) => roundId === 0);
  assert.equal(round.lockAt, 1_060);
  assert.equal(round.settleAt, 1_065);
  assert.equal(round.condition, 'prepared');
  assert.equal(revealing.ok, true);

  const rolled = assessRoundScheduleHealth({ ...base, now: 1_065 });
  assert.equal(
    rolled.entries.find(({ roundId }) => roundId === 0).condition,
    'funded-settlement-late',
  );
  assert.ok(rolled.errors.some((error) => /entropy lock missed 1065/.test(error)));
});

test('health fails before rollover when the next round is not prebound', () => {
  const base = {
    now: 1_023,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    rows: [{
      roundId: 0,
      prepared: true,
      entropyLocked: false,
      funded: true,
      settled: false,
    }],
  };
  const late = assessRoundScheduleHealth(base);
  assert.equal(late.currentRoundId, 0);
  assert.equal(late.nextRoundId, 1);
  assert.equal(late.nextRoundPrebound, false);
  assert.equal(late.nextRoundPrebindDeadline, 1_022);
  assert.equal(late.ok, false);
  assert.match(late.errors[0], /Next round 1 was not prebound/);

  const ready = assessRoundScheduleHealth({
    ...base,
    rows: [...base.rows, {
      roundId: 1,
      prepared: true,
      entropyLocked: false,
      funded: false,
      settled: false,
    }],
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.nextRoundPrebound, true);
});

test('health fails when any previous funded round misses settlement', () => {
  const health = assessRoundScheduleHealth({
    now: 1_071,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    rows: [
      { roundId: 0, prepared: true, entropyLocked: true, funded: true, settled: false },
      { roundId: 1, prepared: true, entropyLocked: false, funded: false, settled: false },
    ],
  });
  assert.equal(health.ok, false);
  assert.equal(health.entries.find(({ roundId }) => roundId === 0).condition, 'funded-settlement-late');
  assert.ok(health.errors.some((error) => /Funded round 0 settlement missed/.test(error)));
});

test('a canonically closed historical PDA is not confused with missed current preparation', () => {
  const health = assessRoundScheduleHealth({
    now: 2_001,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    lookbackRounds: 8,
    rows: [
      { roundId: 15, prepared: true, entropyLocked: false, funded: false, settled: false },
      { roundId: 16, prepared: true, entropyLocked: false, funded: false, settled: false },
    ],
  });
  assert.equal(health.currentRoundId, 15);
  assert.equal(health.ok, true);
  assert.equal(health.entries.find(({ roundId }) => roundId === 14).condition, 'not-due');
});

test('an elevated managed floor treats paused schedule gaps as intentional', () => {
  const waiting = assessRoundScheduleHealth({
    now: 1_120,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    minimumManagedRoundId: 3,
    rows: [],
  });
  assert.equal(waiting.currentRoundId, 1);
  assert.equal(waiting.nextRoundId, 3);
  assert.deepEqual(waiting.entries, []);
  assert.equal(waiting.ok, true);

  const activated = assessRoundScheduleHealth({
    now: 1_132,
    initializedAt: 1_000,
    roundDurationSeconds: 65,
    minimumManagedRoundId: 3,
    rows: [{
      roundId: 3,
      prepared: true,
      entropyLocked: false,
      funded: false,
      settled: false,
    }],
  });
  assert.equal(activated.currentRoundId, 2);
  assert.equal(activated.nextRoundId, 3);
  assert.equal(activated.nextRoundPrebound, true);
  assert.equal(activated.ok, true);
});

test('live health stays failed until the selected resume round is on-chain prebound', () => {
  const workers = new Map(WORKER_NAMES.map((name) => [name, {
    running: true,
    restarts: 0,
    lastHeartbeatAt: 10_000,
    lastCompletedAt: 10_000,
    lastSuccessfulAt: 10_000,
    lastOutcome: 'ok',
    consecutiveErrors: 0,
  }]));
  const state = {
    mode: 'live',
    ready: true,
    error: null,
    protocolPaused: false,
    checkedAt: 'now',
    revision: 'test',
    workers,
    roundProgress: new Map(),
    roundHealth: { ok: true },
    now: 20_000,
    heartbeatTimeoutMs: 60_000,
    minimumManagedRoundId: 44,
    resumeActivation: {
      roundId: 44,
      selectedAtChainTime: 1_000,
      prebound: false,
      preboundAtChainTime: null,
    },
  };
  const pending = publicHealth(state);
  assert.equal(pending.ok, false);
  assert.equal(pending.minimumManagedRoundId, 44);
  assert.equal(pending.resumeActivation.prebound, false);

  state.resumeActivation.prebound = true;
  state.resumeActivation.preboundAtChainTime = 1_010;
  state.roundProgress.set('43', {
    roundId: 43,
    consecutiveErrors: 99,
    deadlineViolation: 'prepare-late',
  });
  assert.equal(publicHealth(state).ok, true);
});

test('durable deadline incidents keep live health failed after worker recovery', () => {
  const workers = new Map(WORKER_NAMES.map((name) => [name, {
    running: true,
    restarts: 0,
    lastHeartbeatAt: 20_000,
    lastCompletedAt: 20_000,
    lastSuccessfulAt: 20_000,
    lastOutcome: 'ok',
    consecutiveErrors: 0,
  }]));
  const state = {
    mode: 'live',
    ready: true,
    error: null,
    protocolPaused: true,
    checkedAt: 'now',
    revision: 'test',
    workers,
    roundProgress: new Map([['44', {
      roundId: 44,
      consecutiveErrors: 0,
      deadlineViolation: null,
      lastOutcome: 'completed',
    }]]),
    roundDeadlineIncidents: [{
      id: `${DEFAULT_PROGRAM_ID}:44:settlement-deadline-missed:10000`,
      programId: DEFAULT_PROGRAM_ID,
      roundId: 44,
      stage: 'settlement-deadline-missed',
      firstObservedAt: 10_000,
      lastObservedAt: 10_000,
      occurrences: 1,
      outcome: 'confirmed late',
      clearedAt: null,
    }],
    now: 25_000,
    heartbeatTimeoutMs: 60_000,
  };
  const health = publicHealth(state);
  assert.equal(health.ok, false);
  assert.equal(health.roundDeadlineIncidents.length, 1);
  assert.equal(health.roundDeadlineIncidents[0].roundId, 44);

  state.roundDeadlineIncidents = [];
  assert.equal(publicHealth(state).ok, true);
  assert.deepEqual(publicHealth({ ...state, mode: 'observe' }).roundDeadlineIncidents, []);
});

test('live health fails closed when an essential settlement/index worker is down', () => {
  const workers = new Map(WORKER_NAMES.map((name) => [name, {
    running: true,
    restarts: 0,
    lastHeartbeatAt: 10_000,
    lastCompletedAt: 10_000,
    lastSuccessfulAt: 10_000,
    lastOutcome: 'ok',
  }]));
  const state = {
    mode: 'live',
    ready: true,
    error: null,
    checkedAt: 'now',
    revision: 'test',
    workers,
    now: 20_000,
    heartbeatTimeoutMs: 60_000,
    protocolPaused: true,
  };
  assert.equal(publicHealth(state).ok, true);
  assert.equal(publicHealth(state).workers['round-indexer'].heartbeatFresh, true);
  workers.get('round-indexer').lastHeartbeatAt = -50_000;
  assert.equal(publicHealth(state).ok, false);
  assert.equal(publicHealth(state).workers['round-indexer'].heartbeatFresh, false);
  workers.get('round-indexer').lastHeartbeatAt = 10_000;
  workers.get('round-indexer').running = false;
  assert.equal(publicHealth(state).ok, false);
  workers.get('round-indexer').running = true;
  workers.get('round-lifecycle').running = false;
  assert.equal(publicHealth(state).ok, false);
  workers.get('round-lifecycle').running = true;
  workers.get('buyback-keeper').running = false;
  const buybackDown = publicHealth(state);
  assert.equal(buybackDown.ok, true);
  assert.equal(buybackDown.degraded, true);
  assert.deepEqual(buybackDown.degradedWorkers, ['buyback-keeper']);
  assert.equal(buybackDown.workers['buyback-keeper'].auxiliary, true);
  workers.get('buyback-keeper').running = true;
  workers.get('round-indexer').consecutiveErrors = 3;
  assert.equal(publicHealth(state).ok, false);
  workers.get('round-indexer').consecutiveErrors = 0;
  state.roundProgress = new Map([['7', {
    roundId: 7,
    consecutiveErrors: 0,
    deadlineViolation: 'settlement-deadline-missed',
  }]]);
  assert.equal(publicHealth(state).ok, false);
  assert.equal(publicHealth({ ...state, mode: 'standby' }).ok, true);
});

test('live health requires core success while reporting buyback as an isolated degradation', () => {
  const workers = new Map(WORKER_NAMES.map((name) => [name, {
    running: true,
    restarts: 0,
    lastHeartbeatAt: 20_000,
    lastCompletedAt: 20_000,
    lastSuccessfulAt: 20_000,
    lastOutcome: 'ok',
    consecutiveErrors: 0,
  }]));
  const state = {
    mode: 'live',
    ready: true,
    error: null,
    checkedAt: 'now',
    revision: 'test',
    workers,
    now: 25_000,
    heartbeatTimeoutMs: 180_000,
    protocolPaused: true,
  };
  assert.equal(publicHealth(state).ok, true);

  const indexer = workers.get('round-indexer');
  indexer.lastCompletedAt = 24_000;
  indexer.lastSuccessfulAt = null;
  indexer.lastOutcome = 'round-indexer-lease-held-by-another-instance';
  const leaseHeld = publicHealth(state);
  assert.equal(leaseHeld.ok, false);
  assert.equal(leaseHeld.workers['round-indexer'].completionFresh, true);
  assert.equal(leaseHeld.workers['round-indexer'].successFresh, false);

  indexer.lastSuccessfulAt = 20_000;
  indexer.lastOutcome = 'ok';
  const buyback = workers.get('buyback-keeper');
  buyback.lastCompletedAt = 24_000;
  buyback.lastSuccessfulAt = null;
  buyback.lastOutcome = 'no-indexed-buyback-backlog';
  const degradedBuyback = publicHealth(state);
  assert.equal(degradedBuyback.ok, true);
  assert.equal(degradedBuyback.degraded, true);
  assert.deepEqual(degradedBuyback.degradedWorkers, ['buyback-keeper']);
  assert.equal(degradedBuyback.workers['buyback-keeper'].successFresh, false);
  assert.equal(degradedBuyback.workers['buyback-keeper'].critical, false);
  assert.equal(degradedBuyback.workers['buyback-keeper'].auxiliary, true);

  buyback.lastSuccessfulAt = 20_000;
  buyback.lastOutcome = 'ok';
  state.now = 50_001;
  const staleIndexer = publicHealth(state);
  assert.equal(staleIndexer.ok, false);
  assert.equal(staleIndexer.degraded, false);
  assert.equal(staleIndexer.workers['round-indexer'].successFresh, false);
  assert.equal(staleIndexer.workers['buyback-keeper'].successFresh, true);
});

test('worker restarts discard a prior instance success before health can recover', async () => {
  const source = await readFile(
    new URL('../scripts/production-worker-host.mjs', import.meta.url),
    'utf8',
  );
  const observerStart = source.slice(
    source.indexOf('const startObserver = () =>'),
    source.indexOf('const superviseObserver = () =>'),
  );
  const liveStart = source.slice(
    source.indexOf('const startWorker = (spec) =>'),
    source.indexOf('const watchdogIntervalMs'),
  );
  assert.match(observerStart, /status\.lastSuccessfulAt = null/);
  assert.match(liveStart, /status\.lastSuccessfulAt = null/);
  assert.match(source, /isSuccessfulWorkerOutcome\(message\.outcome, (?:observeSpec|spec)\.name\)[\s\S]*status\.lastSuccessfulAt = status\.lastHeartbeatAt/);
});

test('worker restarts retain replica-scoped lease holders', async () => {
  const [host, indexer, buyback] = await Promise.all([
    readFile(new URL('../scripts/production-worker-host.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/buyback-keeper.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(host, /ROUND_INDEXER_LEASE_HOLDER:[\s\S]*RAILWAY_DEPLOYMENT_ID[\s\S]*RAILWAY_REPLICA_ID/);
  assert.match(host, /BUYBACK_LEASE_HOLDER:[\s\S]*RAILWAY_DEPLOYMENT_ID[\s\S]*RAILWAY_REPLICA_ID/);
  assert.match(indexer, /process\.env\.ROUND_INDEXER_LEASE_HOLDER[\s\S]*\|\| randomUUID\(\)/);
  assert.match(buyback, /process\.env\.BUYBACK_LEASE_HOLDER[\s\S]*\|\| randomUUID\(\)/);
});

test('worker host receives local IPC heartbeats and restarts stale children', async () => {
  const host = await readFile(
    new URL('../scripts/production-worker-host.mjs', import.meta.url),
    'utf8',
  );
  assert.match(host, /stdio: \['inherit', 'inherit', 'inherit', 'ipc'\]/);
  assert.match(host, /recordWorkerHeartbeat\(status, message, \{ expectedWorker: spec\.name \}\)/);
  assert.match(host, /event: 'worker-heartbeat-stale'/);
  assert.match(host, /child\.kill\('SIGTERM'\)/);
  assert.match(host, /child\.kill\('SIGKILL'\)/);
  assert.match(host, /WORKER_HEARTBEAT_TIMEOUT_MS must be between 60000 and 900000/);
});

test('worker host requires projection and Auto-reinvest schema capabilities', async () => {
  const [source, projectionMigration, capabilityMigration] = await Promise.all([
    readFile(new URL('../scripts/production-worker-host.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/20260808134500_round_projection_completeness.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/20260808140500_auto_reinvest_worker_capability.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /mine_worker_schema_capabilities/);
  assert.match(source, /release=in\.\(round-projection-v2,auto-reinvest-v1\)/);
  assert.match(source, /20260808140500_auto_reinvest_worker_capability\.sql/);
  assert.match(projectionMigration, /round-projection-v2/);
  assert.match(capabilityMigration, /auto-reinvest-v1/);
  assert.match(capabilityMigration, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(capabilityMigration, /grant select[\s\S]*to service_role/);
});

test('transaction workers receive wallet paths but never encoded signer secrets', () => {
  const env = childEnvironment({
    SAFE_PUBLIC_VALUE: 'kept',
    MYNE_RANDOMNESS_KEYPAIR_B64: 'private-randomness',
    MYNE_BUYBACK_KEYPAIR_B64: 'private-buyback',
  }, { ANCHOR_WALLET: '/tmp/randomness.json' });
  assert.equal(env.SAFE_PUBLIC_VALUE, 'kept');
  assert.equal(env.ANCHOR_WALLET, '/tmp/randomness.json');
  assert.equal(env.MYNE_RANDOMNESS_KEYPAIR_B64, undefined);
  assert.equal(env.MYNE_BUYBACK_KEYPAIR_B64, undefined);
});

test('live supervisor defines every required worker with separated wallets', () => {
  const specs = liveWorkerSpecs({
    programId: DEFAULT_PROGRAM_ID,
    randomnessWalletPath: '/tmp/randomness.json',
    buybackWalletPath: '/tmp/buyback.json',
    dataDir: '/data',
  });
  assert.deepEqual(specs.map((spec) => spec.name), WORKER_NAMES);
  assert.equal(specs.find((spec) => spec.name === 'buyback-keeper').walletPath, '/tmp/buyback.json');
  assert.equal(specs.find((spec) => spec.name === 'buyback-keeper').env.DRY_RUN, '0');
  assert.equal(specs.find((spec) => spec.name === 'buyback-keeper').env.FAIL_FAST, '0');
  assert.equal(specs.find((spec) => spec.name === 'buyback-keeper').env.BUYBACK_STATE_PATH, '/data/buyback-state.json');
  assert.equal(specs.find((spec) => spec.name === 'round-indexer').env.ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE, '1');
  const roundKeeper = specs.find((spec) => spec.name === 'round-keeper');
  assert.equal(roundKeeper.script, 'switchboard-round-keeper.mjs');
  assert.equal(roundKeeper.perRound, true);
  for (const spec of specs.filter((entry) => entry.name !== 'buyback-keeper')) {
    assert.equal(spec.walletPath, '/tmp/randomness.json');
  }
  for (const spec of specs) {
    assert.equal(spec.env.MYNE_SERVER_RANDOMNESS_ACK, undefined);
  }
});

test('server mode selects the durable commit-reveal keeper without removing Switchboard support', () => {
  const specs = liveWorkerSpecs({
    programId: DEFAULT_PROGRAM_ID,
    randomnessWalletPath: '/tmp/randomness.json',
    buybackWalletPath: '/tmp/buyback.json',
    dataDir: '/data',
    randomnessMode: 'server',
  });
  const keeper = specs.find((spec) => spec.name === 'round-keeper');
  assert.equal(keeper.script, 'server-round-keeper.mjs');
  assert.equal(keeper.env.SERVER_RANDOMNESS_KEEPER_LIVE, DEFAULT_PROGRAM_ID);
  assert.equal(keeper.env.SERVER_RANDOMNESS_STATE_DIR, '/data/server-randomness');
  assert.equal(keeper.perRound, true);
  for (const name of ['round-indexer', 'round-lifecycle', 'buyback-keeper']) {
    assert.equal(
      specs.find((spec) => spec.name === name).env.MYNE_SERVER_RANDOMNESS_ACK,
      DEFAULT_PROGRAM_ID,
    );
  }
  assert.throws(() => liveWorkerSpecs({
    programId: DEFAULT_PROGRAM_ID,
    randomnessWalletPath: '/tmp/randomness.json',
    buybackWalletPath: '/tmp/buyback.json',
    dataDir: '/data',
    randomnessMode: 'unknown',
  }), /switchboard or server/);
});

test('server cutover refuses to manage intentionally skipped earlier round ids', () => {
  assert.equal(firstManagedRoundId({}, 'switchboard'), 0);
  assert.equal(firstManagedRoundId({ MYNE_FIRST_SERVER_ROUND_ID: '342' }, 'server'), 342);
  assert.throws(() => firstManagedRoundId({}, 'server'), /MYNE_FIRST_SERVER_ROUND_ID is required/);
  assert.throws(
    () => firstManagedRoundId({ MYNE_FIRST_SERVER_ROUND_ID: '-1' }, 'server'),
    /unsigned integer/,
  );
});

test('round workers overlap by explicit id instead of waiting for the prior reveal process', async () => {
  const source = await readFile(
    new URL('../scripts/production-worker-host.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /roundIdsToPrepare\(\{/);
  assert.match(source, /MYNE_ROUND_ID: id/);
  assert.match(source, /stdio: \['inherit', 'inherit', 'inherit', 'ipc'\]/);
  assert.match(source, /message\?\.roundId/);
  assert.match(source, /nextRoundPrebound/);
  assert.match(source, /event: 'round-worker-deadline-missed'/);
  assert.match(source, /event: 'round-worker-heartbeat-stale'/);
  assert.match(source, /confirmedChainTime/);
  assert.match(source, /firstSafeResumeRoundId/);
  assert.match(source, /event: 'round-resume-activation-selected'/);
  assert.match(source, /event: 'round-resume-activation-prebound'/);
  assert.match(source, /reason: 'missing-current-on-live-host'/);
  assert.match(source, /entry\.role === 'current'[\s\S]*entry\.prepared === false/);
  assert.match(source, /numericRoundId < minimumManagedRoundId/);
  assert.match(source, /const instance = roundInstance\(id\)/);
  assert.match(source, /schedule\(\(\) => void scheduleRoundWorkers\(\), 500\)/);
  assert.match(source, /if \(roundId >= minimumManagedRoundId\) startRoundWorker\(roundId\)/);
  assert.match(source, /code === ROUND_KEEPER_DEFERRED_EXIT_CODE[\s\S]*launchedRounds\.delete\(id\)/);
  assert.match(source, /code === ROUND_KEEPER_MISSED_EXIT_CODE[\s\S]*state\.ready = false/);
  assert.doesNotMatch(source, /spec\.oneShot && code === 0[\s\S]*5_000/);
});

test('production Switchboard workers never depend on a host Solana CLI config', async () => {
  const [roundKeeper, lifecycle, explicitEnv] = await Promise.all([
    readFile(new URL('../scripts/switchboard-round-keeper.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/round-lifecycle-keeper.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/production-switchboard-env.mjs', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(roundKeeper, /AnchorUtils\.loadEnv/);
  assert.doesNotMatch(lifecycle, /AnchorUtils\.loadEnv/);
  assert.match(explicitEnv, /ANCHOR_PROVIDER_URL/);
  assert.match(explicitEnv, /ANCHOR_WALLET/);
  assert.match(explicitEnv, /loadProgramFromConnection/);
});

test('live host durably latches every deadline stage and clears only by paused exact acknowledgement', async () => {
  const source = await readFile(
    new URL('../scripts/production-worker-host.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /createRoundDeadlineIncidentLatch\(\{ dataDir, programId: programIdText \}\)/);
  assert.match(source, /ROUND_HEALTH_CONDITION_STAGE\[entry\.condition\][\s\S]*recordDurableRoundIncident/);
  assert.match(source, /ROUND_DEADLINE_VIOLATION_STAGES\.has\(message\.stage\)[\s\S]*recordDurableRoundIncident/);
  assert.match(source, /MYNE_CLEAR_ROUND_DEADLINE_INCIDENT/);
  assert.match(
    source,
    /A round deadline incident can be cleared only while the protocol is paused/,
  );
  assert.match(source, /roundDeadlineIncidentLatch\.clearExact\(incidentClearAcknowledgement\)/);
  assert.match(source, /await roundDeadlineIncidentLatch\.flush\(\)/);
  assert.match(source, /applyDurableIncidentState\(\)/);
});
