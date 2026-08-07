import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import * as splToken from '@solana/spl-token';
import web3 from '@solana/web3.js';

const { AnchorProvider, Program, setProvider } = anchor;
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } = web3;
const { AuthorityType, TOKEN_PROGRAM_ID, createMint, getMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority } = splToken;
const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
assert.match(
  provider.connection.rpcEndpoint,
  /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
  'local:bootstrap may only initialize a localhost validator',
);
assert.equal(provider.connection.rpcEndpoint, 'http://127.0.0.1:8899');
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed local wallet is required');
const program = new Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [miningPool] = PublicKey.findProgramAddressSync([Buffer.from('mining_pool')], PROGRAM_ID);
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool')], PROGRAM_ID);
const [liquidityGate] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_gate')], PROGRAM_ID);
if (await provider.connection.getAccountInfo(config, 'confirmed')) {
  const state = await program.account.protocolConfig.fetch(config);
  const gateExists = await provider.connection.getAccountInfo(liquidityGate, 'confirmed');
  if (state.paused && state.admin.equals(payer.publicKey)) {
    const gateState = gateExists ? await program.account.liquidityGate.fetch(liquidityGate) : null;
    await program.methods.setPaused(false).accounts({
      config,
      liquidityGate: gateState ? liquidityGate : null,
      liquidityPool: gateState?.pool ?? null,
      baseVault: null,
      quoteVault: null,
      admin: payer.publicKey,
    }).rpc();
  }
  console.log(JSON.stringify({
    ok: true,
    status: state.paused && state.admin.equals(payer.publicKey) ? 'reactivated' : 'already initialized',
    config: config.toBase58(),
  }, null, 2));
  process.exit(0);
}
const programAccount = await provider.connection.getAccountInfo(PROGRAM_ID, 'confirmed');
assert.ok(programAccount?.owner.equals(LOADER), 'Deploy the upgradeable program first');
const programData = new PublicKey(programAccount.data.subarray(4, 36));
const mint = await createMint(provider.connection, payer, payer.publicKey, null, 9, undefined, undefined, TOKEN_PROGRAM_ID);
const launchAccount = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, payer.publicKey);
await mintTo(provider.connection, payer, mint, launchAccount.address, payer, 100_000_000_000n);
const authoritySignature = await setAuthority(
  provider.connection,
  payer,
  mint,
  payer,
  AuthorityType.MintTokens,
  config,
  [],
  { commitment: 'confirmed' },
  TOKEN_PROGRAM_ID,
);
await provider.connection.confirmTransaction(authoritySignature, 'confirmed');
let launchMint = await getMint(provider.connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
for (let attempt = 0; attempt < 10 && !launchMint.mintAuthority?.equals(config); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  launchMint = await getMint(provider.connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
}
assert.equal(launchMint.freezeAuthority, null, 'MYNE must launch without freeze authority');
assert.ok(
  launchMint.mintAuthority?.equals(config),
  `MYNE mint authority must be the config PDA (${config.toBase58()}); found ${launchMint.mintAuthority?.toBase58() ?? 'none'}`,
);
// Keep the two settlement receivers distinct even in the disposable local
// environment. This exercises the same account metas as production and makes
// direct fee balances observable without conflating them with transaction fees.
const buybackRole = Keypair.generate();
const adminFeeRole = Keypair.generate();
for (const role of [buybackRole, adminFeeRole]) {
  const signature = await provider.connection.requestAirdrop(role.publicKey, LAMPORTS_PER_SOL);
  await provider.connection.confirmTransaction(signature, 'confirmed');
}
await program.methods.initializeProtocol({
  randomnessAuthority: payer.publicKey,
  randomnessProgram: PublicKey.default,
  buybackWallet: buybackRole.publicKey,
  motherlodeWallet: payer.publicKey,
  adminFeeWallet: adminFeeRole.publicKey,
}).accounts({
  config, miningPool, stakePool, payer: payer.publicKey, program: PROGRAM_ID, programData,
  upgradeAuthority: payer.publicKey, mint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
}).rpc();
await program.methods.setPaused(false).accounts({
  config,
  liquidityGate: null,
  liquidityPool: null,
  baseVault: null,
  quoteVault: null,
  admin: payer.publicKey,
}).rpc();
console.log(JSON.stringify({
  ok: true,
  status: 'active-local',
  programId: PROGRAM_ID.toBase58(),
  config: config.toBase58(),
  mint: mint.toBase58(),
  buybackWallet: buybackRole.publicKey.toBase58(),
  adminFeeWallet: adminFeeRole.publicKey.toBase58(),
}, null, 2));
