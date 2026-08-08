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

/**
 * Refresh only the recent blockhash of Jupiter's unsigned V0 message. The
 * keeper validates programs separately before calling this helper, and signs
 * and journals the resulting exact message afterward.
 */
export function refreshUnsignedV0TransactionBlockhash(transaction, {
  expectedPayer,
  blockhash,
}) {
  assert.equal(
    transaction?.message?.staticAccountKeys?.[0]?.toBase58?.(),
    expectedPayer,
    'Jupiter transaction fee payer changed unexpectedly',
  );
  assert.equal(
    transaction.message.header?.numRequiredSignatures,
    1,
    'Jupiter transaction requires an unexpected signer',
  );
  assert.equal(transaction.signatures?.length, 1, 'Jupiter transaction signature layout changed');
  assert.equal(transaction.signatures[0]?.length, 64, 'Jupiter transaction signature must be 64 bytes');
  assert.ok(
    Array.from(transaction.signatures[0] || []).every((byte) => byte === 0),
    'Jupiter transaction must be unsigned before its blockhash is refreshed',
  );
  assert.ok(typeof blockhash === 'string' && blockhash.length > 0, 'Fresh blockhash is required');
  transaction.message.recentBlockhash = blockhash;
  return transaction;
}

/**
 * Bind every RPC read used to inspect a refreshed transaction to the slot
 * that supplied its blockhash. This prevents a load-balanced RPC endpoint
 * from serving the blockhash from one backend and simulating it on an older
 * backend that has not observed that slot yet.
 */
export function pinLatestBlockhashContext(response, { commitment }) {
  const minContextSlot = response?.context?.slot;
  const blockhash = response?.value?.blockhash;
  const lastValidBlockHeight = response?.value?.lastValidBlockHeight;
  assert.ok(
    Number.isSafeInteger(minContextSlot) && minContextSlot >= 0,
    'Latest blockhash context slot is invalid',
  );
  assert.ok(typeof blockhash === 'string' && blockhash.length > 0, 'Latest blockhash is invalid');
  assert.ok(
    Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight >= 0,
    'Latest blockhash last-valid height is invalid',
  );
  assert.ok(typeof commitment === 'string' && commitment.length > 0, 'RPC commitment is required');
  return {
    latestBlockhash: { blockhash, lastValidBlockHeight },
    contextConfig: { commitment, minContextSlot },
  };
}

/**
 * Older durable journals predate context pinning. Omit minContextSlot for
 * those exact saved transactions while validating and preserving it for new
 * entries, so recovery never needs to rebuild or resign journaled bytes.
 */
export function savedTransactionSendOptions(minContextSlot, { commitment }) {
  assert.ok(typeof commitment === 'string' && commitment.length > 0, 'RPC commitment is required');
  assert.ok(
    minContextSlot == null || (Number.isSafeInteger(minContextSlot) && minContextSlot >= 0),
    'Saved transaction minimum context slot is invalid',
  );
  return {
    maxRetries: 3,
    skipPreflight: false,
    preflightCommitment: commitment,
    ...(minContextSlot == null ? {} : { minContextSlot }),
  };
}

/**
 * web3.js 1.x does not expose getFeeForMessage's RPC minContextSlot even
 * though the RPC method supports it. Retry only the transient blockhash
 * propagation failure after a context-pinned simulation; all other errors
 * remain immediate and fail closed.
 */
export async function retryTransientBlockhashRead(read, {
  attempts = 4,
  wait = async () => {},
} = {}) {
  assert.equal(typeof read, 'function', 'Blockhash read callback is required');
  assert.ok(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 10, 'Retry attempts are invalid');
  assert.equal(typeof wait, 'function', 'Blockhash retry wait callback is required');
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (!/blockhash/i.test(error instanceof Error ? error.message : String(error))) throw error;
      lastError = error;
      if (attempt < attempts) await wait(attempt);
    }
  }
  throw lastError;
}

/**
 * An unsigned/signed recent-blockhash transaction can no longer land once the
 * blockhash has expired. When its signature is absent and the keeper's token
 * balance never increased, abandoning that exact journal entry cannot double
 * spend. Legacy journals may not contain a last-valid height, so callers can
 * supply the RPC's direct blockhash-validity result instead.
 */
export function pendingSwapIsProvablyExpired({
  signatureStatus,
  outputIncreased,
  currentBlockHeight = null,
  lastValidBlockHeight = null,
  blockhashValid = null,
} = {}) {
  if (signatureStatus || outputIncreased) return false;
  if (Number.isSafeInteger(currentBlockHeight)
      && Number.isSafeInteger(lastValidBlockHeight)) {
    return currentBlockHeight > lastValidBlockHeight;
  }
  return blockhashValid === false;
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
