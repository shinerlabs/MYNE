const text = (value) => new TextEncoder().encode(value);

const hexByte = (value) => Number.parseInt(value, 16);

/** Normalize the IDL byte array and the indexer's decimal/hex encodings to 32 exact bytes. */
export function randomnessBytes(value) {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) throw new Error('Randomness must contain exactly 32 bytes');
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    if (value.length !== 32 || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error('Randomness must contain exactly 32 bytes');
    }
    return Uint8Array.from(value);
  }

  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Randomness is missing');
  if (raw.includes(',')) return randomnessBytes(raw.split(',').map((part) => Number(part.trim())));

  const hex = raw.replace(/^0x/i, '');
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    return Uint8Array.from(hex.match(/.{2}/g).map(hexByte));
  }
  if (!/^\d+$/.test(raw)) throw new Error('Randomness is not a supported byte, hex, or decimal value');

  let number = BigInt(raw);
  const bytes = new Uint8Array(32);
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(number & 0xffn);
    number >>= 8n;
  }
  if (number !== 0n) throw new Error('Randomness exceeds 32 bytes');
  return bytes;
}

export const randomnessHex = (value) => [...randomnessBytes(value)]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const randomnessEqual = (left, right) => randomnessHex(left) === randomnessHex(right);

const roundIdBytes = (roundId) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(roundId), true);
  return bytes;
};

const hash = async (domain, roundId, randomness) => {
  const parts = [text('MYNE_V1'), text(domain), roundIdBytes(roundId), randomnessBytes(randomness)];
  const input = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { input.set(part, offset); offset += part.length; }
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
};

const sample = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);

/** Mirror Protocol::domain_hash and settle_round_core without trusting the indexer or UI. */
export async function deriveRoundProof(roundId, randomness) {
  const [tileHash, modeHash, soloHash, motherlodeHash] = await Promise.all([
    hash('tile', roundId, randomness),
    hash('mode', roundId, randomness),
    hash('solo', roundId, randomness),
    hash('motherlode', roundId, randomness),
  ]);
  const motherlodeSample = sample(motherlodeHash);
  return {
    winningSquare: Number(sample(tileHash) % 25n),
    soloMode: sample(modeHash) % 2n === 0n,
    soloSample: sample(soloHash),
    motherlodeHit: motherlodeSample % 650n === 0n,
    randomnessHex: randomnessHex(randomness),
  };
}

