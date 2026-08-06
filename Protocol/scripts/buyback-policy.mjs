import assert from 'node:assert/strict';

export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const METEORA_DLMM_LABEL = 'Meteora DLMM';

export function calculateSpend({ balanceLamports, reserveLamports, maxSpendLamports, minimumLamports }) {
  const spendLamports = Math.min(maxSpendLamports, Math.max(0, balanceLamports - reserveLamports));
  return {
    spendLamports,
    skipped: spendLamports < minimumLamports,
    reason: spendLamports < minimumLamports ? 'below-minimum' : null,
  };
}

export function validateDirectMeteoraQuote(quote, { poolAddress, inputLamports, outputMint, maxPriceImpactPct = 5 }) {
  assert.equal(quote.inputMint, NATIVE_SOL_MINT, 'Quote input is not native SOL');
  assert.equal(quote.outputMint, outputMint, 'Quote output is not MYNE');
  assert.equal(String(quote.inAmount), String(inputLamports), 'Quote input amount changed unexpectedly');
  assert.ok(BigInt(quote.outAmount || 0) > 0n, 'Quote returned zero MYNE');
  assert.ok(Array.isArray(quote.routePlan) && quote.routePlan.length === 1, 'Buyback must use one direct route');
  const step = quote.routePlan[0];
  assert.equal(step.swapInfo?.ammKey, poolAddress, 'Quote does not use the registered Meteora pool');
  assert.equal(step.swapInfo?.label, METEORA_DLMM_LABEL, 'Quote route is not Meteora DLMM');
  const priceImpactPct = Number(quote.priceImpactPct);
  assert.ok(Number.isFinite(priceImpactPct) && priceImpactPct <= maxPriceImpactPct, `Price impact exceeds ${maxPriceImpactPct}%`);
  return {
    inputLamports: String(inputLamports),
    outputBaseUnits: String(quote.outAmount),
    priceImpactPct: String(quote.priceImpactPct),
  };
}
