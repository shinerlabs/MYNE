import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';

const SERVER_COMMIT_DOMAIN = Buffer.from('MYNE_SERVER_COMMIT_V1');

const revealPath = (stateDir, roundId) => {
  const root = String(stateDir || '').replace(/\/$/, '');
  assert.ok(root.startsWith('/') && root !== '', 'Server randomness state directory must be absolute');
  assert.notEqual(root, '/', 'Server randomness state directory cannot be filesystem root');
  const id = BigInt(roundId);
  assert.ok(id >= 0n, 'Round id must be non-negative');
  return `${root}/round-${id}.json`;
};

const parseRevealState = (text, roundId) => {
  const state = JSON.parse(text);
  assert.equal(state.version, 1, 'Unsupported server randomness state version');
  assert.equal(state.roundId, BigInt(roundId).toString(), 'Server randomness state round mismatch');
  assert.match(state.revealHex, /^[0-9a-f]{64}$/i, 'Server randomness reveal must be 32 bytes');
  return Buffer.from(state.revealHex, 'hex');
};

/**
 * Persist the preimage before its commitment can reach Solana.
 *
 * `wx` makes concurrent/restarted workers converge on one reveal. `sync()`
 * closes the crash window in which a commitment could land but its preimage
 * exists only in process memory.
 */
export async function loadOrCreateServerReveal({ stateDir, roundId }) {
  const path = revealPath(stateDir, roundId);
  await mkdir(String(stateDir), { recursive: true, mode: 0o700 });
  try {
    return parseRevealState(await readFile(path, 'utf8'), roundId);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const reveal = randomBytes(32);
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({
      version: 1,
      roundId: BigInt(roundId).toString(),
      revealHex: reveal.toString('hex'),
    })}\n`, 'utf8');
    await handle.sync();
    return reveal;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return parseRevealState(await readFile(path, 'utf8'), roundId);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Matches the program's domain-separated `server_randomness_commitment`. */
export function serverRandomnessCommitment({ programId, mint, roundId, reveal }) {
  const preimage = Buffer.from(reveal);
  assert.equal(preimage.length, 32, 'Server randomness reveal must be 32 bytes');
  const round = Buffer.alloc(8);
  round.writeBigUInt64LE(BigInt(roundId));
  return createHash('sha256')
    .update(SERVER_COMMIT_DOMAIN)
    .update(programId.toBuffer())
    .update(mint.toBuffer())
    .update(round)
    .update(preimage)
    .digest();
}

export const SERVER_RANDOMNESS_SLOT_FLAG = 1n << 63n;
export const SERVER_RANDOMNESS_PENDING = (1n << 64n) - 1n;
export const SERVER_RANDOMNESS_SLOT_MASK = SERVER_RANDOMNESS_SLOT_FLAG - 1n;

export function decodeServerEntropySlot(value) {
  const encoded = BigInt(value?.toString?.() ?? value);
  assert.notEqual(encoded, SERVER_RANDOMNESS_PENDING, 'Server entropy is not locked yet');
  assert.ok((encoded & SERVER_RANDOMNESS_SLOT_FLAG) !== 0n, 'Round is not in server randomness mode');
  const slot = encoded & SERVER_RANDOMNESS_SLOT_MASK;
  assert.ok(slot > 0n, 'Encoded server entropy slot is invalid');
  return slot;
}

/**
 * Mirrors the program's bounded SlotHashes scan and reports when deterministic
 * entropy is ready. Reading the sysvar directly lets the keeper settle in the
 * first eligible bank instead of waiting an arbitrary extra slot. A skipped
 * target remains safe: the first produced slot after it becomes eligible.
 */
export function serverEntropyAvailable(data, targetSlot) {
  const bytes = Buffer.from(data ?? []);
  const target = BigInt(targetSlot);
  assert.ok(target > 0n, 'Server entropy target must be positive');
  assert.ok(bytes.length >= 8, 'SlotHashes sysvar header is missing');
  const count = bytes.readBigUInt64LE(0);
  assert.ok(count <= 512n, 'SlotHashes sysvar entry count is invalid');
  const requiredLength = 8n + count * 40n;
  assert.ok(requiredLength <= BigInt(bytes.length), 'SlotHashes sysvar data is truncated');

  let oldest = null;
  let selected = null;
  for (let index = 0n; index < count; index += 1n) {
    const offset = Number(8n + index * 40n);
    const slot = bytes.readBigUInt64LE(offset);
    oldest = oldest === null || slot < oldest ? slot : oldest;
    if (slot >= target && (selected === null || slot < selected)) selected = slot;
  }
  assert.notEqual(oldest, null, 'SlotHashes sysvar contains no entries');
  assert.ok(target >= oldest, 'Server entropy target has aged out of SlotHashes');
  return selected !== null;
}
