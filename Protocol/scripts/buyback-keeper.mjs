/**
 * MYNE Meteora buyback + burn keeper.
 *
 * The on-chain program sends the 2% buyback allocation to config.buybackWallet.
 * This process spends only that wallet's SOL, routes directly through the
 * registered Meteora DLMM pool, and burns the MYNE received by the same wallet.
 *
 * Safe by default: BUYBACK_KEEPER_LIVE must equal the program id before any
 * transaction is sent. Use DRY_RUN=1 (the default) to quote without spending.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import anchor from '@anchor-lang/core';
import web3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import {
  calculateSpend,
  METEORA_DLMM_LABEL,
  validateDirectMeteoraQuote,
} from './buyback-policy.mjs';

const { AnchorProvider, Program, setProvider } = anchor;
const {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
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
const JUPITER_QUOTE_URL = process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL = process.env.JUPITER_SWAP_URL || 'https://lite-api.jup.ag/swap/v1/swap';
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed keeper wallet is required (set ANCHOR_WALLET)');
const program = new Program(idl, provider);

const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [liquidityGate] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_gate')], PROGRAM_ID);
const lamports = (sol) => Math.max(0, Math.floor(Number(sol) * LAMPORTS_PER_SOL));
const envBool = (name, fallback) => process.env[name] == null ? fallback : process.env[name] === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const statePath = process.env.BUYBACK_STATE_PATH || '';

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

async function fetchQuote(inputLamports, mint, poolAddress, slippageBps) {
  const params = new URLSearchParams({
    inputMint: NATIVE_MINT.toBase58(),
    outputMint: mint.toBase58(),
    amount: String(inputLamports),
    slippageBps: String(slippageBps),
    dexes: METEORA_DLMM_LABEL,
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
          priorityLevel: process.env.JUPITER_PRIORITY_LEVEL || 'veryLow',
          maxLamports: readInteger(process.env.MAX_PRIORITY_LAMPORTS || '500000', 'MAX_PRIORITY_LAMPORTS'),
        },
      },
    }),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok && body.swapTransaction, `Jupiter swap build failed: ${body.error || response.status}`);
  return VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, 'base64'));
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

async function burnDelta(mint, ata, beforeBaseUnits) {
  const account = await getAccount(provider.connection, ata, 'confirmed', TOKEN_PROGRAM_ID);
  const delta = account.amount - beforeBaseUnits;
  assert.ok(delta > 0n, 'Swap produced no positive MYNE balance delta');
  const mintInfo = await splToken.getMint(provider.connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
  const instruction = createBurnCheckedInstruction(
    ata, mint, payer.publicKey, delta, mintInfo.decimals, [], TOKEN_PROGRAM_ID,
  );
  const transaction = new Transaction().add(instruction);
  const simulation = await provider.connection.simulateTransaction(transaction, [payer]);
  assert.equal(simulation.value.err, null, `MYNE burn simulation failed: ${JSON.stringify(simulation.value.err)}`);
  return sendAndConfirmTransaction(provider.connection, transaction, [payer], { commitment: 'confirmed' });
}

export async function keeperTick({ dryRun = envBool('DRY_RUN', true) } = {}) {
  if (!dryRun) assertLiveAuthorization();
  if (!dryRun) assert.ok(statePath, 'Set BUYBACK_STATE_PATH to a durable keeper state file before live mode');
  const configState = await program.account.protocolConfig.fetch(config);
  const gateState = await program.account.liquidityGate.fetch(liquidityGate);
  assert.ok(gateState.verified, 'Liquidity gate is not verified');
  assert.equal(configState.mint.toBase58(), process.env.MYNE_MINT_ADDRESS || configState.mint.toBase58(), 'MYNE mint mismatch');
  assert.equal(configState.buybackWallet.toBase58(), payer.publicKey.toBase58(), 'Keeper must control config.buybackWallet');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const initializedAt = Number(configState.initializedAt.toString());
  const roundDuration = Number(configState.roundDurationSeconds.toString());
  const currentRound = Math.floor((nowSeconds - initializedAt) / roundDuration) - 1;
  if (currentRound < 0) return { skipped: true, reason: 'no-settled-round-yet' };
  const state = await loadState();
  const initialRound = state.nextRound == null ? currentRound : Number(state.nextRound);
  const roundId = BigInt(process.env.MYNE_ROUND_ID || Math.min(initialRound, currentRound));
  const roundSeed = Buffer.alloc(8);
  roundSeed.writeBigUInt64LE(roundId);
  const [roundAddress] = PublicKey.findProgramAddressSync([Buffer.from('round'), roundSeed], PROGRAM_ID);
  if (!(await provider.connection.getAccountInfo(roundAddress, 'confirmed'))) {
    return { skipped: true, reason: 'round-not-opened', round: roundId.toString() };
  }
  const roundState = await program.account.round.fetch(roundAddress);
  if (!roundState.settled) return { skipped: true, reason: 'round-not-settled', round: roundId.toString() };
  const allocation = (BigInt(roundState.grossDeployedLamports.toString()) * 200n) / 10_000n;
  const previous = BigInt(state.rounds[roundId.toString()] || '0');
  const remainingAllocation = allocation > previous ? allocation - previous : 0n;
  if (remainingAllocation === 0n) {
    if (!dryRun && process.env.MYNE_ROUND_ID == null) {
      state.nextRound = Number(roundId + 1n);
      await saveState(state);
    }
    return { skipped: true, reason: 'round-already-processed', round: roundId.toString() };
  }
  assert.ok(remainingAllocation <= BigInt(Number.MAX_SAFE_INTEGER), 'Round buyback exceeds safe keeper amount');
  const poolAddress = gateState.pool;
  const reserve = lamports(process.env.KEEPER_RESERVE_SOL || '0.25');
  const maxSpend = Math.min(lamports(process.env.MAX_BUYBACK_SOL || '0.25'), Number(remainingAllocation));
  const balance = await provider.connection.getBalance(payer.publicKey, 'confirmed');
  const minimum = lamports(process.env.MIN_BUYBACK_SOL || '0.01');
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
  const { raw: quote, checked } = await fetchQuote(spend, configState.mint, poolAddress, slippageBps);
  const result = { skipped: false, dryRun, round: roundId.toString(), allocationLamports: allocation.toString(), pool: poolAddress.toBase58(), spendLamports: spend, ...checked };
  if (dryRun) return result;
  const ata = await ensureMyneAta(configState.mint);
  const before = (await getAccount(provider.connection, ata, 'confirmed')).amount;
  const swap = await buildSwapTransaction(quote);
  const swapSimulation = await provider.connection.simulateTransaction(swap);
  assert.equal(swapSimulation.value.err, null, `Meteora swap simulation failed: ${JSON.stringify(swapSimulation.value.err)}`);
  swap.sign([payer]);
  result.swapSignature = await provider.connection.sendRawTransaction(swap.serialize(), { maxRetries: 3 });
  await provider.connection.confirmTransaction(result.swapSignature, 'confirmed');
  result.burnSignature = await burnDelta(configState.mint, ata, before);
  assert.ok(result.burnSignature, 'Swap produced no MYNE to burn');
  result.burnedBaseUnits = checked.outputBaseUnits;
  state.rounds[roundId.toString()] = (previous + BigInt(spend)).toString();
  if (BigInt(state.rounds[roundId.toString()]) >= allocation && process.env.MYNE_ROUND_ID == null) {
    state.nextRound = Number(roundId + 1n);
  }
  await saveState(state);
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
      if (process.env.FAIL_FAST === '1') process.exitCode = 1;
    }
    if (!once) await sleep(intervalMs);
  } while (!once);
}
