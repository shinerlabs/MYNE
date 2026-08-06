import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import * as splToken from '@solana/spl-token';
import web3 from '@solana/web3.js';

const { AnchorProvider, Program, setProvider } = anchor;
const { Keypair, PublicKey, SystemProgram } = web3;
const {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
} = splToken;

const PROGRAM_ID_TEXT = 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e';
const PROGRAM_ID = new PublicKey(PROGRAM_ID_TEXT);
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);
const GENESIS_BASE_UNITS = 100_000_000_000n;
const MINT_KEYPAIR_PATH = process.env.DEVNET_MINT_KEYPAIR || '.localnet/devnet-mint.json';

assert.equal(
  process.env.CONFIRM_DEVNET_INITIALIZE,
  PROGRAM_ID_TEXT,
  `Set CONFIRM_DEVNET_INITIALIZE=${PROGRAM_ID_TEXT} to authorize devnet transactions`,
);
assert.ok(process.env.DEVNET_RANDOMNESS_AUTHORITY, 'Set DEVNET_RANDOMNESS_AUTHORITY to a devnet public key');
const randomnessAuthority = new PublicKey(process.env.DEVNET_RANDOMNESS_AUTHORITY);
assert.ok(!randomnessAuthority.equals(PublicKey.default), 'Randomness authority cannot be the default key');
for (const name of ['DEVNET_BUYBACK_WALLET', 'DEVNET_MOTHERLODE_WALLET']) {
  assert.ok(process.env[name], `Set ${name} to the intended devnet fee destination`);
}

const idl = JSON.parse(
  await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'),
);
const provider = AnchorProvider.env();
setProvider(provider);
assert.equal(await provider.connection.getGenesisHash(), DEVNET_GENESIS_HASH, 'RPC is not Solana devnet');
const payer = provider.wallet.payer;
assert.ok(payer, 'Initialization requires a file-backed Anchor wallet');

const program = new Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [miningPool] = PublicKey.findProgramAddressSync([Buffer.from('mining_pool')], PROGRAM_ID);
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool')], PROGRAM_ID);
const existingConfig = await provider.connection.getAccountInfo(config, 'confirmed');
if (existingConfig) {
  console.log(`Config ${config.toBase58()} is already initialized; run pnpm test:devnet:smoke.`);
  process.exit(0);
}

const programAccount = await provider.connection.getAccountInfo(PROGRAM_ID, 'confirmed');
assert.ok(programAccount?.executable, 'Deploy the program before initialization');
assert.ok(programAccount.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID));
const programData = new PublicKey(programAccount.data.subarray(4, 36));
const programDataAccount = await provider.connection.getAccountInfo(programData, 'confirmed');
assert.ok(programDataAccount, 'ProgramData account is missing');
assert.equal(programDataAccount.data[12], 1, 'Program has no upgrade authority');
const upgradeAuthority = new PublicKey(programDataAccount.data.subarray(13, 45));
assert.ok(upgradeAuthority.equals(payer.publicKey), 'Configured wallet is not the program upgrade authority');

let mintKeypair;
try {
  mintKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(MINT_KEYPAIR_PATH, 'utf8'))));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  mintKeypair = Keypair.generate();
  await mkdir(new URL('../.localnet/', import.meta.url), { recursive: true });
  await writeFile(MINT_KEYPAIR_PATH, JSON.stringify([...mintKeypair.secretKey]), { mode: 0o600, flag: 'wx' });
}

const mintAccount = await provider.connection.getAccountInfo(mintKeypair.publicKey, 'confirmed');
if (!mintAccount) {
  await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    9,
    mintKeypair,
    undefined,
    TOKEN_PROGRAM_ID,
  );
}

let mint = await getMint(provider.connection, mintKeypair.publicKey, 'confirmed', TOKEN_PROGRAM_ID);
const launchAccount = await getOrCreateAssociatedTokenAccount(
  provider.connection,
  payer,
  mintKeypair.publicKey,
  payer.publicKey,
);
if (mint.supply === 0n) {
  await mintTo(
    provider.connection,
    payer,
    mintKeypair.publicKey,
    launchAccount.address,
    payer,
    GENESIS_BASE_UNITS,
  );
  mint = await getMint(provider.connection, mintKeypair.publicKey, 'confirmed', TOKEN_PROGRAM_ID);
}
assert.equal(mint.decimals, 9);
assert.equal(mint.supply, GENESIS_BASE_UNITS);
assert.equal(mint.freezeAuthority, null);
if (mint.mintAuthority?.equals(payer.publicKey)) {
  await setAuthority(
    provider.connection,
    payer,
    mintKeypair.publicKey,
    payer,
    AuthorityType.MintTokens,
    config,
  );
} else {
  assert.ok(mint.mintAuthority?.equals(config), 'Mint authority is neither deployer nor config PDA');
}

const signature = await program.methods
  .initializeProtocol({
    randomnessAuthority,
    buybackWallet: new PublicKey(process.env.DEVNET_BUYBACK_WALLET),
    motherlodeWallet: new PublicKey(process.env.DEVNET_MOTHERLODE_WALLET),
    // Legacy config field retained for account-layout compatibility; no mining fee is sent here.
    adminFeeWallet: payer.publicKey,
  })
  .accounts({
    config,
    miningPool,
    stakePool,
    payer: payer.publicKey,
    program: PROGRAM_ID,
    programData,
    upgradeAuthority: payer.publicKey,
    mint: mintKeypair.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

console.log(JSON.stringify({
  ok: true,
  programId: PROGRAM_ID_TEXT,
  config: config.toBase58(),
  mint: mintKeypair.publicKey.toBase58(),
  signature,
  status: 'paused',
  next: 'pnpm run test:devnet:smoke',
}, null, 2));
