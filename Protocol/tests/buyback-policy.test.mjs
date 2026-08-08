import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import web3 from '@solana/web3.js';
import {
  calculateSpend,
  isCompleteBuybackExecution,
  METEORA_DAMM_V2_LABEL,
  METEORA_DAMM_V2_PROGRAM_TEXT,
  METEORA_DLMM_LABEL,
  METEORA_DLMM_PROGRAM_TEXT,
  NATIVE_SOL_MINT,
  meteoraRouteForProgram,
  pendingSwapIsProvablyExpired,
  pinLatestBlockhashContext,
  purchasedTokenBaseUnits,
  refreshUnsignedV0TransactionBlockhash,
  retryTransientRpcContext,
  savedTransactionSendOptions,
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

test('Jupiter V0 blockhash refresh accepts only an unsigned sole-payer message', () => {
  const payer = 'payer';
  const untouchedLookup = { accountKey: 'lookup' };
  const transaction = {
    message: {
      staticAccountKeys: [{ toBase58: () => payer }],
      header: { numRequiredSignatures: 1 },
      addressTableLookups: [untouchedLookup],
      recentBlockhash: 'stale-blockhash',
    },
    signatures: [new Uint8Array(64)],
  };
  const originalMessage = transaction.message;
  refreshUnsignedV0TransactionBlockhash(transaction, {
    expectedPayer: payer,
    blockhash: 'fresh-blockhash',
  });
  assert.equal(transaction.message, originalMessage, 'the V0 message must not be recompiled');
  assert.equal(transaction.message.recentBlockhash, 'fresh-blockhash');
  assert.equal(transaction.message.addressTableLookups[0], untouchedLookup);

  transaction.signatures[0][0] = 1;
  assert.throws(() => refreshUnsignedV0TransactionBlockhash(transaction, {
    expectedPayer: payer,
    blockhash: 'another-blockhash',
  }), /must be unsigned/);
  transaction.signatures[0][0] = 0;
  assert.throws(() => refreshUnsignedV0TransactionBlockhash(transaction, {
    expectedPayer: 'other-payer',
    blockhash: 'another-blockhash',
  }), /fee payer changed/);
});

test('buyback pins refreshed blockhash reads to the exact producing RPC context', () => {
  const pinned = pinLatestBlockhashContext({
    context: { slot: 456_789 },
    value: {
      blockhash: 'fresh-blockhash',
      lastValidBlockHeight: 457_000,
    },
  }, { commitment: 'confirmed' });
  assert.deepEqual(pinned, {
    latestBlockhash: {
      blockhash: 'fresh-blockhash',
      lastValidBlockHeight: 457_000,
    },
    contextConfig: {
      commitment: 'confirmed',
      minContextSlot: 456_789,
    },
  });
  assert.throws(() => pinLatestBlockhashContext({
    context: {},
    value: { blockhash: 'fresh-blockhash', lastValidBlockHeight: 457_000 },
  }, { commitment: 'confirmed' }), /context slot is invalid/);
  assert.throws(() => pinLatestBlockhashContext({
    context: { slot: 456_789 },
    value: { blockhash: '', lastValidBlockHeight: 457_000 },
  }, { commitment: 'confirmed' }), /blockhash is invalid/);
  assert.throws(() => pinLatestBlockhashContext({
    context: { slot: 456_789 },
    value: { blockhash: 'fresh-blockhash', lastValidBlockHeight: 1.5 },
  }, { commitment: 'confirmed' }), /last-valid height is invalid/);
});

test('saved transaction context remains backward-compatible with older journals', () => {
  assert.deepEqual(savedTransactionSendOptions(undefined, { commitment: 'confirmed' }), {
    maxRetries: 3,
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  assert.deepEqual(savedTransactionSendOptions(456_789, { commitment: 'confirmed' }), {
    maxRetries: 3,
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    minContextSlot: 456_789,
  });
  assert.throws(
    () => savedTransactionSendOptions(-1, { commitment: 'confirmed' }),
    /minimum context slot is invalid/,
  );
});

test('saved transaction recovery accepts a signed legacy journal without rewriting it', () => {
  const payer = web3.Keypair.generate();
  const recentBlockhash = web3.Keypair.generate().publicKey.toBase58();
  const legacy = new web3.Transaction({ feePayer: payer.publicKey, recentBlockhash }).add(
    web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: web3.Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  legacy.sign(payer);
  const raw = legacy.serialize();
  const recovered = web3.VersionedTransaction.deserialize(raw);
  assert.equal(recovered.version, 'legacy');
  assert.equal(recovered.message.recentBlockhash, recentBlockhash);
  assert.deepEqual(Buffer.from(recovered.serialize()), raw);
});

test('pinned RPC calls retry only transient context propagation failures', async () => {
  let reads = 0;
  const waits = [];
  const result = await retryTransientRpcContext(async () => {
    reads += 1;
    if (reads < 3) throw new Error('Blockhash not found');
    return { value: 5_000 };
  }, {
    attempts: 4,
    wait: async (attempt) => waits.push(attempt),
  });
  assert.deepEqual(result, { value: 5_000 });
  assert.equal(reads, 3);
  assert.deepEqual(waits, [1, 2]);

  let contextReads = 0;
  const contextResult = await retryTransientRpcContext(async () => {
    contextReads += 1;
    if (contextReads < 2) throw new Error('Minimum context slot has not been reached');
    return { value: 'ready' };
  });
  assert.deepEqual(contextResult, { value: 'ready' });
  assert.equal(contextReads, 2);

  let nonBlockhashReads = 0;
  await assert.rejects(
    retryTransientRpcContext(async () => {
      nonBlockhashReads += 1;
      throw new Error('RPC authorization failed');
    }),
    /authorization failed/,
  );
  assert.equal(nonBlockhashReads, 1);
});

test('an absent pending swap is abandoned only after its exact blockhash expires', () => {
  assert.equal(pendingSwapIsProvablyExpired({
    signatureStatus: null,
    outputIncreased: false,
    currentBlockHeight: 101,
    lastValidBlockHeight: 100,
  }), true);
  assert.equal(pendingSwapIsProvablyExpired({
    signatureStatus: null,
    outputIncreased: false,
    currentBlockHeight: 100,
    lastValidBlockHeight: 100,
  }), false);
  assert.equal(pendingSwapIsProvablyExpired({
    signatureStatus: null,
    outputIncreased: false,
    blockhashValid: false,
  }), true);
  assert.equal(pendingSwapIsProvablyExpired({
    signatureStatus: { confirmationStatus: 'processed' },
    outputIncreased: false,
    currentBlockHeight: 101,
    lastValidBlockHeight: 100,
  }), false);
  assert.equal(pendingSwapIsProvablyExpired({
    signatureStatus: null,
    outputIncreased: true,
    currentBlockHeight: 101,
    lastValidBlockHeight: 100,
  }), false);
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
  const validation = source.indexOf('for (const instruction of decompiled.instructions)');
  const refresh = source.indexOf('refreshUnsignedV0TransactionBlockhash(transaction');
  const simulation = source.indexOf('provider.connection.simulateTransaction(transaction');
  assert.ok(validation >= 0 && validation < refresh && refresh < simulation);
  assert.match(source, /getLatestBlockhashAndContext\(\{ commitment \}\)/);
  assert.match(source, /getAddressLookupTable\([\s\S]*contextConfig/);
  assert.match(source, /getBalance\([\s\S]*contextConfig/);
  assert.match(source, /simulateTransaction\(transaction, \{[\s\S]*\.\.\.contextConfig/);
  assert.match(source, /swapMinContextSlot: inspected\.minContextSlot/);
  assert.match(source, /sendSavedTransaction\(pending\.swapRaw, \{[\s\S]*minContextSlot: pending\.swapMinContextSlot/);
  assert.match(source, /lastValidBlockHeight: pending\.lastValidBlockHeight/);
  assert.match(source, /burnMinContextSlot: burn\.minContextSlot/);
  assert.match(source, /sendSavedTransaction\(pending\.burnRaw, \{[\s\S]*minContextSlot: pending\.burnMinContextSlot/);
  assert.match(source, /lastValidBlockHeight: pending\.burnLastValidBlockHeight/);
  assert.match(source, /VersionedTransaction\.deserialize\(raw\)/);
  assert.match(source, /blockhash: saved\.message\.recentBlockhash/);
  const burnBuilder = source.slice(
    source.indexOf('async function buildBurnAmountTransaction'),
    source.indexOf('async function waitForMyneBalance'),
  );
  assert.match(burnBuilder, /getLatestBlockhashAndContext\(\{ commitment \}\)/);
  assert.match(burnBuilder, /new VersionedTransaction\(/);
  assert.match(burnBuilder, /simulateTransaction\(simulationTransaction, \{[\s\S]*\.\.\.contextConfig[\s\S]*sigVerify: true/);
  assert.doesNotMatch(burnBuilder, /getLatestBlockhash\(/);
  assert.doesNotMatch(burnBuilder, /simulateTransaction\(simulationTransaction, \[payer\]\)/);
  const completion = source.slice(
    source.indexOf('async function markRoundBuybackComplete'),
    source.indexOf('function roundJournal'),
  );
  assert.match(completion, /getLatestBlockhashAndContext\(\{ commitment \}\)/);
  assert.match(completion, /new VersionedTransaction\(/);
  assert.match(completion, /simulateTransaction\(simulationTx, \{[\s\S]*\.\.\.contextConfig[\s\S]*sigVerify: true/);
  assert.match(completion, /lastValidBlockHeight: latestBlockhash\.lastValidBlockHeight/);
  assert.doesNotMatch(completion, /getLatestBlockhash\(/);
  assert.doesNotMatch(completion, /simulateTransaction\(simulationTx, \[payer\]\)/);
  const signing = source.indexOf('swap.sign([payer])');
  const pendingJournal = source.indexOf('journal.pending = {', signing);
  assert.ok(source.indexOf('await inspectSwapTransaction(swap') < signing);
  assert.ok(signing >= 0 && signing < pendingJournal);
});
