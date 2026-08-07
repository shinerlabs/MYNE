import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertClusterGenesis, createClusterGenesisGuard, PUBLIC_CLUSTER_GENESIS_HASHES,
} from '../src/chain/cluster-genesis.js';

const LOCAL_GENESIS = '11111111111111111111111111111111';
const OTHER_LOCAL_GENESIS = 'SysvarRent111111111111111111111111111111111';

test('public Solana clusters accept only their canonical genesis hash', () => {
  for (const [cluster, genesisHash] of Object.entries(PUBLIC_CLUSTER_GENESIS_HASHES)) {
    assert.equal(assertClusterGenesis({ cluster, actualGenesisHash: genesisHash }), genesisHash);
  }
  assert.throws(() => assertClusterGenesis({
    cluster: 'mainnet-beta',
    actualGenesisHash: PUBLIC_CLUSTER_GENESIS_HASHES.devnet,
  }), /does not match configured mainnet-beta/);
  assert.throws(() => assertClusterGenesis({
    cluster: 'devnet',
    actualGenesisHash: PUBLIC_CLUSTER_GENESIS_HASHES['mainnet-beta'],
  }), /does not match configured devnet/);
});

test('localnet rejects public ledgers and supports an optional exact genesis pin', () => {
  assert.equal(assertClusterGenesis({ cluster: 'localnet', actualGenesisHash: LOCAL_GENESIS }), LOCAL_GENESIS);
  assert.throws(() => assertClusterGenesis({
    cluster: 'localnet',
    actualGenesisHash: PUBLIC_CLUSTER_GENESIS_HASHES.devnet,
  }), /connected to a public Solana cluster/);
  assert.equal(assertClusterGenesis({
    cluster: 'localnet',
    actualGenesisHash: LOCAL_GENESIS,
    expectedLocalGenesisHash: LOCAL_GENESIS,
  }), LOCAL_GENESIS);
  assert.throws(() => assertClusterGenesis({
    cluster: 'localnet',
    actualGenesisHash: LOCAL_GENESIS,
    expectedLocalGenesisHash: OTHER_LOCAL_GENESIS,
  }), /does not match configured localnet/);
});

test('cluster genesis checks fail closed on malformed hashes and unsupported clusters', () => {
  assert.throws(() => assertClusterGenesis({ cluster: 'devnet', actualGenesisHash: 'not-base58' }), /invalid genesis hash/);
  assert.throws(() => assertClusterGenesis({ cluster: 'unknown', actualGenesisHash: LOCAL_GENESIS }), /Unsupported Solana cluster/);
  assert.throws(() => assertClusterGenesis({
    cluster: 'localnet', actualGenesisHash: LOCAL_GENESIS, expectedLocalGenesisHash: 'bad-pin',
  }), /localnet genesis hash is invalid/);
});

test('cluster genesis guard coalesces requests, caches only success, and can force recheck', async () => {
  let calls = 0;
  let fail = true;
  const guard = createClusterGenesisGuard({
    cluster: 'devnet',
    fetchGenesisHash: async () => {
      calls += 1;
      if (fail) throw new Error('RPC unavailable');
      return PUBLIC_CLUSTER_GENESIS_HASHES.devnet;
    },
  });

  await assert.rejects(guard.verify(), /RPC unavailable/);
  assert.equal(guard.current(), null);
  fail = false;
  const [first, second] = await Promise.all([guard.verify(), guard.verify()]);
  assert.strictEqual(first, second);
  assert.equal(calls, 2);
  assert.deepEqual(guard.current(), { cluster: 'devnet', genesisHash: PUBLIC_CLUSTER_GENESIS_HASHES.devnet });
  await guard.verify();
  assert.equal(calls, 2);
  await guard.verify({ force: true });
  assert.equal(calls, 3);
});
