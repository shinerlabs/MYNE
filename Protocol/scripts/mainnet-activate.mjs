/** Unpause MYNE only after the immutable pool and every launch gate are verified. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SOLANA_MAINNET_GENESIS_HASH, SWITCHBOARD_MAINNET_PROGRAM } from './production-network-policy.mjs';
import { inspectMeteoraPool } from './mainnet-liquidity-policy.mjs';

const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const COMPUTE_UNIT_LIMIT = 220_000;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function requireConfirmation(name, expected) {
  assert.equal(process.env[name], expected, `Set ${name}=${expected} after reviewing the value`);
}

async function readKeypair(path) {
  const secret = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(Array.isArray(secret) && secret.length === 64, 'ANCHOR_WALLET must contain a keypair');
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const rpcUrl = requiredEnv('MAINNET_RPC_URL');
const payer = await readKeypair(requiredEnv('ANCHOR_WALLET'));
const mint = new PublicKey(requiredEnv('MAINNET_MINT_ADDRESS'));
const reviewedPool = new PublicKey(requiredEnv('METEORA_POOL'));
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [liquidityGate] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_gate')], PROGRAM_ID);

requireConfirmation('CONFIRM_SOLANA_GENESIS_HASH', SOLANA_MAINNET_GENESIS_HASH);
requireConfirmation('CONFIRM_MAINNET_CONFIG', config.toBase58());
requireConfirmation('CONFIRM_MAINNET_LIQUIDITY_GATE', liquidityGate.toBase58());
requireConfirmation('CONFIRM_METEORA_POOL', reviewedPool.toBase58());
requireConfirmation('CONFIRM_PRODUCTION_SERVICES_READY', 'VERIFIED');
requireConfirmation('CONFIRM_INDEPENDENT_SECURITY_REVIEW', 'APPROVED_EXACT_RELEASE');

const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
assert.equal(await connection.getGenesisHash(), SOLANA_MAINNET_GENESIS_HASH, 'RPC is not Mainnet');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
assert.equal(idl.address, PROGRAM_ID.toBase58(), 'IDL program address differs');
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(payer),
  { commitment: 'confirmed', preflightCommitment: 'confirmed' },
);
const program = new anchor.Program(idl, provider);
const [configState, gate] = await Promise.all([
  program.account.protocolConfig.fetch(config, 'finalized'),
  program.account.liquidityGate.fetch(liquidityGate, 'finalized'),
]);
assert.equal(configState.version, 6, 'Protocol is not fee schedule v6');
assert.ok(configState.admin.equals(payer.publicKey), 'Signer is not the protocol admin');
assert.ok(configState.mint.equals(mint), 'Configured MYNE mint differs');
const configuredRandomnessProgram = configState.randomnessProgram.toBase58();
assert.ok(
  configuredRandomnessProgram === SWITCHBOARD_MAINNET_PROGRAM
    || configuredRandomnessProgram === PROGRAM_ID.toBase58(),
  'Protocol randomness provider is not an approved Mainnet provider',
);
requireConfirmation('CONFIRM_MAINNET_RANDOMNESS_PROGRAM', configuredRandomnessProgram);
if (configuredRandomnessProgram === PROGRAM_ID.toBase58()) {
  requireConfirmation('CONFIRM_SERVER_RANDOMNESS_REVIEW', 'APPROVED_EXACT_RELEASE');
}
assert.equal(gate.verified, true, 'Liquidity gate is not verified');
assert.ok(gate.pool.equals(reviewedPool), 'Registered pool differs from the reviewed pool');
const poolState = await inspectMeteoraPool(connection, reviewedPool, mint);
assert.ok(gate.poolProgram.equals(poolState.poolProgram), 'Registered pool program differs');
assert.ok(gate.myneVault.equals(poolState.myneVault), 'Registered MYNE vault differs');
assert.ok(gate.solVault.equals(poolState.solVault), 'Registered SOL vault differs');
assert.ok(poolState.myneAmount >= BigInt(gate.minMyneBaseUnits.toString()), 'MYNE liquidity is below gate minimum');
assert.ok(poolState.solAmount >= BigInt(gate.minSolLamports.toString()), 'SOL liquidity is below gate minimum');

if (!configState.paused) {
  console.log(JSON.stringify({
    ok: true,
    alreadyActive: true,
    config: config.toBase58(),
    liquidityGate: liquidityGate.toBase58(),
    pool: reviewedPool.toBase58(),
    randomnessProgram: configuredRandomnessProgram,
  }, null, 2));
  process.exit(0);
}

const activateInstruction = await program.methods.setPaused(false).accounts({
  config,
  liquidityGate,
  liquidityPool: reviewedPool,
  baseVault: poolState.myneVault,
  quoteVault: poolState.solVault,
  admin: payer.publicKey,
}).instruction();
const latest = await connection.getLatestBlockhash('finalized');
const message = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: latest.blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    activateInstruction,
  ],
}).compileToV0Message();
const transaction = new VersionedTransaction(message);
transaction.sign([payer]);
const simulation = await connection.simulateTransaction(transaction, {
  commitment: 'confirmed',
  replaceRecentBlockhash: false,
  sigVerify: true,
});
assert.equal(
  simulation.value.err,
  null,
  `Mainnet activation simulation failed:\n${(simulation.value.logs || []).join('\n')}`,
);

const preview = {
  ok: true,
  simulationOnly: process.env.SUBMIT_MAINNET_ACTIVATE !== config.toBase58(),
  config: config.toBase58(),
  liquidityGate: liquidityGate.toBase58(),
  pool: reviewedPool.toBase58(),
  randomnessProgram: configuredRandomnessProgram,
  myneVault: poolState.myneVault.toBase58(),
  solVault: poolState.solVault.toBase58(),
  myneAmount: poolState.myneAmount.toString(),
  solAmount: poolState.solAmount.toString(),
  unitsConsumed: simulation.value.unitsConsumed ?? null,
};
if (preview.simulationOnly) {
  console.log(JSON.stringify({
    ...preview,
    submitWith: `SUBMIT_MAINNET_ACTIVATE=${config.toBase58()}`,
  }, null, 2));
  process.exit(0);
}

const signature = await connection.sendRawTransaction(transaction.serialize(), {
  maxRetries: 3,
  preflightCommitment: 'confirmed',
  skipPreflight: false,
});
const confirmation = await connection.confirmTransaction({
  signature,
  blockhash: latest.blockhash,
  lastValidBlockHeight: latest.lastValidBlockHeight,
}, 'finalized');
assert.equal(confirmation.value.err, null, 'Mainnet activation failed confirmation');
const activeConfig = await program.account.protocolConfig.fetch(config, 'finalized');
assert.equal(activeConfig.paused, false, 'Protocol did not become active');
console.log(JSON.stringify({ ...preview, simulationOnly: false, submitted: true, signature }, null, 2));
