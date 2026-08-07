/**
 * A receipt nonce is a PDA uniqueness component, not a source of winner randomness. Use the
 * browser CSPRNG anyway: Date.now()+Math.random() collides across tabs and is needlessly
 * predictable to a transaction observer.
 */
export function createReceiptNonce(cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.getRandomValues) throw new Error('Secure randomness is unavailable in this browser');
  const words = new Uint32Array(2);
  cryptoApi.getRandomValues(words);
  return (BigInt(words[0]) << 32n) | BigInt(words[1]);
}

