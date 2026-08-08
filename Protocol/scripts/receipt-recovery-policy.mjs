import assert from 'node:assert/strict';

export const BET_RECEIPT_ACCOUNT_SIZE = 468;
export const BET_RECEIPT_ROUND_ID_OFFSET = 9;

const U64_MAX = (1n << 64n) - 1n;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function asU64(value, label) {
  const parsed = BigInt(value?.toString?.() ?? value);
  assert.ok(parsed >= 0n && parsed <= U64_MAX, `${label} must fit in an unsigned u64`);
  return parsed;
}

function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return `${'1'.repeat(leadingZeroes)}${encoded}`;
}

function u64LittleEndian(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(asU64(value, 'roundId'));
  return bytes;
}

/**
 * Return the only program-account scan shape allowed for lifecycle recovery.
 * The authoritative live count is checked before the RPC request so an
 * unexpectedly large round fails closed rather than becoming a broad scan.
 */
export function exactReceiptRecoveryScanOptions({
  roundId,
  expectedLiveCount,
  maxAccounts,
}) {
  const expected = asU64(expectedLiveCount, 'expectedLiveCount');
  const maximum = asU64(maxAccounts, 'maxAccounts');
  assert.ok(maximum > 0n, 'maxAccounts must be positive');
  assert.ok(
    expected <= maximum,
    `Receipt recovery count ${expected} exceeds the configured maximum ${maximum}`,
  );
  return {
    commitment: 'confirmed',
    filters: [
      { dataSize: BET_RECEIPT_ACCOUNT_SIZE },
      {
        memcmp: {
          offset: BET_RECEIPT_ROUND_ID_OFFSET,
          bytes: base58Encode(u64LittleEndian(roundId)),
        },
      },
    ],
  };
}

const publicKeyString = (value, label) => {
  assert.equal(typeof value?.toBase58, 'function', `${label} must be a public key`);
  return value.toBase58();
};

/**
 * Decode and validate every result of an exact receipt recovery scan.
 * The callback keeps this policy module independent of Anchor/Web3 while the
 * production caller supplies the reviewed IDL decoder and canonical PDA rule.
 */
export function validateRecoveredReceiptAccounts({
  accounts,
  expectedLiveCount,
  roundId,
  programId,
  decodeReceipt,
  deriveReceiptPda,
}) {
  const expected = asU64(expectedLiveCount, 'expectedLiveCount');
  assert.ok(expected <= BigInt(Number.MAX_SAFE_INTEGER), 'Receipt recovery count is not safely representable');
  assert.ok(Array.isArray(accounts), 'Receipt recovery response must be an array');
  assert.equal(
    accounts.length,
    Number(expected),
    'Confirmed receipt recovery cardinality does not match the authoritative live count',
  );
  assert.equal(typeof decodeReceipt, 'function', 'decodeReceipt is required');
  assert.equal(typeof deriveReceiptPda, 'function', 'deriveReceiptPda is required');

  const expectedRoundId = asU64(roundId, 'roundId');
  const expectedOwner = publicKeyString(programId, 'programId');
  const seen = new Set();
  return accounts.map(({ pubkey, account }) => {
    const receipt = publicKeyString(pubkey, 'receipt address');
    assert.ok(!seen.has(receipt), `Duplicate recovered receipt ${receipt}`);
    seen.add(receipt);
    assert.equal(publicKeyString(account?.owner, 'receipt owner'), expectedOwner, 'Recovered receipt has wrong owner');
    assert.equal(account?.executable, false, 'Recovered receipt account must not be executable');
    assert.ok(account?.data instanceof Uint8Array, 'Recovered receipt data must be bytes');
    assert.equal(
      account.data.byteLength,
      BET_RECEIPT_ACCOUNT_SIZE,
      'Recovered receipt has the wrong account size',
    );

    const state = decodeReceipt(Buffer.from(account.data));
    assert.equal(
      asU64(state?.roundId, 'receipt.roundId'),
      expectedRoundId,
      'Recovered receipt belongs to a different round',
    );
    const bettor = publicKeyString(state?.authority, 'receipt authority');
    const [canonical, canonicalBump] = deriveReceiptPda(state.authority, state.nonce);
    assert.equal(
      publicKeyString(canonical, 'canonical receipt address'),
      receipt,
      'Recovered receipt is not the canonical PDA',
    );
    assert.equal(Number(state.bump), Number(canonicalBump), 'Recovered receipt stores the wrong PDA bump');
    return { receipt, bettor };
  });
}
