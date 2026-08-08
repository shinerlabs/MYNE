import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  calculateSpend,
  isCompleteBuybackExecution,
  METEORA_DAMM_V2_LABEL,
  METEORA_DAMM_V2_PROGRAM_TEXT,
  METEORA_DLMM_LABEL,
  METEORA_DLMM_PROGRAM_TEXT,
  NATIVE_SOL_MINT,
  meteoraRouteForProgram,
  purchasedTokenBaseUnits,
  selectIndexedBuybackRound,
  validateJupiterEndpoint,
  validateJupiterPriorityLevel,
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
  assert.deepEqual(calculateSpend({
    balanceLamports: 5_500_000,
    reserveLamports: 5_000_000,
    maxSpendLamports: 500_000,
    minimumLamports: 100_000,
  }), { spendLamports: 500_000, skipped: false, reason: null });
});

test('buyback uses only Jupiter-supported priority levels', () => {
  assert.equal(validateJupiterPriorityLevel(), 'medium');
  assert.equal(validateJupiterPriorityLevel('high'), 'high');
  assert.equal(validateJupiterPriorityLevel('veryHigh'), 'veryHigh');
  assert.throws(() => validateJupiterPriorityLevel('veryLow'), /must be one of/);
});

test('buyback journal refuses incomplete burn evidence and derives exact confirmed swap output', () => {
  assert.equal(isCompleteBuybackExecution({
    spendLamports: '1000000',
    expectedOutputBaseUnits: '2700000',
    burnedBaseUnits: '2699000',
    swapSignature: 'swap-signature',
    burnSignature: 'burn-signature',
  }), true);
  assert.equal(isCompleteBuybackExecution({
    spendLamports: '1000000',
    expectedOutputBaseUnits: '2700000',
    swapSignature: 'swap-signature',
    burnSignature: null,
  }), false);
  assert.equal(purchasedTokenBaseUnits({
    mint: 'MYNE',
    owner: 'keeper',
    preTokenBalances: [
      { mint: 'MYNE', owner: 'keeper', uiTokenAmount: { amount: '100' } },
      { mint: 'OTHER', owner: 'keeper', uiTokenAmount: { amount: '999' } },
    ],
    postTokenBalances: [
      { mint: 'MYNE', owner: 'keeper', uiTokenAmount: { amount: '275' } },
      { mint: 'OTHER', owner: 'keeper', uiTokenAmount: { amount: '1' } },
    ],
  }), 175n);
  assert.throws(() => purchasedTokenBaseUnits({
    mint: 'MYNE', owner: 'keeper', preTokenBalances: [], postTokenBalances: [],
  }), /no positive MYNE balance delta/);
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

test('buyback cursor gaps select the first real indexed unsettled allocation', () => {
  const selected = selectIndexedBuybackRound([
    { round_id: '299', resolved: true, buyback_completed: false, total_wager_wei: '100000000' },
    { round_id: '302', resolved: true, buyback_completed: false, total_wager_wei: '200000000' },
  ], { cursorRound: 0, currentRound: 310 });
  assert.equal(selected.round_id, '299');
});

test('buyback journal loss restarts at oldest indexed incomplete positive-volume round', () => {
  const selected = selectIndexedBuybackRound([
    { round_id: '314', resolved: true, buyback_completed: false, total_wager_wei: '50000000' },
    { round_id: '287', resolved: true, buyback_completed: false, total_wager_wei: '50000000' },
    { round_id: '299', resolved: true, buyback_completed: false, total_wager_wei: '50000000' },
  ], { cursorRound: 0, currentRound: 314 });
  assert.equal(selected.round_id, '287');
});

test('buyback indexed selection excludes future, empty, unresolved and indexed-complete rounds', () => {
  const selected = selectIndexedBuybackRound([
    { round_id: '286', resolved: true, buyback_completed: false, total_wager_wei: '50000000' },
    { round_id: '287', resolved: false, buyback_completed: false, total_wager_wei: '50000000' },
    { round_id: '288', resolved: true, buyback_completed: false, total_wager_wei: '0' },
    { round_id: '289', resolved: true, buyback_completed: true, total_wager_wei: '50000000' },
    { round_id: '290', resolved: true, buyback_completed: false, total_wager_wei: '50000000' },
    { round_id: '315', resolved: true, buyback_completed: false, total_wager_wei: '50000000' },
  ], { cursorRound: 287, currentRound: 314 });
  assert.equal(selected.round_id, '290');
});

test('buyback keeper re-checks the authoritative on-chain completion flag', async () => {
  const source = await readFile(new URL('../scripts/buyback-keeper.mjs', import.meta.url), 'utf8');
  assert.match(source, /indexedBuybackBacklog/);
  assert.match(source, /if \(roundState\.buybackCompleted\)/);
  assert.match(source, /round-buyback-completed-on-chain/);
  assert.match(source, /indexed-round-account-missing-reconcile-required/);
  assert.match(source, /repairIncompleteExecution/);
  assert.match(source, /pending-swap-output-awaiting-confirmed-token-state/);
  assert.match(source, /pending-burn-awaiting-confirmed-token-state/);
  assert.doesNotMatch(source, /dryRun \? currentRound : 0/);
});
