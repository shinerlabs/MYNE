/** Register the one immutable MYNE/WSOL Meteora liquidity gate while paused. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SOLANA_MAINNET_GENESIS_HASH, SWITCHBOARD_MAINNET_PROGRAM } from './production-network-policy.mjs';
import { inspectMeteoraPool } from './mainnet-liquidity-policy.mjs';

const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const COMPUTE_UNIT_LIMIT = 260_000;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function positiveBigInt(name) {
  const value = BigInt(requiredEnv(name));
  assert.ok(value > 0n && value <= 18_446_744_073_709_551_615n, `${name} must be a positive u64`);
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
const pool = new PublicKey(requiredEnv('METEORA_POOL'));
const minSolLamports = positiveBigInt('MIN_LIQUIDITY_SOL_LAMPORTS');
const minMyneBaseUnits = positiveBigInt('MIN_LIQUIDITY_MYNE_BASE_UNITS');
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [liquidityGate] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_gate')], PROGRAM_ID);

requireConfirmation('CONFIRM_SOLANA_GENESIS_HASH', SOLANA_MAINNET_GENESIS_HASH);
requireConfirmation('CONFIRM_MAINNET_LIQUIDITY_GATE', liquidityGate.toBase58());
requireConfirmation('CONFIRM_METEORA_POOL', pool.toBase58());
requireConfirmation('CONFIRM_MIN_LIQUIDITY_SOL_LAMPORTS', minSolLamports.toString());
requireConfirmation('CONFIRM_MIN_LIQUIDITY_MYNE_BASE_UNITS', minMyneBaseUnits.toString());

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
const configState = await program.account.protocolConfig.fetch(config, 'finalized');
assert.equal(configState.version, 6, 'Protocol is not fee schedule v6');
assert.equal(configState.paused, true, 'Liquidity gate must be registered while paused');
assert.ok(configState.admin.equals(payer.publicKey), 'Signer is not the protocol admin');
assert.ok(configState.mint.equals(mint), 'Configured MYNE mint differs');
assert.equal(
  configState.randomnessProgram.toBase58(),
  SWITCHBOARD_MAINNET_PROGRAM,
  'Protocol is not configured for Switchboard Mainnet',
);

const poolState = await inspectMeteoraPool(connection, pool, mint);
requireConfirmation('CONFIRM_METEORA_MYNE_VAULT', poolState.myneVault.toBase58());
requireConfirmation('CONFIRM_METEORA_SOL_VAULT', poolState.solVault.toBase58());
assert.ok(poolState.myneAmount >= minMyneBaseUnits, 'MYNE reserve is below the reviewed minimum');
assert.ok(poolState.solAmount >= minSolLamports, 'WSOL reserve is below the reviewed minimum');

async function verifyGate() {
  const gate = await program.account.liquidityGate.fetch(liquidityGate, 'finalized');
  assert.equal(gate.verified, true, 'Liquidity gate is not verified');
  assert.ok(gate.pool.equals(pool), 'Registered pool differs');
  assert.ok(gate.poolProgram.equals(poolState.poolProgram), 'Registered pool program differs');
  assert.ok(gate.myneVault.equals(poolState.myneVault), 'Registered MYNE vault differs');
  assert.ok(gate.solVault.equals(poolState.solVault), 'Registered SOL vault differs');
  assert.equal(gate.minSolLamports.toString(), minSolLamports.toString(), 'Registered SOL minimum differs');
  assert.equal(gate.minMyneBaseUnits.toString(), minMyneBaseUnits.toString(), 'Registered MYNE minimum differs');
  return gate;
}

const existingGate = await program.account.liquidityGate.fetchNullable(liquidityGate, 'finalized');
if (existingGate) {
  await verifyGate();
  console.log(JSON.stringify({
    ok: true,
    alreadyExists: true,
    liquidityGate: liquidityGate.toBase58(),
    pool: pool.toBase58(),
    myneVault: poolState.myneVault.toBase58(),
    solVault: poolState.solVault.toBase58(),
  }, null, 2));
  process.exit(0);
}

const gateInstruction = await program.methods
  .initializeLiquidityGate(
    pool,
    poolState.poolProgram,
    new anchor.BN(minSolLamports.toString()),
    new anchor.BN(minMyneBaseUnits.toString()),
  )
  .accounts({
    config,
    liquidityGate,
    pool,
    baseVault: poolState.myneVault,
    quoteVault: poolState.solVault,
    admin: payer.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .instruction();
const latest = await connection.getLatestBlockhash('finalized');
const message = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: latest.blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    gateInstruction,
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
  `Mainnet liquidity-gate simulation failed:\n${(simulation.value.logs || []).join('\n')}`,
);

const preview = {
  ok: true,
  simulationOnly: process.env.SUBMIT_MAINNET_LIQUIDITY_GATE !== pool.toBase58(),
  liquidityGate: liquidityGate.toBase58(),
  pool: pool.toBase58(),
  poolProgram: poolState.poolProgram.toBase58(),
  poolKind: poolState.poolKind,
  tokenXMint: poolState.tokenXMint.toBase58(),
  tokenYMint: poolState.tokenYMint.toBase58(),
  reserveX: poolState.reserveX.toBase58(),
  reserveY: poolState.reserveY.toBase58(),
  myneVault: poolState.myneVault.toBase58(),
  solVault: poolState.solVault.toBase58(),
  myneAmount: poolState.myneAmount.toString(),
  solAmount: poolState.solAmount.toString(),
  minMyneBaseUnits: minMyneBaseUnits.toString(),
  minSolLamports: minSolLamports.toString(),
  unitsConsumed: simulation.value.unitsConsumed ?? null,
};

if (preview.simulationOnly) {
  console.log(JSON.stringify({
    ...preview,
    submitWith: `SUBMIT_MAINNET_LIQUIDITY_GATE=${pool.toBase58()}`,
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
assert.equal(confirmation.value.err, null, 'Liquidity-gate registration failed confirmation');
await verifyGate();
console.log(JSON.stringify({ ...preview, simulationOnly: false, submitted: true, signature }, null, 2));
