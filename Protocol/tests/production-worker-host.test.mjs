import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  DEFAULT_PROGRAM_ID,
  WORKER_NAMES,
  childEnvironment,
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
  for (const spec of specs.filter((entry) => entry.name !== 'buyback-keeper')) {
    assert.equal(spec.walletPath, '/tmp/randomness.json');
  }
});
