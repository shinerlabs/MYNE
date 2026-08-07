/** Return excess Mainnet deployment SOL while retaining an exact fee reserve. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SOLANA_MAINNET_GENESIS_HASH } from './production-network-policy.mjs';

const EXPECTED_DEPLOYER = new PublicKey('FeB5QXHm8TgDVr2QP1qMusJw268EfKtebES8te15fJRa');
const DEFAULT_RESERVE_LAMPORTS = 50_000_000n;

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
const destination = new PublicKey(requiredEnv('MAINNET_REFUND_DESTINATION'));
const reserveLamports = BigInt(
  process.env.MAINNET_DEPLOYER_RESERVE_LAMPORTS || DEFAULT_RESERVE_LAMPORTS.toString(),
);
assert.ok(payer.publicKey.equals(EXPECTED_DEPLOYER), 'Signer is not the reviewed temporary deployer');
assert.ok(!destination.equals(payer.publicKey), 'Refund destination must differ from the deployer');
assert.ok(reserveLamports >= DEFAULT_RESERVE_LAMPORTS, 'Retained deployer reserve must be at least 0.05 SOL');

requireConfirmation('CONFIRM_SOLANA_GENESIS_HASH', SOLANA_MAINNET_GENESIS_HASH);
requireConfirmation('CONFIRM_MAINNET_REFUND_SOURCE', payer.publicKey.toBase58());
requireConfirmation('CONFIRM_MAINNET_REFUND_DESTINATION', destination.toBase58());
requireConfirmation('CONFIRM_MAINNET_DEPLOYER_RESERVE_LAMPORTS', reserveLamports.toString());

const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
assert.equal(await connection.getGenesisHash(), SOLANA_MAINNET_GENESIS_HASH, 'RPC is not Mainnet');
const destinationAccount = await connection.getAccountInfo(destination, 'finalized');
assert.ok(destinationAccount && !destinationAccount.executable, 'Refund destination is unavailable');
assert.ok(destinationAccount.owner.equals(SystemProgram.programId), 'Refund destination is not system-owned');

const [sourceBefore, destinationBefore, latest] = await Promise.all([
  connection.getBalance(payer.publicKey, 'finalized'),
  connection.getBalance(destination, 'finalized'),
  connection.getLatestBlockhash('finalized'),
]);
const provisionalLamports = BigInt(sourceBefore) - reserveLamports;
assert.ok(provisionalLamports > 0n, 'No excess deployer SOL remains');

function compileMessage(lamports) {
  return new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: destination,
      lamports,
    })],
  }).compileToV0Message();
}

const provisionalMessage = compileMessage(provisionalLamports);
const feeResult = await connection.getFeeForMessage(provisionalMessage, 'confirmed');
assert.ok(Number.isSafeInteger(feeResult.value) && feeResult.value > 0, 'Could not determine transfer fee');
const feeLamports = BigInt(feeResult.value);
const transferLamports = provisionalLamports - feeLamports;
assert.ok(transferLamports > 0n, 'No refundable SOL remains after fee and reserve');

const transaction = new VersionedTransaction(compileMessage(transferLamports));
transaction.sign([payer]);
const simulation = await connection.simulateTransaction(transaction, {
  commitment: 'confirmed',
  replaceRecentBlockhash: false,
  sigVerify: true,
});
assert.equal(
  simulation.value.err,
  null,
  `Mainnet refund simulation failed:\n${(simulation.value.logs || []).join('\n')}`,
);

const preview = {
  ok: true,
  simulationOnly: process.env.SUBMIT_MAINNET_REFUND !== destination.toBase58(),
  source: payer.publicKey.toBase58(),
  destination: destination.toBase58(),
  sourceBeforeLamports: sourceBefore.toString(),
  destinationBeforeLamports: destinationBefore.toString(),
  transferLamports: transferLamports.toString(),
  transferSol: Number(transferLamports) / 1_000_000_000,
  feeLamports: feeLamports.toString(),
  retainedLamports: reserveLamports.toString(),
  retainedSol: Number(reserveLamports) / 1_000_000_000,
  unitsConsumed: simulation.value.unitsConsumed ?? null,
};
if (preview.simulationOnly) {
  console.log(JSON.stringify({
    ...preview,
    submitWith: `SUBMIT_MAINNET_REFUND=${destination.toBase58()}`,
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
assert.equal(confirmation.value.err, null, 'Mainnet refund failed confirmation');

const [sourceAfter, destinationAfter] = await Promise.all([
  connection.getBalance(payer.publicKey, 'finalized'),
  connection.getBalance(destination, 'finalized'),
]);
assert.equal(BigInt(sourceAfter), reserveLamports, 'Temporary deployer did not retain the exact reserve');
assert.equal(
  BigInt(destinationAfter) - BigInt(destinationBefore),
  transferLamports,
  'Refund destination balance delta differs',
);
console.log(JSON.stringify({
  ...preview,
  simulationOnly: false,
  submitted: true,
  signature,
  sourceAfterLamports: sourceAfter.toString(),
  destinationAfterLamports: destinationAfter.toString(),
}, null, 2));

