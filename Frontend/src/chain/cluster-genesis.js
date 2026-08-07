import bs58 from 'bs58';

/** Canonical genesis hashes for Solana's public clusters. */
export const PUBLIC_CLUSTER_GENESIS_HASHES = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
});

const isCanonicalHash = (value) => {
  try {
    const text = String(value);
    const bytes = bs58.decode(text);
    return bytes.length === 32 && bs58.encode(bytes) === text;
  } catch {
    return false;
  }
};

/**
 * Prove that an honest RPC is serving the ledger selected by the frontend build.
 *
 * This is a configuration-integrity check, not a trustless RPC proof: a malicious or compromised
 * endpoint can lie about `getGenesisHash` and every later response. Production still needs a
 * trusted, restricted RPC provider and on-chain account/program validation.
 */
export function assertClusterGenesis({ cluster, actualGenesisHash, expectedLocalGenesisHash = '' }) {
  const actual = String(actualGenesisHash || '');
  if (!isCanonicalHash(actual)) throw new Error('Solana RPC returned an invalid genesis hash');

  const publicExpected = PUBLIC_CLUSTER_GENESIS_HASHES[cluster];
  if (publicExpected) {
    if (actual !== publicExpected) {
      throw new Error(`Solana RPC genesis does not match configured ${cluster}`);
    }
    return actual;
  }

  if (cluster !== 'localnet') throw new Error(`Unsupported Solana cluster: ${cluster}`);

  // Local validators create a new genesis hash, so there is no universal localnet constant. An
  // optional build-time pin gives exact local-ledger identity; without it, rejecting every public
  // cluster still prevents an honest public RPC from silently masquerading as localnet.
  const localExpected = String(expectedLocalGenesisHash || '');
  if (localExpected) {
    if (!isCanonicalHash(localExpected)) throw new Error('Configured localnet genesis hash is invalid');
    if (actual !== localExpected) throw new Error('Solana RPC genesis does not match configured localnet');
  } else if (Object.values(PUBLIC_CLUSTER_GENESIS_HASHES).includes(actual)) {
    throw new Error('Solana localnet frontend is connected to a public Solana cluster');
  }
  return actual;
}

/**
 * Create a one-request, success-only cache for immutable cluster identity.
 * Failed checks are deliberately not cached so a temporarily unavailable RPC can be retried.
 */
export function createClusterGenesisGuard({ cluster, fetchGenesisHash, expectedLocalGenesisHash = '' }) {
  if (typeof fetchGenesisHash !== 'function') throw new TypeError('fetchGenesisHash must be a function');
  let verified = null;
  let request = null;

  const verify = async ({ force = false } = {}) => {
    if (!force && verified) return verified;
    if (request) return request;
    request = Promise.resolve()
      .then(fetchGenesisHash)
      .then((actualGenesisHash) => {
        const genesisHash = assertClusterGenesis({ cluster, actualGenesisHash, expectedLocalGenesisHash });
        verified = Object.freeze({ cluster, genesisHash });
        return verified;
      })
      .finally(() => { request = null; });
    return request;
  };

  return Object.freeze({
    verify,
    current: () => verified,
    invalidate: () => { verified = null; },
  });
}
