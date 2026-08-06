import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSpend,
  METEORA_DLMM_LABEL,
  NATIVE_SOL_MINT,
  validateDirectMeteoraQuote,
} from '../scripts/buyback-policy.mjs';

const poolAddress = 'Pool111111111111111111111111111111111111111';

test('buyback spend is capped and preserves the keeper reserve', () => {
  assert.deepEqual(calculateSpend({
    balanceLamports: 2_000_000_000,
    reserveLamports: 250_000_000,
    maxSpendLamports: 500_000_000,
    minimumLamports: 10_000_000,
  }), { spendLamports: 500_000_000, skipped: false, reason: null });
  assert.equal(calculateSpend({
    balanceLamports: 200_000_000,
    reserveLamports: 250_000_000,
    maxSpendLamports: 500_000_000,
    minimumLamports: 10_000_000,
  }).skipped, true);
});

test('buyback accepts only a direct route through the registered Meteora pool', () => {
  const checked = validateDirectMeteoraQuote({
    inputMint: NATIVE_SOL_MINT,
    outputMint: 'Myne111111111111111111111111111111111111111',
    inAmount: '10000000',
    outAmount: '123456789',
    priceImpactPct: '0.12',
    routePlan: [{ swapInfo: { ammKey: poolAddress, label: METEORA_DLMM_LABEL } }],
  }, { poolAddress, inputLamports: 10000000, outputMint: 'Myne111111111111111111111111111111111111111' });
  assert.equal(checked.outputBaseUnits, '123456789');
  assert.throws(() => validateDirectMeteoraQuote({
    inputMint: NATIVE_SOL_MINT,
    outputMint: 'Myne111111111111111111111111111111111111111',
    inAmount: '10000000',
    outAmount: '123456789',
    routePlan: [{ swapInfo: { ammKey: 'OtherPool', label: METEORA_DLMM_LABEL } }],
  }, { poolAddress, inputLamports: 10000000, outputMint: 'Myne111111111111111111111111111111111111111' }));
});
