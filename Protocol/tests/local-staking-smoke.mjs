import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import anchor from '@anchor-lang/core';
import { getAccount, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import web3 from '@solana/web3.js';

const { AnchorProvider, BN, Program, setProvider } = anchor;
const { PublicKey, SystemProgram } = web3;
const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const STAKE_AMOUNT = BigInt(process.env.STAKE_AMOUNT_BASE_UNITS || '1000000000');
const REWARD_LAMPORTS = 1_000_000n;

const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
assert.match(
  provider.connection.rpcEndpoint,
  /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
  'The staking smoke test is local-only',
);
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed local wallet is required');
const program = new Program(idl, provider);

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const config = pda(Buffer.from('config'));
const miningPool = pda(Buffer.from('mining_pool'));
const stakePool = pda(Buffer.from('stake_pool'));
const miner = pda(Buffer.from('miner'), payer.publicKey.toBuffer());
const stakePosition = pda(Buffer.from('stake_position'), payer.publicKey.toBuffer());

const configState = await program.account.protocolConfig.fetch(config);
assert.equal(configState.paused, false, 'Protocol must be active for the staking smoke test');
const mint = configState.mint;
const ownerTokens = await getOrCreateAssociatedTokenAccount(
  provider.connection, payer, mint, payer.publicKey,
);
const vaultTokens = await getOrCreateAssociatedTokenAccount(
  provider.connection, payer, mint, stakePool, true,
);
const ownerBefore = await getAccount(provider.connection, ownerTokens.address);
assert.ok(ownerBefore.amount >= STAKE_AMOUNT, 'Local wallet needs at least 1 MYNE');

if (!(await provider.connection.getAccountInfo(miner, 'confirmed'))) {
  await program.methods.registerMiner(PublicKey.default).accounts({
    config, miningPool, stakePool, miner, stakePosition, referrerMiner: null,
    authority: payer.publicKey, systemProgram: SystemProgram.programId,
  }).rpc();
}

const positionBefore = await program.account.stakePosition.fetch(stakePosition);
const poolBefore = await program.account.stakePool.fetch(stakePool);
await program.methods.stakeStandard(new BN(STAKE_AMOUNT.toString())).accounts({
  config, stakePool, stakePosition, ownerTokens: ownerTokens.address, vaultTokens: vaultTokens.address,
  mint, authority: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
}).rpc();
const positionStaked = await program.account.stakePosition.fetch(stakePosition);
assert.equal(
  BigInt(positionStaked.standardPrincipal.toString()),
  BigInt(positionBefore.standardPrincipal.toString()) + STAKE_AMOUNT,
);
assert.equal(
  BigInt(positionStaked.rewardWeight.toString()),
  BigInt(positionBefore.rewardWeight.toString()) + STAKE_AMOUNT,
);

await program.methods.fundStakingRewards(new BN(REWARD_LAMPORTS.toString())).accounts({
  stakePool, funder: payer.publicKey, systemProgram: SystemProgram.programId,
}).rpc();
await program.methods.claimStakingRewards().accounts({
  stakePool, stakePosition, authority: payer.publicKey,
}).rpc();

const [positionAfter, poolAfter, ownerAfter] = await Promise.all([
  program.account.stakePosition.fetch(stakePosition),
  program.account.stakePool.fetch(stakePool),
  getAccount(provider.connection, ownerTokens.address),
]);
assert.equal(positionAfter.pendingSol.toString(), '0');
assert.ok(
  BigInt(poolAfter.totalClaimedLamports.toString()) > BigInt(poolBefore.totalClaimedLamports.toString()),
  'Claim must advance the pool claimed total',
);
assert.equal(ownerAfter.amount, ownerBefore.amount - STAKE_AMOUNT);

console.log(JSON.stringify({
  ok: true,
  authority: payer.publicKey.toBase58(),
  stakedMyne: Number(STAKE_AMOUNT) / 1e9,
  standardPrincipalMyne: Number(positionAfter.standardPrincipal.toString()) / 1e9,
  rewardWeightMyne: Number(positionAfter.rewardWeight.toString()) / 1e9,
  fundedSol: Number(REWARD_LAMPORTS) / 1e9,
  totalClaimedSol: Number(poolAfter.totalClaimedLamports.toString()) / 1e9,
}, null, 2));
