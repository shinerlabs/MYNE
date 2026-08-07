import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSpend,
  METEORA_DAMM_V2_LABEL,
  METEORA_DAMM_V2_PROGRAM_TEXT,
  METEORA_DLMM_LABEL,
  METEORA_DLMM_PROGRAM_TEXT,
  NATIVE_SOL_MINT,
  meteoraRouteForProgram,
  validateJupiterEndpoint,
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

test('buyback accepts only exact HTTPS Jupiter endpoints unless explicitly overridden', () => {
  assert.equal(
    validateJupiterEndpoint('https://lite-api.jup.ag/swap/v1/quote', {
      expectedPath: '/swap/v1/quote',
    }),
    'https://lite-api.jup.ag/swap/v1/quote',
  );
  assert.throws(() => validateJupiterEndpoint('http://lite-api.jup.ag/swap/v1/quote', {
    expectedPath: '/swap/v1/quote',
  }), /HTTPS/);
  assert.throws(() => validateJupiterEndpoint('https://evil.example/swap/v1/quote', {
    expectedPath: '/swap/v1/quote',
  }), /Unapproved/);
  assert.throws(() => validateJupiterEndpoint('https://lite-api.jup.ag/not-quote', {
    expectedPath: '/swap/v1/quote',
  }), /path/);
  assert.equal(
    validateJupiterEndpoint('https://reviewed.example/swap/v1/quote', {
      expectedPath: '/swap/v1/quote', allowCustom: true,
    }),
    'https://reviewed.example/swap/v1/quote',
  );
});

test('buyback accepts only a direct route through the registered Meteora pool', () => {
  const checked = validateDirectMeteoraQuote({
    inputMint: NATIVE_SOL_MINT,
    outputMint: 'Myne111111111111111111111111111111111111111',
    inAmount: '10000000',
    outAmount: '123456789',
    priceImpactPct: '0.12',
    routePlan: [{ swapInfo: { ammKey: poolAddress, label: METEORA_DLMM_LABEL } }],
  }, {
    poolAddress,
    inputLamports: 10000000,
    outputMint: 'Myne111111111111111111111111111111111111111',
    expectedAmmLabel: METEORA_DLMM_LABEL,
  });
  assert.equal(checked.outputBaseUnits, '123456789');
  assert.throws(() => validateDirectMeteoraQuote({
    inputMint: NATIVE_SOL_MINT,
    outputMint: 'Myne111111111111111111111111111111111111111',
    inAmount: '10000000',
    outAmount: '123456789',
    routePlan: [{ swapInfo: { ammKey: 'OtherPool', label: METEORA_DLMM_LABEL } }],
  }, {
    poolAddress,
    inputLamports: 10000000,
    outputMint: 'Myne111111111111111111111111111111111111111',
    expectedAmmLabel: METEORA_DLMM_LABEL,
  }));
});

test('buyback binds Jupiter routing to the exact registered Meteora program', () => {
  assert.deepEqual(meteoraRouteForProgram(METEORA_DLMM_PROGRAM_TEXT), {
    program: METEORA_DLMM_PROGRAM_TEXT,
    label: METEORA_DLMM_LABEL,
    kind: 'dlmm',
  });
  assert.deepEqual(meteoraRouteForProgram(METEORA_DAMM_V2_PROGRAM_TEXT), {
    program: METEORA_DAMM_V2_PROGRAM_TEXT,
    label: METEORA_DAMM_V2_LABEL,
    kind: 'damm-v2',
  });
  assert.throws(() => meteoraRouteForProgram('11111111111111111111111111111111'), /Unsupported/);

  const quote = {
    inputMint: NATIVE_SOL_MINT,
    outputMint: 'Myne111111111111111111111111111111111111111',
    inAmount: '10000000',
    outAmount: '123456789',
    priceImpactPct: '0.12',
    routePlan: [{ swapInfo: { ammKey: poolAddress, label: METEORA_DAMM_V2_LABEL } }],
  };
  assert.doesNotThrow(() => validateDirectMeteoraQuote(quote, {
    poolAddress,
    inputLamports: 10000000,
    outputMint: quote.outputMint,
    expectedAmmLabel: METEORA_DAMM_V2_LABEL,
  }));
  assert.throws(() => validateDirectMeteoraQuote(quote, {
    poolAddress,
    inputLamports: 10000000,
    outputMint: quote.outputMint,
    expectedAmmLabel: METEORA_DLMM_LABEL,
  }), /Meteora DLMM/);
});
