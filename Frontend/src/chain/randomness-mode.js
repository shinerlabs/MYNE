import { PublicKey } from '@solana/web3.js';

import { PROGRAMS } from '../app-config.js';

/**
 * Server commit/reveal rounds reuse the existing u64 commit-slot field. The
 * high bit is a permanent per-round mode tag; all one bits means a commitment
 * is bound but the post-betting entropy slot has not yet been locked.
 */
export const SERVER_RANDOMNESS_SLOT_FLAG = 1n << 63n;
export const SERVER_RANDOMNESS_SLOT_MASK = SERVER_RANDOMNESS_SLOT_FLAG - 1n;
export const SERVER_RANDOMNESS_PENDING = (1n << 64n) - 1n;

const keyText = (value) => value?.toBase58?.() ?? String(value ?? '');

/** The server mode marker is the deployed MYNE program id itself. */
export function isServerRandomnessProgram(provider, programId = PROGRAMS.protocol) {
  const providerKey = keyText(provider);
  const protocolKey = keyText(programId);
  return Boolean(providerKey && protocolKey && providerKey === protocolKey);
}

export function isServerRandomnessSlot(value) {
  const encoded = BigInt(value?.toString?.() ?? value ?? 0);
  return (encoded & SERVER_RANDOMNESS_SLOT_FLAG) !== 0n;
}

/** Return the real Solana slot, never the high-bit tagged storage value. */
export function decodeServerRandomnessSlot(value) {
  const encoded = BigInt(value?.toString?.() ?? value ?? 0);
  if (encoded === SERVER_RANDOMNESS_PENDING || !isServerRandomnessSlot(encoded)) return null;
  const slot = encoded & SERVER_RANDOMNESS_SLOT_MASK;
  return slot > 0n ? slot : null;
}

/** Stable UI/client classification that remains valid after provider changes. */
export function describeRandomnessRound({ commitSlot = 0n, resolved = false } = {}) {
  const encodedSlot = BigInt(commitSlot?.toString?.() ?? commitSlot ?? 0);
  if (encodedSlot === SERVER_RANDOMNESS_PENDING) {
    return {
      mode: 'server', state: 'commitment-bound', encodedSlot, slot: null,
    };
  }
  if (isServerRandomnessSlot(encodedSlot)) {
    return {
      mode: 'server', state: resolved ? 'settled' : 'entropy-locked', encodedSlot,
      slot: decodeServerRandomnessSlot(encodedSlot),
    };
  }
  return {
    mode: 'switchboard',
    state: encodedSlot === 0n ? 'uncommitted' : (resolved ? 'settled' : 'committed'),
    encodedSlot,
    slot: encodedSlot > 0n ? encodedSlot : null,
  };
}

/**
 * In server mode Round.randomness_account contains commitment bytes, not an
 * executable/account address. Render them as hex and never construct an
 * Explorer link from them.
 */
export function commitmentHexFromAccount(value) {
  if (!value) return null;
  try {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof PublicKey
        ? value.toBytes()
        : new PublicKey(value).toBytes();
    if (bytes.length !== 32) return null;
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export function normalizeProofHex(value) {
  if (value instanceof Uint8Array || Array.isArray(value)) {
    const bytes = Uint8Array.from(value);
    if (bytes.length !== 32) return null;
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const hex = String(value ?? '').trim().replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}
