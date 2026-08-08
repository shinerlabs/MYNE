import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BET_RECEIPT_ACCOUNT_SIZE,
  exactReceiptRecoveryScanOptions,
  validateRecoveredReceiptAccounts,
} from '../scripts/receipt-recovery-policy.mjs';

const key = (value) => ({ toBase58: () => value });
const programId = key('program');
const authority = key('bettor');
const canonical = key('receipt');
const receiptData = () => Buffer.alloc(BET_RECEIPT_ACCOUNT_SIZE);

function validate(accounts, overrides = {}) {
  return validateRecoveredReceiptAccounts({
    accounts,
    expectedLiveCount: overrides.expectedLiveCount ?? accounts.length,
    roundId: 42n,
    programId,
    decodeReceipt: overrides.decodeReceipt ?? (() => ({
      bump: 254,
      roundId: 42n,
      authority,
      nonce: 7n,
    })),
    deriveReceiptPda: overrides.deriveReceiptPda ?? (() => [canonical, 254]),
  });
}

const validAccount = () => ({
  pubkey: canonical,
  account: {
    owner: programId,
    executable: false,
    data: receiptData(),
  },
});

test('receipt recovery request is confirmed, exact-round filtered and bounded', () => {
  assert.deepEqual(
    exactReceiptRecoveryScanOptions({ roundId: 42n, expectedLiveCount: 3n, maxAccounts: 50 }),
    {
      commitment: 'confirmed',
      filters: [
        { dataSize: 468 },
        { memcmp: { offset: 9, bytes: '82TFauPiYEj' } },
      ],
    },
  );
  assert.throws(
    () => exactReceiptRecoveryScanOptions({ roundId: 42n, expectedLiveCount: 51, maxAccounts: 50 }),
    /exceeds the configured maximum/,
  );
});

test('receipt recovery validates exact cardinality, round, owner and canonical PDA', () => {
  assert.deepEqual(validate([validAccount()]), [{ receipt: 'receipt', bettor: 'bettor' }]);
  assert.throws(
    () => validate([], { expectedLiveCount: 1 }),
    /cardinality does not match/,
  );
  assert.throws(
    () => validate([validAccount()], {
      decodeReceipt: () => ({ bump: 254, roundId: 43n, authority, nonce: 7n }),
    }),
    /different round/,
  );
  assert.throws(
    () => validate([{ ...validAccount(), account: { ...validAccount().account, owner: key('other') } }]),
    /wrong owner/,
  );
  assert.throws(
    () => validate([validAccount()], { deriveReceiptPda: () => [key('other'), 254] }),
    /not the canonical PDA/,
  );
  assert.throws(
    () => validate([validAccount()], { deriveReceiptPda: () => [canonical, 253] }),
    /wrong PDA bump/,
  );
});

test('receipt recovery rejects duplicate addresses and malformed account data', () => {
  assert.throws(
    () => validate([validAccount(), validAccount()]),
    /Duplicate recovered receipt/,
  );
  assert.throws(
    () => validate([{
      ...validAccount(),
      account: { ...validAccount().account, data: Buffer.alloc(BET_RECEIPT_ACCOUNT_SIZE - 1) },
    }]),
    /wrong account size/,
  );
});
