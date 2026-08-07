/**
 * Atomically retire the abandoned pre-launch MYNE mint and assign a fresh,
 * fully-metadated 100-MYNE mint to the paused protocol config.
 *
 * Simulation is the default. Submission requires the exact new mint address
 * in SUBMIT_MAINNET_MINT_MIGRATION.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  TokenStandard,
  fetchMetadataFromSeeds,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata';
import { publicKey } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createSetAuthorityInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
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
import { SOLANA_MAINNET_GENESIS_HASH } from './production-network-policy.mjs';

const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const LEGACY_PRELAUNCH_MINT = new PublicKey('2NtsuCtsXCU1f5dwGcNPyBLnKx5tRHsCFfUt6py3dwWS');
const GENESIS_BASE_UNITS = 100_000_000_000n;
const METADATA_URI = 'https://www.myne.supply/token-metadata.json';
const COMPUTE_UNIT_LIMIT = 300_000;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function confirm(name, expected) {
  assert.equal(process.env[name], expected, `Set ${name}=${expected} after reviewing the value`);
}

async function readKeypair(path) {
  const secret = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(Array.isArray(secret) && secret.length === 64, 'ANCHOR_WALLET must contain a keypair');
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const rpcUrl = requiredEnv('MAINNET_RPC_URL');
const admin = await readKeypair(requiredEnv('ANCHOR_WALLET'));
const newMint = new PublicKey(requiredEnv('MAINNET_MINT_ADDRESS'));
const liquidityOwner = new PublicKey(requiredEnv('MAINNET_LIQUIDITY_WALLET'));
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [miningPool] = PublicKey.findProgramAddressSync([Buffer.from('mining_pool')], PROGRAM_ID);
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool')], PROGRAM_ID);
const [migration] = PublicKey.findProgramAddressSync(
  [Buffer.from('prelaunch_mint_migration')],
  PROGRAM_ID,
);
const liquidityTokens = getAssociatedTokenAddressSync(
  newMint,
  liquidityOwner,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
);

confirm('CONFIRM_SOLANA_GENESIS_HASH', SOLANA_MAINNET_GENESIS_HASH);
confirm('CONFIRM_MAINNET_CONFIG', config.toBase58());
confirm('CONFIRM_PRELAUNCH_MINT_MIGRATION', migration.toBase58());
confirm('CONFIRM_DEPRECATE_PREVIOUS_MINT', LEGACY_PRELAUNCH_MINT.toBase58());
confirm('CONFIRM_MAINNET_MINT', newMint.toBase58());
confirm('CONFIRM_LIQUIDITY_DESTINATION', liquidityOwner.toBase58());

const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
assert.equal(await connection.getGenesisHash(), SOLANA_MAINNET_GENESIS_HASH, 'RPC is not Mainnet');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
assert.equal(idl.address, PROGRAM_ID.toBase58(), 'IDL program address differs');
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(admin),
  { commitment: 'confirmed', preflightCommitment: 'confirmed' },
);
const program = new anchor.Program(idl, provider);

async function fetchProtocolState() {
  const [configState, miningState, stakeState] = await Promise.all([
    program.account.protocolConfig.fetch(config, 'finalized'),
    program.account.miningPool.fetch(miningPool, 'finalized'),
    program.account.stakePool.fetch(stakePool, 'finalized'),
  ]);
  return { configState, miningState, stakeState };
}

function assertEmptyPrelaunchState({ configState, miningState, stakeState }) {
  assert.equal(configState.version, 6, 'Protocol is not version 6');
  assert.equal(configState.paused, true, 'Protocol must remain paused');
  assert.ok(configState.admin.equals(admin.publicKey), 'Signer is not protocol admin');
  assert.ok(configState.mint.equals(LEGACY_PRELAUNCH_MINT), 'Configured legacy mint differs');
  assert.equal(configState.totalEmittedBaseUnits.toString(), GENESIS_BASE_UNITS.toString());
  assert.equal(configState.virtualBurnBaseUnits.toString(), '0');
  assert.equal(configState.motherlodeBaseUnits.toString(), '0');
  assert.equal(configState.motherlodeLamports.toString(), '0');
  assert.ok(configState.adminFeeWallet.equals(liquidityOwner), 'Liquidity owner must be the admin-fee wallet');
  for (const [name, value] of Object.entries({
    miningAssets: miningState.totalUnclaimed,
    miningShares: miningState.rewardPerUnclaimed,
    miningUndistributed: miningState.undistributedBaseUnits,
    activeStakers: stakeState.activeStakers,
    standardStake: stakeState.totalStandard,
    burnStake: stakeState.totalBurn,
    stakeWeight: stakeState.totalWeight,
    rewardPerWeight: stakeState.rewardPerWeight,
    stakeUndistributed: stakeState.undistributedLamports,
    stakeFunded: stakeState.totalFundedLamports,
    stakeClaimed: stakeState.totalClaimedLamports,
  })) assert.equal(value.toString(), '0', `${name} is not empty`);
}

const state = await fetchProtocolState();
assertEmptyPrelaunchState(state);
const [oldMintState, newMintState, liquidityState] = await Promise.all([
  getMint(connection, LEGACY_PRELAUNCH_MINT, 'finalized', TOKEN_PROGRAM_ID),
  getMint(connection, newMint, 'finalized', TOKEN_PROGRAM_ID),
  getAccount(connection, liquidityTokens, 'finalized', TOKEN_PROGRAM_ID),
]);
assert.equal(oldMintState.decimals, 9);
assert.ok(oldMintState.supply > 0n && oldMintState.supply <= GENESIS_BASE_UNITS, 'Legacy supply is invalid');
assert.ok(oldMintState.mintAuthority?.equals(config), 'Protocol PDA does not control the legacy mint');
assert.equal(oldMintState.freezeAuthority, null, 'Legacy mint unexpectedly has freeze authority');
assert.equal(newMintState.decimals, 9, 'New mint must use nine decimals');
assert.equal(newMintState.supply, GENESIS_BASE_UNITS, 'New supply must be exactly 100 MYNE');
assert.equal(newMintState.freezeAuthority, null, 'New mint must not have freeze authority');
assert.ok(newMintState.mintAuthority?.equals(admin.publicKey), 'Admin must still control the new mint');
assert.ok(liquidityState.owner.equals(liquidityOwner), 'Liquidity token owner differs');
assert.ok(liquidityState.mint.equals(newMint), 'Liquidity token mint differs');
assert.equal(liquidityState.amount, GENESIS_BASE_UNITS, 'Liquidity wallet must hold all 100 MYNE');

const umi = createUmi(rpcUrl).use(mplTokenMetadata());
const metadata = await fetchMetadataFromSeeds(
  umi,
  { mint: publicKey(newMint.toBase58()) },
  { commitment: 'finalized' },
);
assert.equal(metadata.name, 'MYNE', 'Metaplex name differs');
assert.equal(metadata.symbol, 'MYNE', 'Metaplex symbol differs');
assert.equal(metadata.uri, METADATA_URI, 'Metaplex URI differs');
assert.equal(metadata.sellerFeeBasisPoints, 0, 'Metaplex seller fee must be zero');
assert.equal(metadata.tokenStandard.value, TokenStandard.Fungible, 'Token standard is not Fungible');

const existingMigration = await program.account.prelaunchMintMigration.fetchNullable(
  migration,
  'finalized',
);
if (existingMigration) {
  assert.ok(existingMigration.previousMint.equals(LEGACY_PRELAUNCH_MINT));
  assert.ok(existingMigration.newMint.equals(newMint));
  const migratedConfig = await program.account.protocolConfig.fetch(config, 'finalized');
  assert.ok(migratedConfig.mint.equals(newMint), 'Config did not retain the migrated mint');
  console.log(JSON.stringify({
    ok: true,
    alreadyMigrated: true,
    previousMint: LEGACY_PRELAUNCH_MINT.toBase58(),
    newMint: newMint.toBase58(),
    migration: migration.toBase58(),
    metadata: metadata.publicKey,
  }, null, 2));
  process.exit(0);
}

const migrateInstruction = await program.methods.migratePrelaunchMint().accounts({
  config,
  miningPool,
  stakePool,
  migration,
  previousMint: LEGACY_PRELAUNCH_MINT,
  newMint,
  liquidityTokens,
  admin: admin.publicKey,
  tokenProgram: TOKEN_PROGRAM_ID,
  systemProgram: SystemProgram.programId,
}).instruction();
const latest = await connection.getLatestBlockhash('finalized');
const message = new TransactionMessage({
  payerKey: admin.publicKey,
  recentBlockhash: latest.blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    createSetAuthorityInstruction(
      newMint,
      admin.publicKey,
      AuthorityType.MintTokens,
      config,
      [],
      TOKEN_PROGRAM_ID,
    ),
    migrateInstruction,
  ],
}).compileToV0Message();
const transaction = new VersionedTransaction(message);
transaction.sign([admin]);
const simulation = await connection.simulateTransaction(transaction, {
  commitment: 'confirmed',
  replaceRecentBlockhash: false,
  sigVerify: true,
});
assert.equal(
  simulation.value.err,
  null,
  `Pre-launch mint migration simulation failed:\n${(simulation.value.logs || []).join('\n')}`,
);

const preview = {
  ok: true,
  simulationOnly: process.env.SUBMIT_MAINNET_MINT_MIGRATION !== newMint.toBase58(),
  previousMint: LEGACY_PRELAUNCH_MINT.toBase58(),
  previousSupplyBaseUnits: oldMintState.supply.toString(),
  previousMintAuthorityAfter: null,
  newMint: newMint.toBase58(),
  newSupplyBaseUnits: newMintState.supply.toString(),
  newMintAuthorityAfter: config.toBase58(),
  metadata: metadata.publicKey,
  metadataUri: metadata.uri,
  liquidityOwner: liquidityOwner.toBase58(),
  liquidityTokenAccount: liquidityTokens.toBase58(),
  migration: migration.toBase58(),
  unitsConsumed: simulation.value.unitsConsumed ?? null,
};
if (preview.simulationOnly) {
  console.log(JSON.stringify({
    ...preview,
    submitWith: `SUBMIT_MAINNET_MINT_MIGRATION=${newMint.toBase58()}`,
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
assert.equal(confirmation.value.err, null, 'Pre-launch mint migration failed confirmation');
const [migratedConfig, retiredMint, controlledMint, migrationState] = await Promise.all([
  program.account.protocolConfig.fetch(config, 'finalized'),
  getMint(connection, LEGACY_PRELAUNCH_MINT, 'finalized', TOKEN_PROGRAM_ID),
  getMint(connection, newMint, 'finalized', TOKEN_PROGRAM_ID),
  program.account.prelaunchMintMigration.fetch(migration, 'finalized'),
]);
assert.ok(migratedConfig.mint.equals(newMint), 'Config mint migration failed');
assert.equal(retiredMint.mintAuthority, null, 'Legacy mint authority was not revoked');
assert.ok(controlledMint.mintAuthority?.equals(config), 'New mint authority is not the config PDA');
assert.ok(migrationState.previousMint.equals(LEGACY_PRELAUNCH_MINT));
assert.ok(migrationState.newMint.equals(newMint));
console.log(JSON.stringify({ ...preview, simulationOnly: false, submitted: true, signature }, null, 2));
