/**
 * Create the canonical MYNE mint and its entire 100 MYNE genesis supply in one
 * atomic transaction. The transaction is simulation-only unless every exact
 * address confirmation is present.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SOLANA_MAINNET_GENESIS_HASH } from './production-network-policy.mjs';

const DECIMALS = 9;
const GENESIS_BASE_UNITS = 100_000_000_000n;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
}

async function readKeypair(path, label) {
  const secret = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(Array.isArray(secret) && secret.length === 64, `${label} must contain a 64-byte keypair`);
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const rpcUrl = requiredEnv('MAINNET_RPC_URL');
const payer = await readKeypair(requiredEnv('ANCHOR_WALLET'), 'ANCHOR_WALLET');
const mint = await readKeypair(requiredEnv('MYNE_MINT_KEYPAIR'), 'MYNE_MINT_KEYPAIR');
const destinationOwner = new PublicKey(requiredEnv('MAINNET_LIQUIDITY_WALLET'));
const mintAddress = mint.publicKey.toBase58();

assert.notEqual(payer.publicKey.toBase58(), mintAddress, 'Payer and mint signer must be distinct');
assert.equal(
  process.env.CONFIRM_CREATE_MYNE_MINT,
  mintAddress,
  `Set CONFIRM_CREATE_MYNE_MINT=${mintAddress} after reviewing the mint signer`,
);
assert.equal(
  process.env.CONFIRM_LIQUIDITY_DESTINATION,
  destinationOwner.toBase58(),
  `Set CONFIRM_LIQUIDITY_DESTINATION=${destinationOwner.toBase58()} after reviewing the recipient`,
);

const connection = new Connection(rpcUrl, 'confirmed');
const genesisHash = await connection.getGenesisHash();
assert.equal(genesisHash, SOLANA_MAINNET_GENESIS_HASH, 'RPC is not Solana Mainnet');
assert.equal(
  process.env.CONFIRM_SOLANA_GENESIS_HASH,
  genesisHash,
  `Set CONFIRM_SOLANA_GENESIS_HASH=${genesisHash} after independently checking the RPC`,
);

const destination = getAssociatedTokenAddressSync(
  mint.publicKey,
  destinationOwner,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
);

async function verifyExisting() {
  const [mintState, destinationState] = await Promise.all([
    getMint(connection, mint.publicKey, 'confirmed', TOKEN_PROGRAM_ID),
    getAccount(connection, destination, 'confirmed', TOKEN_PROGRAM_ID),
  ]);
  assert.equal(mintState.decimals, DECIMALS, 'Existing MYNE mint has the wrong decimals');
  assert.equal(mintState.supply, GENESIS_BASE_UNITS, 'Existing MYNE mint has the wrong supply');
  assert.equal(mintState.freezeAuthority, null, 'Existing MYNE mint has a freeze authority');
  assert.ok(mintState.mintAuthority?.equals(payer.publicKey), 'Existing mint authority is not the deployer');
  assert.ok(destinationState.owner.equals(destinationOwner), 'Liquidity token account owner differs');
  assert.ok(destinationState.mint.equals(mint.publicKey), 'Liquidity token account mint differs');
  assert.equal(destinationState.amount, GENESIS_BASE_UNITS, 'Liquidity wallet does not hold exactly 100 MYNE');
  return {
    ok: true,
    alreadyExists: true,
    mint: mintAddress,
    liquidityOwner: destinationOwner.toBase58(),
    liquidityTokenAccount: destination.toBase58(),
    amountMyne: '100.000000000',
    freezeAuthority: null,
    mintAuthority: payer.publicKey.toBase58(),
  };
}

if (await connection.getAccountInfo(mint.publicKey, 'confirmed')) {
  console.log(JSON.stringify(await verifyExisting(), null, 2));
  process.exit(0);
}

const rentLamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE, 'confirmed');
const latest = await connection.getLatestBlockhash('confirmed');
const instructions = [
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint.publicKey,
    lamports: rentLamports,
    space: MINT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  }),
  createInitializeMint2Instruction(
    mint.publicKey,
    DECIMALS,
    payer.publicKey,
    null,
    TOKEN_PROGRAM_ID,
  ),
  createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    destination,
    destinationOwner,
    mint.publicKey,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ),
  createMintToCheckedInstruction(
    mint.publicKey,
    destination,
    payer.publicKey,
    GENESIS_BASE_UNITS,
    DECIMALS,
    [],
    TOKEN_PROGRAM_ID,
  ),
];
const message = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: latest.blockhash,
  instructions,
}).compileToV0Message();
const transaction = new VersionedTransaction(message);
transaction.sign([payer, mint]);

const simulation = await connection.simulateTransaction(transaction, {
  commitment: 'confirmed',
  replaceRecentBlockhash: false,
  sigVerify: true,
});
assert.equal(
  simulation.value.err,
  null,
  `MYNE mint simulation failed:\n${(simulation.value.logs || []).join('\n')}`,
);

if (process.env.SUBMIT_MAINNET_MINT !== mintAddress) {
  console.log(JSON.stringify({
    ok: true,
    simulationOnly: true,
    mint: mintAddress,
    payer: payer.publicKey.toBase58(),
    liquidityOwner: destinationOwner.toBase58(),
    liquidityTokenAccount: destination.toBase58(),
    amountMyne: '100.000000000',
    decimals: DECIMALS,
    freezeAuthority: null,
    rentLamports,
    unitsConsumed: simulation.value.unitsConsumed ?? null,
    submitWith: `SUBMIT_MAINNET_MINT=${mintAddress}`,
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
}, 'confirmed');
assert.equal(confirmation.value.err, null, 'MYNE mint transaction failed confirmation');

console.log(JSON.stringify({
  ...await verifyExisting(),
  alreadyExists: false,
  submitted: true,
  signature,
}, null, 2));
