import assert from 'node:assert/strict';

export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const METEORA_DLMM_LABEL = 'Meteora DLMM';
export const METEORA_DAMM_V2_LABEL = 'Meteora DAMM v2';
export const METEORA_DLMM_PROGRAM_TEXT = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const METEORA_DAMM_V2_PROGRAM_TEXT = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const OFFICIAL_JUPITER_HOSTS = Object.freeze(['lite-api.jup.ag', 'api.jup.ag']);
export const JUPITER_PRIORITY_LEVELS = Object.freeze(['medium', 'high', 'veryHigh']);

export function validateJupiterPriorityLevel(value = 'medium') {
  const priorityLevel = String(value || 'medium');
  assert.ok(
    JUPITER_PRIORITY_LEVELS.includes(priorityLevel),
    `JUPITER_PRIORITY_LEVEL must be one of ${JUPITER_PRIORITY_LEVELS.join(', ')}`,
  );
  return priorityLevel;
}

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

export function isCompleteBuybackExecution(entry) {
  return Boolean(
    entry
      && BigInt(String(entry.spendLamports || 0)) > 0n
      && BigInt(String(entry.expectedOutputBaseUnits || 0)) > 0n
      && BigInt(String(entry.burnedBaseUnits || 0)) > 0n
      && typeof entry.swapSignature === 'string'
      && entry.swapSignature.length > 0
      && typeof entry.burnSignature === 'string'
      && entry.burnSignature.length > 0,
  );
}

export function purchasedTokenBaseUnits({ preTokenBalances = [], postTokenBalances = [], mint, owner }) {
  const total = (balances) => balances
    .filter((entry) => entry?.mint === mint && entry?.owner === owner)
    .reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount?.amount || 0), 0n);
  const before = total(preTokenBalances);
  const after = total(postTokenBalances);
  assert.ok(after > before, 'Confirmed swap transaction has no positive MYNE balance delta');
  return after - before;
}

/**
 * Select the oldest indexed allocation that can still require a buyback.
 * The database is only a bounded work queue; the keeper must fetch the Round
 * PDA and treat its on-chain buybackCompleted flag as the no-double-spend
 * authority before quoting or signing anything.
 */
export function selectIndexedBuybackRound(rows, { cursorRound, currentRound }) {
  const cursor = BigInt(String(cursorRound));
  const current = BigInt(String(currentRound));
  assert.ok(cursor >= 0n && current >= 0n, 'Buyback round bounds must be non-negative');
  if (cursor > current) return null;
  return (rows || [])
    .filter((row) => {
      const roundId = BigInt(String(row.round_id));
      return roundId >= cursor
        && roundId <= current
        && row.resolved === true
        && row.buyback_completed !== true
        && BigInt(String(row.total_wager_wei || 0)) > 0n;
    })
    .sort((left, right) => {
      const leftId = BigInt(String(left.round_id));
      const rightId = BigInt(String(right.round_id));
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    })[0] || null;
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
