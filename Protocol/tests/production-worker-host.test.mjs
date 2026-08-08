import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  DEFAULT_PROGRAM_ID,
  WORKER_NAMES,
  childEnvironment,
  firstManagedRoundId,
  keypairFromBase64,
  liveWorkerSpecs,
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
  assert.equal(workerMode({ MYNE_WORKER_MODE: 'LIVE' }), 'live');
  assert.throws(() => workerMode({ MYNE_WORKER_MODE: 'maybe' }), /standby or live/);
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
  assert.equal(specs.find((spec) => spec.name === 'buyback-keeper').env.BUYBACK_STATE_PATH, '/data/buyback-state.json');
  assert.equal(specs.find((spec) => spec.name === 'round-indexer').env.ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE, '1');
  const roundKeeper = specs.find((spec) => spec.name === 'round-keeper');
  assert.equal(roundKeeper.script, 'switchboard-round-keeper.mjs');
  assert.equal(roundKeeper.perRound, true);
  for (const spec of specs.filter((entry) => entry.name !== 'buyback-keeper')) {
    assert.equal(spec.walletPath, '/tmp/randomness.json');
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
