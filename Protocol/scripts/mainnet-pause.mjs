/** Emergency fail-closed pause for the MYNE Mainnet protocol. */
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
import { SOLANA_MAINNET_GENESIS_HASH } from './production-network-policy.mjs';

const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const COMPUTE_UNIT_LIMIT = 100_000;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
}

async function readKeypair(path) {
  const secret = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(Array.isArray(secret) && secret.length === 64, 'ANCHOR_WALLET must contain a keypair');
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const rpcUrl = requiredEnv('MAINNET_RPC_URL');
const payer = await readKeypair(requiredEnv('ANCHOR_WALLET'));
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
assert.equal(
  process.env.CONFIRM_SOLANA_GENESIS_HASH,
  SOLANA_MAINNET_GENESIS_HASH,
  'Confirm the canonical Mainnet genesis hash',
);
assert.equal(
  process.env.CONFIRM_MAINNET_CONFIG,
  config.toBase58(),
  'Confirm the exact protocol config PDA',
);

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
assert.ok(configState.admin.equals(payer.publicKey), 'Signer is not the protocol admin');

if (configState.paused) {
  console.log(JSON.stringify({ ok: true, alreadyPaused: true, config: config.toBase58() }, null, 2));
  process.exit(0);
}

const pauseInstruction = await program.methods.setPaused(true).accounts({
  config,
  liquidityGate: null,
  liquidityPool: null,
  baseVault: null,
  quoteVault: null,
  admin: payer.publicKey,
}).instruction();
const latest = await connection.getLatestBlockhash('finalized');
const message = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: latest.blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    pauseInstruction,
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
  `Mainnet pause simulation failed:\n${(simulation.value.logs || []).join('\n')}`,
);

if (process.env.SUBMIT_MAINNET_PAUSE !== config.toBase58()) {
  console.log(JSON.stringify({
    ok: true,
    simulationOnly: true,
    config: config.toBase58(),
    unitsConsumed: simulation.value.unitsConsumed ?? null,
    submitWith: `SUBMIT_MAINNET_PAUSE=${config.toBase58()}`,
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
assert.equal(confirmation.value.err, null, 'Mainnet pause failed confirmation');
let pausedConfig = null;
for (let attempt = 0; attempt < 5; attempt += 1) {
  pausedConfig = await program.account.protocolConfig.fetch(config, 'finalized');
  if (pausedConfig.paused) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
assert.equal(pausedConfig?.paused, true, `Protocol did not become paused; transaction ${signature}`);
console.log(JSON.stringify({
  ok: true,
  simulationOnly: false,
  submitted: true,
  config: config.toBase58(),
  unitsConsumed: simulation.value.unitsConsumed ?? null,
  signature,
}, null, 2));
