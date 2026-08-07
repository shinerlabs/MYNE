/**
 * Atomically transfer MYNE mint authority to the config PDA and initialize the
 * version-6 Mainnet protocol in its paused state. No protocol activity is
 * enabled by this transaction.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createSetAuthorityInstruction,
  getMint,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  SOLANA_MAINNET_GENESIS_HASH,
  SWITCHBOARD_MAINNET_PROGRAM,
} from './production-network-policy.mjs';

const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const GENESIS_BASE_UNITS = 100_000_000_000n;
const ROLE_START_LAMPORTS = 50_000_000;
const COMPUTE_UNIT_LIMIT = 300_000;

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

function requireConfirmation(name, expected) {
  assert.equal(process.env[name], expected, `Set ${name}=${expected} after reviewing the address`);
}

const rpcUrl = requiredEnv('MAINNET_RPC_URL');
const payer = await readKeypair(requiredEnv('ANCHOR_WALLET'), 'ANCHOR_WALLET');
const randomnessKeypair = await readKeypair(
  requiredEnv('MAINNET_RANDOMNESS_KEYPAIR'),
  'MAINNET_RANDOMNESS_KEYPAIR',
);
const buybackKeypair = await readKeypair(
  requiredEnv('MAINNET_BUYBACK_KEYPAIR'),
  'MAINNET_BUYBACK_KEYPAIR',
);
const mintAddress = requiredEnv('MAINNET_MINT_ADDRESS');
const mint = new PublicKey(mintAddress);
const adminFeeWallet = new PublicKey(requiredEnv('MAINNET_ADMIN_FEE_WALLET'));
const randomnessAuthority = new PublicKey(requiredEnv('MAINNET_RANDOMNESS_AUTHORITY'));
const buybackWallet = new PublicKey(requiredEnv('MAINNET_BUYBACK_WALLET'));
const randomnessProgram = new PublicKey(SWITCHBOARD_MAINNET_PROGRAM);

assert.ok(randomnessKeypair.publicKey.equals(randomnessAuthority), 'Randomness keypair/address mismatch');
assert.ok(buybackKeypair.publicKey.equals(buybackWallet), 'Buyback keypair/address mismatch');
assert.ok(!randomnessAuthority.equals(buybackWallet), 'Randomness and buyback roles must differ');
assert.ok(!randomnessAuthority.equals(adminFeeWallet), 'Randomness and admin roles must differ');
assert.ok(!buybackWallet.equals(adminFeeWallet), 'Buyback and admin roles must differ');

const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [miningPool] = PublicKey.findProgramAddressSync([Buffer.from('mining_pool')], PROGRAM_ID);
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool')], PROGRAM_ID);

requireConfirmation('CONFIRM_MAINNET_INITIALIZE', PROGRAM_ID.toBase58());
requireConfirmation('CONFIRM_MAINNET_MINT', mint.toBase58());
requireConfirmation('CONFIRM_MAINNET_CONFIG', config.toBase58());
requireConfirmation('CONFIRM_MAINNET_ADMIN_FEE_WALLET', adminFeeWallet.toBase58());
requireConfirmation('CONFIRM_MAINNET_RANDOMNESS_AUTHORITY', randomnessAuthority.toBase58());
requireConfirmation('CONFIRM_MAINNET_BUYBACK_WALLET', buybackWallet.toBase58());

const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
const genesisHash = await connection.getGenesisHash();
assert.equal(genesisHash, SOLANA_MAINNET_GENESIS_HASH, 'RPC is not Solana Mainnet');
requireConfirmation('CONFIRM_SOLANA_GENESIS_HASH', genesisHash);

const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
assert.equal(idl.address, PROGRAM_ID.toBase58(), 'IDL program address differs');
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(payer),
  { commitment: 'confirmed', preflightCommitment: 'confirmed' },
);
const program = new anchor.Program(idl, provider);

const programAccount = await connection.getAccountInfo(PROGRAM_ID, 'finalized');
assert.ok(programAccount?.executable, 'MYNE program is not deployed and executable');
assert.ok(programAccount.owner.equals(UPGRADEABLE_LOADER), 'MYNE program has the wrong loader owner');
const programData = new PublicKey(programAccount.data.subarray(4, 36));
const programDataAccount = await connection.getAccountInfo(programData, 'finalized');
assert.ok(programDataAccount, 'ProgramData account is missing');
assert.equal(programDataAccount.data[12], 1, 'Program is immutable or has no upgrade authority');
const upgradeAuthority = new PublicKey(programDataAccount.data.subarray(13, 45));
assert.ok(upgradeAuthority.equals(payer.publicKey), 'Payer is not the deployed program upgrade authority');

const [configInfo, miningPoolInfo, stakePoolInfo] = await connection.getMultipleAccountsInfo(
  [config, miningPool, stakePool],
  'finalized',
);
const existingCount = [configInfo, miningPoolInfo, stakePoolInfo].filter(Boolean).length;
assert.ok(existingCount === 0 || existingCount === 3, 'Only part of the protocol state exists');

async function verifyInitialized() {
  const [state, mintState, roleInfos] = await Promise.all([
    program.account.protocolConfig.fetch(config, 'finalized'),
    getMint(connection, mint, 'finalized', TOKEN_PROGRAM_ID),
    connection.getMultipleAccountsInfo(
      [randomnessAuthority, buybackWallet, adminFeeWallet],
      'finalized',
    ),
  ]);
  assert.equal(state.version, 6, 'Config is not version 6');
  assert.equal(state.paused, true, 'Config must initialize paused');
  assert.ok(state.admin.equals(payer.publicKey), 'Config admin differs');
  assert.ok(state.mint.equals(mint), 'Config mint differs');
  assert.ok(state.randomnessAuthority.equals(randomnessAuthority), 'Randomness authority differs');
  assert.ok(state.randomnessProgram.equals(randomnessProgram), 'Randomness program differs');
  assert.ok(state.buybackWallet.equals(buybackWallet), 'Buyback wallet differs');
  assert.ok(state.motherlodeWallet.equals(adminFeeWallet), 'Reserved Motherlode wallet differs');
  assert.ok(state.adminFeeWallet.equals(adminFeeWallet), 'Admin-fee wallet differs');
  assert.equal(mintState.decimals, 9);
  assert.equal(mintState.supply, GENESIS_BASE_UNITS);
  assert.equal(mintState.freezeAuthority, null);
  assert.ok(mintState.mintAuthority?.equals(config), 'Config PDA is not SPL mint authority');
  for (const [index, name] of ['randomness', 'buyback', 'admin'].entries()) {
    const account = roleInfos[index];
    assert.ok(account, `${name} operational role does not exist`);
    assert.ok(account.owner.equals(SystemProgram.programId), `${name} role is not system-owned`);
  }
  return {
    version: state.version,
    paused: state.paused,
    config: config.toBase58(),
    miningPool: miningPool.toBase58(),
    stakePool: stakePool.toBase58(),
    mint: mint.toBase58(),
    mintAuthority: config.toBase58(),
    programData: programData.toBase58(),
    adminFeeWallet: adminFeeWallet.toBase58(),
    randomnessAuthority: randomnessAuthority.toBase58(),
    randomnessProgram: randomnessProgram.toBase58(),
    buybackWallet: buybackWallet.toBase58(),
  };
}

if (existingCount === 3) {
  console.log(JSON.stringify({ ok: true, alreadyExists: true, ...await verifyInitialized() }, null, 2));
  process.exit(0);
}

const mintState = await getMint(connection, mint, 'finalized', TOKEN_PROGRAM_ID);
assert.equal(mintState.decimals, 9, 'MYNE mint must use 9 decimals');
assert.equal(mintState.supply, GENESIS_BASE_UNITS, 'MYNE supply must be exactly 100 MYNE');
assert.equal(mintState.freezeAuthority, null, 'MYNE mint must have no freeze authority');
assert.ok(mintState.mintAuthority?.equals(payer.publicKey), 'Payer is not current SPL mint authority');

const [adminAccount, randomnessAccount, buybackAccount] = await connection.getMultipleAccountsInfo(
  [adminFeeWallet, randomnessAuthority, buybackWallet],
  'finalized',
);
assert.ok(adminAccount, 'Admin-fee wallet does not exist');
assert.ok(adminAccount.owner.equals(SystemProgram.programId), 'Admin-fee wallet is not system-owned');
for (const [name, account] of [
  ['randomness', randomnessAccount],
  ['buyback', buybackAccount],
]) {
  if (account) assert.ok(account.owner.equals(SystemProgram.programId), `${name} role is not system-owned`);
}

const roleTopUps = [
  [randomnessAuthority, randomnessAccount?.lamports || 0],
  [buybackWallet, buybackAccount?.lamports || 0],
].map(([address, currentLamports]) => ({
  address,
  lamports: Math.max(0, ROLE_START_LAMPORTS - currentLamports),
}));

const initializeInstruction = await program.methods.initializeProtocol({
  randomnessAuthority,
  randomnessProgram,
  buybackWallet,
  motherlodeWallet: adminFeeWallet,
  adminFeeWallet,
}).accounts({
  config,
  miningPool,
  stakePool,
  payer: payer.publicKey,
  program: PROGRAM_ID,
  programData,
  upgradeAuthority: payer.publicKey,
  mint,
  tokenProgram: TOKEN_PROGRAM_ID,
  systemProgram: SystemProgram.programId,
}).instruction();

const latest = await connection.getLatestBlockhash('finalized');
const instructions = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
  ...roleTopUps
    .filter(({ lamports }) => lamports > 0)
    .map(({ address, lamports }) => SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: address,
      lamports,
    })),
  createSetAuthorityInstruction(
    mint,
    payer.publicKey,
    AuthorityType.MintTokens,
    config,
    [],
    TOKEN_PROGRAM_ID,
  ),
  initializeInstruction,
];
const message = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: latest.blockhash,
  instructions,
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
  `Mainnet initialization simulation failed:\n${(simulation.value.logs || []).join('\n')}`,
);

const preview = {
  ok: true,
  simulationOnly: process.env.SUBMIT_MAINNET_INITIALIZE !== config.toBase58(),
  programId: PROGRAM_ID.toBase58(),
  config: config.toBase58(),
  miningPool: miningPool.toBase58(),
  stakePool: stakePool.toBase58(),
  mint: mint.toBase58(),
  nextMintAuthority: config.toBase58(),
  adminFeeWallet: adminFeeWallet.toBase58(),
  randomnessAuthority: randomnessAuthority.toBase58(),
  randomnessProgram: randomnessProgram.toBase58(),
  buybackWallet: buybackWallet.toBase58(),
  roleTopUps: roleTopUps.map(({ address, lamports }) => ({
    address: address.toBase58(),
    lamports,
  })),
  computeUnitLimit: COMPUTE_UNIT_LIMIT,
  unitsConsumed: simulation.value.unitsConsumed ?? null,
};

if (preview.simulationOnly) {
  console.log(JSON.stringify({
    ...preview,
    submitWith: `SUBMIT_MAINNET_INITIALIZE=${config.toBase58()}`,
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
assert.equal(confirmation.value.err, null, 'Mainnet initialization failed confirmation');

console.log(JSON.stringify({
  ...preview,
  simulationOnly: false,
  submitted: true,
  signature,
  ...await verifyInitialized(),
}, null, 2));
