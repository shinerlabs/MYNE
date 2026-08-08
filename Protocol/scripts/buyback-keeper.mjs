/**
 * MYNE Meteora buyback + burn keeper.
 *
 * The on-chain program sends the 1% buyback allocation to config.buybackWallet.
 * This process spends only that wallet's SOL, routes directly through the
 * registered Meteora DLMM pool, and burns the MYNE received by the same wallet.
 *
 * Safe by default: BUYBACK_KEEPER_LIVE must equal the program id before any
 * transaction is sent. Use DRY_RUN=1 (the default) to quote without spending.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import anchor from '@anchor-lang/core';
import web3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import {
  calculateSpend,
  meteoraRouteForProgram,
  selectIndexedBuybackRound,
  validateJupiterPriorityLevel,
  validateJupiterEndpoint,
  validateDirectMeteoraQuote,
} from './buyback-policy.mjs';
import {
  requireMatchingSolanaNetwork,
} from './production-network-policy.mjs';

const { AnchorProvider, Program, setProvider } = anchor;
const {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  ComputeBudgetProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} = web3;
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createBurnCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} = splToken;

const PROGRAM_ID_TEXT = process.env.MYNE_PROGRAM_ID
  || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e';
const PROGRAM_ID = new PublicKey(PROGRAM_ID_TEXT);
const customJupiterAuthorized = process.env.ALLOW_CUSTOM_JUPITER_ENDPOINT === PROGRAM_ID_TEXT;
const JUPITER_QUOTE_URL = validateJupiterEndpoint(
  process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag/swap/v1/quote',
  { expectedPath: '/swap/v1/quote', allowCustom: customJupiterAuthorized },
);
const JUPITER_SWAP_URL = validateJupiterEndpoint(
  process.env.JUPITER_SWAP_URL || 'https://lite-api.jup.ag/swap/v1/swap',
  { expectedPath: '/swap/v1/swap', allowCustom: customJupiterAuthorized },
);
const JUPITER_AGGREGATOR_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
const commitment = 'confirmed';
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed keeper wallet is required (set ANCHOR_WALLET)');
const program = new Program(idl, provider);

const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [liquidityGate] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_gate')], PROGRAM_ID);
const lamports = (sol) => Math.max(0, Math.floor(Number(sol) * LAMPORTS_PER_SOL));
const envBool = (name, fallback) => process.env[name] == null ? fallback : process.env[name] === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const statePath = process.env.BUYBACK_STATE_PATH || '';
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const keeperInstanceId = randomUUID();
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  return `${'1'.repeat(leading)}${encoded}`;
}

async function upsertBuybackEvidence(roundId, executions) {
  if (!executions.length) return;
  const response = await fetch(
    `${supabaseUrl}/rest/v1/mine_buyback_executions?on_conflict=round_id,sequence`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(executions.map((entry, sequence) => ({
        round_id: roundId,
        sequence,
        spend_lamports: entry.spendLamports,
        expected_output_base_units: entry.expectedOutputBaseUnits,
        burned_base_units: entry.burnedBaseUnits,
        swap_signature: entry.swapSignature,
        burn_signature: entry.burnSignature,
      }))),
    },
  );
  const text = await response.text();
  assert.ok(response.ok, `Buyback evidence index failed (${response.status}): ${text}`);
}

async function acquireBuybackLease() {
  const ttlSeconds = readInteger(
    process.env.BUYBACK_LEASE_TTL_SECONDS || '600',
    'BUYBACK_LEASE_TTL_SECONDS',
  );
  assert.ok(ttlSeconds >= 120 && ttlSeconds <= 3600, 'BUYBACK_LEASE_TTL_SECONDS must be 120..3600');
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/acquire_mine_keeper_lease`, {
    method: 'POST',
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_lease_name: `buyback:${PROGRAM_ID.toBase58()}`,
      p_holder: keeperInstanceId,
      p_ttl_seconds: ttlSeconds,
    }),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `Buyback lease request failed (${response.status})`);
  return body === true;
}

async function indexedBuybackBacklog(cursorRound, currentRound) {
  assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS for indexed buyback selection');
  assert.ok(serviceRole, 'SUPABASE_SERVICE_ROLE_KEY is required for indexed buyback selection');
  const query = new URLSearchParams({
    resolved: 'eq.true',
    buyback_completed: 'eq.false',
    total_wager_wei: 'gt.0',
    and: `(round_id.gte.${cursorRound},round_id.lte.${currentRound})`,
    order: 'round_id.asc',
    limit: '100',
    select: 'round_id,resolved,buyback_completed,total_wager_wei',
  });
  const response = await fetch(
    `${supabaseUrl}/rest/v1/mine_rounds?${query}`,
    {
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
      },
    },
  );
  const body = await response.json().catch(() => null);
  assert.ok(response.ok && Array.isArray(body), `Indexed buyback backlog failed (${response.status})`);
  return body;
}

async function loadState() {
  if (!statePath) return { rounds: {} };
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.rounds && typeof parsed.rounds === 'object'
      ? { nextRound: parsed.nextRound, ...parsed }
      : { rounds: {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { rounds: {} };
    throw error;
  }
}

async function saveState(state) {
  if (!statePath) return;
  const temporary = `${statePath}.${process.pid}.tmp`;
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

function assertLiveAuthorization() {
  if (envBool('DRY_RUN', true)) return;
  assert.equal(
    process.env.BUYBACK_KEEPER_LIVE,
    PROGRAM_ID_TEXT,
    `Set BUYBACK_KEEPER_LIVE=${PROGRAM_ID_TEXT} to authorize live buyback transactions`,
  );
}

function readInteger(value, name) {
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed >= 0, `${name} must be a non-negative integer`);
  return parsed;
}

async function fetchQuote(inputLamports, mint, poolAddress, slippageBps, route) {
  const params = new URLSearchParams({
    inputMint: NATIVE_MINT.toBase58(),
    outputMint: mint.toBase58(),
    amount: String(inputLamports),
    slippageBps: String(slippageBps),
    dexes: route.label,
    onlyDirectRoutes: 'true',
    restrictIntermediateTokens: 'true',
  });
  const response = await fetch(`${JUPITER_QUOTE_URL}?${params}`);
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `Jupiter quote failed: ${body.error || response.status}`);
  return {
    raw: body,
    checked: validateDirectMeteoraQuote(body, {
      poolAddress: poolAddress.toBase58(),
      inputLamports,
      outputMint: mint.toBase58(),
      expectedAmmLabel: route.label,
      maxPriceImpactPct: Number(process.env.MAX_PRICE_IMPACT_PCT || '5'),
    }),
  };
}

async function buildSwapTransaction(quote) {
  const response = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: payer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: validateJupiterPriorityLevel(
            process.env.JUPITER_PRIORITY_LEVEL || 'medium',
          ),
          maxLamports: readInteger(process.env.MAX_PRIORITY_LAMPORTS || '500000', 'MAX_PRIORITY_LAMPORTS'),
        },
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok && body.swapTransaction, `Jupiter swap build failed: ${body.error || response.status}`);
  return VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, 'base64'));
}

async function inspectSwapTransaction(transaction, {
  inputLamports,
  myneAta,
  beforeBaseUnits,
  minimumOutputBaseUnits,
  meteoraProgram,
}) {
  assert.equal(
    transaction.message.staticAccountKeys[0]?.toBase58(),
    payer.publicKey.toBase58(),
    'Jupiter transaction fee payer changed unexpectedly',
  );
  assert.equal(
    transaction.message.header.numRequiredSignatures,
    1,
    'Jupiter transaction requires an unexpected signer',
  );
  const lookupTables = [];
  for (const lookup of transaction.message.addressTableLookups) {
    const response = await provider.connection.getAddressLookupTable(lookup.accountKey, { commitment });
    assert.ok(response.value, `Jupiter lookup table is unavailable: ${lookup.accountKey.toBase58()}`);
    lookupTables.push(response.value);
  }
  const decompiled = TransactionMessage.decompile(transaction.message, {
    addressLookupTableAccounts: lookupTables,
  });
  const allowedPrograms = new Set([
    ComputeBudgetProgram.programId.toBase58(),
    web3.SystemProgram.programId.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    JUPITER_AGGREGATOR_V6.toBase58(),
    meteoraProgram,
  ]);
  for (const instruction of decompiled.instructions) {
    assert.ok(
      allowedPrograms.has(instruction.programId.toBase58()),
      `Jupiter transaction contains an unapproved program: ${instruction.programId.toBase58()}`,
    );
  }

  const beforeLamports = BigInt(await provider.connection.getBalance(payer.publicKey, commitment));
  const simulation = await provider.connection.simulateTransaction(transaction, {
    commitment,
    sigVerify: false,
    accounts: {
      encoding: 'base64',
      addresses: [payer.publicKey.toBase58(), myneAta.toBase58()],
    },
  });
  assert.equal(
    simulation.value.err,
    null,
    `Meteora swap simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).join('\n')}`,
  );
  const [postPayer, postMyne] = simulation.value.accounts || [];
  assert.ok(postPayer && postMyne, 'Swap simulation did not return payer and MYNE account state');
  const spentLamports = beforeLamports - BigInt(postPayer.lamports);
  assert.ok(spentLamports >= BigInt(inputLamports), 'Swap simulation spends less than the quoted input');
  const fee = BigInt((await provider.connection.getFeeForMessage(transaction.message, commitment)).value || 0);
  const overhead = BigInt(readInteger(
    process.env.MAX_SWAP_OVERHEAD_LAMPORTS || '5000000',
    'MAX_SWAP_OVERHEAD_LAMPORTS',
  ));
  assert.ok(
    spentLamports <= BigInt(inputLamports) + fee + overhead,
    `Swap simulation exceeds input plus bounded overhead: ${spentLamports} lamports`,
  );
  const tokenData = Buffer.from(postMyne.data[0], 'base64');
  const postBaseUnits = BigInt(splToken.AccountLayout.decode(tokenData).amount.toString());
  assert.ok(postBaseUnits >= beforeBaseUnits, 'Swap simulation reduces the keeper MYNE balance');
  assert.ok(
    postBaseUnits - beforeBaseUnits >= BigInt(minimumOutputBaseUnits),
    'Swap simulation output is below the quote slippage threshold',
  );
  return { simulation, spentLamports, postBaseUnits };
}

async function ensureMyneAta(mint) {
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  if (await provider.connection.getAccountInfo(ata, 'confirmed')) return ata;
  const instruction = createAssociatedTokenAccountInstruction(
    payer.publicKey, ata, payer.publicKey, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const transaction = new Transaction().add(instruction);
  await sendAndConfirmTransaction(provider.connection, transaction, [payer], { commitment: 'confirmed' });
  return ata;
}

async function buildBurnTransaction(mint, ata, beforeBaseUnits) {
  const account = await getAccount(provider.connection, ata, 'confirmed', TOKEN_PROGRAM_ID);
  const delta = account.amount - beforeBaseUnits;
  assert.ok(delta > 0n, 'Swap produced no positive MYNE balance delta');
  const mintInfo = await splToken.getMint(provider.connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
  const instruction = createBurnCheckedInstruction(
    ata, mint, payer.publicKey, delta, mintInfo.decimals, [], TOKEN_PROGRAM_ID,
  );
  const { blockhash } = await provider.connection.getLatestBlockhash('confirmed');
  const simulationTransaction = new Transaction({
    feePayer: payer.publicKey, recentBlockhash: blockhash,
  }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction);
  const simulation = await provider.connection.simulateTransaction(simulationTransaction, [payer]);
  assert.equal(simulation.value.err, null, `MYNE burn simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const measured = Math.max(50_000, Number(simulation.value.unitsConsumed || 200_000));
  const priority = Math.min(
    1_000_000,
    readInteger(process.env.KEEPER_PRIORITY_MICROLAMPORTS || '0', 'KEEPER_PRIORITY_MICROLAMPORTS'),
  );
  const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: Math.min(1_400_000, Math.ceil(measured * 1.1)),
    }),
    ...(priority > 0
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority })]
      : []),
    instruction,
  );
  transaction.sign(payer);
  return {
    delta,
    raw: Buffer.from(transaction.serialize()).toString('base64'),
    signature: base58Encode(transaction.signature),
  };
}

async function sendSavedTransaction(rawBase64) {
  const signature = await provider.connection.sendRawTransaction(Buffer.from(rawBase64, 'base64'), {
    maxRetries: 3,
    skipPreflight: false,
  });
  const confirmation = await provider.connection.confirmTransaction(signature, 'confirmed');
  assert.equal(confirmation.value.err, null, `Saved buyback transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}

async function savedSignatureStatus(signature) {
  const response = await provider.connection.getSignatureStatuses(
    [signature],
    { searchTransactionHistory: true },
  );
  return response.value[0] || null;
}

async function markRoundBuybackComplete(roundAddress, roundState) {
  if (roundState.buybackCompleted) return null;
  const instruction = await program.methods.markBuybackCompleted().accounts({
    config,
    round: roundAddress,
    buybackAuthority: payer.publicKey,
  }).instruction();
  const simulationTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    instruction,
  );
  const latest = await provider.connection.getLatestBlockhash('confirmed');
  simulationTx.recentBlockhash = latest.blockhash;
  simulationTx.feePayer = payer.publicKey;
  const simulation = await provider.connection.simulateTransaction(simulationTx, [payer]);
  assert.equal(simulation.value.err, null, `Buyback completion simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const measured = Math.max(50_000, Number(simulation.value.unitsConsumed || 200_000));
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, Math.ceil(measured * 1.1)) }),
    instruction,
  );
  return sendAndConfirmTransaction(provider.connection, transaction, [payer], { commitment: 'confirmed' });
}

function roundJournal(state, roundId) {
  const raw = state.rounds[roundId];
  if (typeof raw === 'string' || typeof raw === 'number') {
    return { processedLamports: String(raw), pending: null, executions: [] };
  }
  return raw && typeof raw === 'object'
    ? {
      processedLamports: String(raw.processedLamports || '0'),
      pending: raw.pending || null,
      executions: Array.isArray(raw.executions) ? raw.executions : [],
    }
    : { processedLamports: '0', pending: null, executions: [] };
}

async function recoverPendingBuyback({ state, roundKey, journal, mint, ata }) {
  const pending = journal.pending;
  if (!pending) return null;
  const before = BigInt(pending.beforeBaseUnits);
  let current = (await getAccount(provider.connection, ata, 'confirmed', TOKEN_PROGRAM_ID)).amount;

  if (pending.phase === 'swap-ready') {
    if (current <= before) {
      try {
        const submitted = await sendSavedTransaction(pending.swapRaw);
        assert.equal(submitted, pending.swapSignature, 'Submitted swap signature changed');
      } catch (error) {
        current = (await getAccount(provider.connection, ata, 'confirmed', TOKEN_PROGRAM_ID)).amount;
        if (current <= before) {
          const status = await savedSignatureStatus(pending.swapSignature);
          const explicitlyAbandoned = process.env.CONFIRM_ABANDONED_BUYBACK
            === `${roundKey}:${pending.swapSignature}`;
          if (status?.err || explicitlyAbandoned) {
            // A finalized transaction error is safe to retry. For an absent or
            // ambiguous RPC status, require an exact round+signature operator
            // acknowledgement; never silently requote and risk a double spend.
            journal.pending = null;
            state.rounds[roundKey] = journal;
            await saveState(state);
            return {
              skipped: true,
              reason: status?.err
                ? 'pending-swap-finalized-error-retry-next-tick'
                : 'pending-swap-explicitly-abandoned-retry-next-tick',
              detail: String(error),
            };
          }
          return {
            skipped: true,
            reason: 'pending-swap-status-ambiguous-manual-reconciliation-required',
            swapSignature: pending.swapSignature,
            detail: String(error),
          };
        }
      }
    }
    pending.phase = 'swapped';
    state.rounds[roundKey] = journal;
    await saveState(state);
  }

  current = (await getAccount(provider.connection, ata, 'confirmed', TOKEN_PROGRAM_ID)).amount;
  if (current > before && !pending.burnRaw) {
    const burn = await buildBurnTransaction(mint, ata, before);
    pending.burnBaseUnits = burn.delta.toString();
    pending.burnRaw = burn.raw;
    pending.burnSignature = burn.signature;
    pending.phase = 'burn-ready';
    state.rounds[roundKey] = journal;
    await saveState(state);
  }
  if (current > before) {
    try {
      const submitted = await sendSavedTransaction(pending.burnRaw);
      assert.equal(submitted, pending.burnSignature, 'Submitted burn signature changed');
    } catch (error) {
      // A crash can occur after the exact burn landed but before the journal
      // was updated. Treat the saved transaction as complete only when the
      // token balance proves the purchased delta is already gone.
      const recoveredBalance = (await getAccount(
        provider.connection,
        ata,
        'confirmed',
        TOKEN_PROGRAM_ID,
      )).amount;
      if (recoveredBalance > before) throw error;
    }
  }
  const after = (await getAccount(provider.connection, ata, 'confirmed', TOKEN_PROGRAM_ID)).amount;
  assert.ok(after <= before, 'Burn transaction did not remove the purchased MYNE');
  journal.processedLamports = (BigInt(journal.processedLamports) + BigInt(pending.spendLamports)).toString();
  const completed = { ...pending };
  journal.executions.push({
    spendLamports: completed.spendLamports,
    expectedOutputBaseUnits: completed.expectedOutputBaseUnits,
    burnedBaseUnits: completed.burnBaseUnits,
    swapSignature: completed.swapSignature,
    burnSignature: completed.burnSignature,
  });
  journal.pending = null;
  state.rounds[roundKey] = journal;
  await saveState(state);
  return {
    skipped: false,
    recovered: true,
    swapSignature: completed.swapSignature,
    burnSignature: completed.burnSignature,
    burnedBaseUnits: completed.burnBaseUnits,
  };
}

export async function keeperTick({ dryRun = envBool('DRY_RUN', true) } = {}) {
  if (!dryRun) assertLiveAuthorization();
  if (!dryRun) assert.ok(statePath, 'Set BUYBACK_STATE_PATH to a durable keeper state file before live mode');
  if (!dryRun) assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS in live mode');
  if (!dryRun) assert.ok(serviceRole, 'SUPABASE_SERVICE_ROLE_KEY is required in live mode');
  const configState = await program.account.protocolConfig.fetch(config);
  assert.equal(Number(configState.version), 6, 'Buyback keeper requires protocol fee schedule v6');
  const network = requireMatchingSolanaNetwork({
    genesisHash: await provider.connection.getGenesisHash(),
    randomnessProgram: configState.randomnessProgram.toBase58(),
    serverRandomnessProgram: process.env.MYNE_SERVER_RANDOMNESS_ACK === PROGRAM_ID_TEXT
      ? PROGRAM_ID_TEXT
      : null,
  });
  // Devnet intentionally runs without Meteora liquidity. The protocol still
  // accounts for the 1% allocation on-chain, but there is no swap to execute
  // until a real pool is registered; leave the allocation untouched for a
  // later pool-backed rehearsal.
  if (network === 'devnet') {
    return { skipped: true, reason: 'devnet-liquidity-pool-not-required' };
  }
  if (!dryRun && !(await acquireBuybackLease())) {
    return { skipped: true, reason: 'buyback-lease-held-by-another-instance' };
  }
  const gateState = await program.account.liquidityGate.fetch(liquidityGate);
  assert.ok(gateState.verified, 'Liquidity gate is not verified');
  const meteoraRoute = meteoraRouteForProgram(gateState.poolProgram.toBase58());
  const registeredPool = await provider.connection.getAccountInfo(gateState.pool, commitment);
  assert.ok(
    registeredPool
      && !registeredPool.executable
      && registeredPool.owner.equals(gateState.poolProgram),
    'Registered Meteora pool owner differs from the immutable gate',
  );
  assert.equal(configState.mint.toBase58(), process.env.MYNE_MINT_ADDRESS || configState.mint.toBase58(), 'MYNE mint mismatch');
  assert.equal(configState.buybackWallet.toBase58(), payer.publicKey.toBase58(), 'Keeper must control config.buybackWallet');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const initializedAt = Number(configState.initializedAt.toString());
  const roundDuration = Number(configState.roundDurationSeconds.toString());
  const currentRound = Math.floor((nowSeconds - initializedAt) / roundDuration) - 1;
  if (currentRound < 0) return { skipped: true, reason: 'no-settled-round-yet' };
  const state = await loadState();
  // Select from the durable indexed backlog rather than probing sequential
  // numeric IDs. Empty rounds have no PDA, so a missing launch journal or a
  // gap must advance to the first real settled allocation instead of pinning
  // the worker forever at round zero.
  const forcedRound = process.env.MYNE_ROUND_ID == null
    ? null : readInteger(process.env.MYNE_ROUND_ID, 'MYNE_ROUND_ID');
  const initialRound = forcedRound ?? Number(
    state.nextRound ?? process.env.BUYBACK_START_ROUND ?? 0,
  );
  assert.ok(
    Number.isSafeInteger(initialRound) && initialRound >= 0,
    'BUYBACK_START_ROUND must be a non-negative integer',
  );
  const backlogUpperBound = forcedRound ?? currentRound;
  if (initialRound > backlogUpperBound) {
    return { skipped: true, reason: 'no-indexed-buyback-backlog' };
  }
  const indexedRows = await indexedBuybackBacklog(initialRound, backlogUpperBound);
  const indexedRound = selectIndexedBuybackRound(indexedRows, {
    cursorRound: initialRound,
    currentRound: backlogUpperBound,
  });
  if (!indexedRound) {
    return { skipped: true, reason: 'no-indexed-buyback-backlog' };
  }
  const roundId = BigInt(String(indexedRound.round_id));
  const roundSeed = Buffer.alloc(8);
  roundSeed.writeBigUInt64LE(roundId);
  const [roundAddress] = PublicKey.findProgramAddressSync([Buffer.from('round'), roundSeed], PROGRAM_ID);
  if (!(await provider.connection.getAccountInfo(roundAddress, 'confirmed'))) {
    return {
      skipped: true,
      reason: 'indexed-round-account-missing-reconcile-required',
      round: roundId.toString(),
    };
  }
  const roundState = await program.account.round.fetch(roundAddress);
  if (!roundState.settled) return { skipped: true, reason: 'round-not-settled', round: roundId.toString() };
  if (roundState.buybackCompleted) {
    if (forcedRound == null) {
      state.nextRound = Number(roundId + 1n);
      await saveState(state);
    }
    return {
      skipped: true,
      reason: 'round-buyback-completed-on-chain',
      round: roundId.toString(),
    };
  }
  const allocation = (BigInt(roundState.grossDeployedLamports.toString()) * 100n) / 10_000n;
  const roundKey = roundId.toString();
  const journal = roundJournal(state, roundKey);
  state.rounds[roundKey] = journal;
  const mint = configState.mint;
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  if (journal.pending) {
    assert.ok(!dryRun, 'A live pending buyback cannot be recovered in dry-run mode');
    assert.ok(await provider.connection.getAccountInfo(ata, 'confirmed'), 'Pending buyback MYNE account is missing');
    const recovered = await recoverPendingBuyback({ state, roundKey, journal, mint, ata });
    if (!recovered.skipped) await upsertBuybackEvidence(roundKey, journal.executions);
    if (!recovered.skipped && BigInt(journal.processedLamports) >= allocation) {
      recovered.completionSignature = await markRoundBuybackComplete(roundAddress, roundState);
      if (process.env.MYNE_ROUND_ID == null) {
        state.nextRound = Number(roundId + 1n);
        await saveState(state);
      }
    }
    return recovered;
  }
  const previous = BigInt(journal.processedLamports);
  const evidencedLamports = journal.executions.reduce(
    (sum, entry) => sum + BigInt(entry.spendLamports), 0n,
  );
  if (!dryRun) {
    assert.equal(
      evidencedLamports,
      previous,
      'Durable buyback journal is missing transaction evidence; refuse completion',
    );
    await upsertBuybackEvidence(roundKey, journal.executions);
  }
  const remainingAllocation = allocation > previous ? allocation - previous : 0n;
  if (remainingAllocation === 0n) {
    const completionSignature = dryRun ? null : await markRoundBuybackComplete(roundAddress, roundState);
    if (!dryRun && process.env.MYNE_ROUND_ID == null) {
      state.nextRound = Number(roundId + 1n);
      await saveState(state);
    }
    return { skipped: true, reason: 'round-already-processed', round: roundId.toString(), completionSignature };
  }
  assert.ok(remainingAllocation <= BigInt(Number.MAX_SAFE_INTEGER), 'Round buyback exceeds safe keeper amount');
  const poolAddress = gateState.pool;
  // Preserve only a transaction-fee/rent buffer. The 1% round allocations in
  // this wallet are protocol funds and must not be stranded behind a large
  // operational reserve.
  const reserve = lamports(process.env.BUYBACK_FEE_RESERVE_SOL || '0.005');
  const maxSpend = Math.min(lamports(process.env.MAX_BUYBACK_SOL || '0.25'), Number(remainingAllocation));
  const balance = await provider.connection.getBalance(payer.publicKey, 'confirmed');
  // The protocol minimum round produces a 0.0005 SOL buyback allocation, so a
  // 0.01 SOL keeper floor would strand otherwise valid rounds forever.
  const minimum = lamports(process.env.MIN_BUYBACK_SOL || '0.0001');
  const spendPlan = calculateSpend({
    balanceLamports: balance,
    reserveLamports: reserve,
    maxSpendLamports: maxSpend,
    minimumLamports: minimum,
  });
  if (spendPlan.skipped) return { ...spendPlan, balance, round: roundId.toString(), allocationLamports: allocation.toString() };
  const spend = spendPlan.spendLamports;
  const slippageBps = readInteger(process.env.BUYBACK_SLIPPAGE_BPS || '100', 'BUYBACK_SLIPPAGE_BPS');
  assert.ok(slippageBps <= 500, 'BUYBACK_SLIPPAGE_BPS must be <= 500 (5%)');
  const { raw: quote, checked } = await fetchQuote(
    spend,
    configState.mint,
    poolAddress,
    slippageBps,
    meteoraRoute,
  );
  const result = { skipped: false, dryRun, round: roundId.toString(), allocationLamports: allocation.toString(), pool: poolAddress.toBase58(), spendLamports: spend, ...checked };
  if (dryRun) return result;
  const ensuredAta = await ensureMyneAta(configState.mint);
  const before = (await getAccount(provider.connection, ensuredAta, 'confirmed')).amount;
  const swap = await buildSwapTransaction(quote);
  await inspectSwapTransaction(swap, {
    inputLamports: spend,
    myneAta: ensuredAta,
    beforeBaseUnits: before,
    minimumOutputBaseUnits: quote.otherAmountThreshold || checked.outputBaseUnits,
    meteoraProgram: meteoraRoute.program,
  });
  swap.sign([payer]);
  const swapSignature = base58Encode(swap.signatures[0]);
  journal.pending = {
    phase: 'swap-ready',
    spendLamports: String(spend),
    beforeBaseUnits: before.toString(),
    expectedOutputBaseUnits: checked.outputBaseUnits,
    swapRaw: Buffer.from(swap.serialize()).toString('base64'),
    swapSignature,
    burnRaw: null,
    burnSignature: null,
  };
  state.rounds[roundKey] = journal;
  await saveState(state);
  const recovered = await recoverPendingBuyback({ state, roundKey, journal, mint: configState.mint, ata: ensuredAta });
  if (!recovered.skipped) await upsertBuybackEvidence(roundKey, journal.executions);
  Object.assign(result, recovered);
  if (BigInt(journal.processedLamports) >= allocation) {
    result.completionSignature = await markRoundBuybackComplete(roundAddress, roundState);
    if (process.env.MYNE_ROUND_ID == null) {
      state.nextRound = Number(roundId + 1n);
      await saveState(state);
    }
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const once = process.argv.includes('--once');
  const intervalMs = readInteger(process.env.BUYBACK_INTERVAL_MS || '60000', 'BUYBACK_INTERVAL_MS');
  do {
    try {
      console.log(JSON.stringify({ at: new Date().toISOString(), event: 'buyback-tick', ...(await keeperTick()) }));
    } catch (error) {
      console.error(JSON.stringify({ at: new Date().toISOString(), event: 'buyback-error', message: error instanceof Error ? error.message : String(error) }));
      if (process.env.FAIL_FAST === '1') {
        process.exitCode = 1;
        break;
      }
    }
    if (!once) await sleep(intervalMs);
  } while (!once);
}
