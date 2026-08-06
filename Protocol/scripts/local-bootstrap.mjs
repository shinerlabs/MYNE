import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import * as splToken from '@solana/spl-token';
import web3 from '@solana/web3.js';

const { AnchorProvider, Program, setProvider } = anchor;
const { PublicKey, SystemProgram } = web3;
const { AuthorityType, TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority } = splToken;
const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
assert.equal(provider.connection.rpcEndpoint, 'http://127.0.0.1:8899');
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed local wallet is required');
const program = new Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [miningPool] = PublicKey.findProgramAddressSync([Buffer.from('mining_pool')], PROGRAM_ID);
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool')], PROGRAM_ID);
if (await provider.connection.getAccountInfo(config, 'confirmed')) {
  const state = await program.account.protocolConfig.fetch(config);
  if (state.paused && state.admin.equals(payer.publicKey)) {
    await program.methods.setPaused(false).accounts({ config, admin: payer.publicKey }).rpc();
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
await setAuthority(provider.connection, payer, mint, payer, AuthorityType.MintTokens, config);
await program.methods.initializeProtocol({
  randomnessAuthority: payer.publicKey,
  buybackWallet: payer.publicKey,
  motherlodeWallet: payer.publicKey,
  adminFeeWallet: payer.publicKey,
}).accounts({
  config, miningPool, stakePool, payer: payer.publicKey, program: PROGRAM_ID, programData,
  upgradeAuthority: payer.publicKey, mint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
}).rpc();
await program.methods.setPaused(false).accounts({ config, admin: payer.publicKey }).rpc();
console.log(JSON.stringify({ ok: true, status: 'active', programId: PROGRAM_ID.toBase58(), config: config.toBase58(), mint: mint.toBase58() }, null, 2));
