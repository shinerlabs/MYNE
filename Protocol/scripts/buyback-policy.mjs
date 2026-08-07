import assert from 'node:assert/strict';

export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const METEORA_DLMM_LABEL = 'Meteora DLMM';
export const METEORA_DAMM_V2_LABEL = 'Meteora DAMM v2';
export const METEORA_DLMM_PROGRAM_TEXT = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const METEORA_DAMM_V2_PROGRAM_TEXT = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const OFFICIAL_JUPITER_HOSTS = Object.freeze(['lite-api.jup.ag', 'api.jup.ag']);

export function validateJupiterEndpoint(value, { expectedPath, allowCustom = false } = {}) {
  const endpoint = new URL(value);
  assert.equal(endpoint.protocol, 'https:', 'Jupiter endpoint must use HTTPS');
  assert.equal(endpoint.username, '', 'Jupiter endpoint must not contain URL credentials');
  assert.equal(endpoint.password, '', 'Jupiter endpoint must not contain URL credentials');
  assert.equal(endpoint.search, '', 'Configure a Jupiter endpoint without query parameters');
  assert.equal(endpoint.hash, '', 'Configure a Jupiter endpoint without a fragment');
  assert.equal(endpoint.pathname, expectedPath, `Jupiter endpoint path must be ${expectedPath}`);
  assert.ok(
    OFFICIAL_JUPITER_HOSTS.includes(endpoint.hostname) || allowCustom,
    `Unapproved Jupiter endpoint host: ${endpoint.hostname}`,
  );
  return endpoint.toString();
}

export function calculateSpend({ balanceLamports, reserveLamports, maxSpendLamports, minimumLamports }) {
  const spendLamports = Math.min(maxSpendLamports, Math.max(0, balanceLamports - reserveLamports));
  return {
    spendLamports,
    skipped: spendLamports < minimumLamports,
    reason: spendLamports < minimumLamports ? 'below-minimum' : null,
  };
}

export function meteoraRouteForProgram(poolProgram) {
  const value = String(poolProgram);
  if (value === METEORA_DLMM_PROGRAM_TEXT) {
    return Object.freeze({ program: value, label: METEORA_DLMM_LABEL, kind: 'dlmm' });
  }
  if (value === METEORA_DAMM_V2_PROGRAM_TEXT) {
    return Object.freeze({ program: value, label: METEORA_DAMM_V2_LABEL, kind: 'damm-v2' });
  }
  throw new Error(`Unsupported registered Meteora program: ${value}`);
}

export function validateDirectMeteoraQuote(quote, {
  poolAddress,
  inputLamports,
  outputMint,
  expectedAmmLabel,
  maxPriceImpactPct = 5,
}) {
  assert.equal(quote.inputMint, NATIVE_SOL_MINT, 'Quote input is not native SOL');
  assert.equal(quote.outputMint, outputMint, 'Quote output is not MYNE');
  assert.equal(String(quote.inAmount), String(inputLamports), 'Quote input amount changed unexpectedly');
  assert.ok(BigInt(quote.outAmount || 0) > 0n, 'Quote returned zero MYNE');
  assert.ok(Array.isArray(quote.routePlan) && quote.routePlan.length === 1, 'Buyback must use one direct route');
  const step = quote.routePlan[0];
  assert.equal(step.swapInfo?.ammKey, poolAddress, 'Quote does not use the registered Meteora pool');
  assert.ok(
    expectedAmmLabel === METEORA_DLMM_LABEL || expectedAmmLabel === METEORA_DAMM_V2_LABEL,
    'Expected Meteora route label is unsupported',
  );
  assert.equal(step.swapInfo?.label, expectedAmmLabel, `Quote route is not ${expectedAmmLabel}`);
  const priceImpactPct = Number(quote.priceImpactPct);
  assert.ok(Number.isFinite(priceImpactPct) && priceImpactPct <= maxPriceImpactPct, `Price impact exceeds ${maxPriceImpactPct}%`);
  return {
    inputLamports: String(inputLamports),
    outputBaseUnits: String(quote.outAmount),
    priceImpactPct: String(quote.priceImpactPct),
  };
}
