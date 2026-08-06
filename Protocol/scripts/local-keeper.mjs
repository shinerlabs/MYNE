import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import anchor from '@anchor-lang/core';
import web3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';

const { AnchorProvider, BN, Program, setProvider } = anchor;
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } = web3;
const { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, transfer } = splToken;
const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const DEVNET_KEEPER_CONFIRMATION = PROGRAM_ID.toBase58();
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
const isDevnet = /^https:\/\/api\.devnet\.solana\.com\/?$/i.test(provider.connection.rpcEndpoint);
if (isDevnet) {
  assert.equal(
    process.env.ALLOW_DEVNET_KEEPER,
    DEVNET_KEEPER_CONFIRMATION,
    `Set ALLOW_DEVNET_KEEPER=${DEVNET_KEEPER_CONFIRMATION} to authorize Devnet demo transactions`,
  );
} else {
  assert.match(
    provider.connection.rpcEndpoint,
    /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
    'The demo keeper only accepts localnet or explicitly authorized Devnet',
  );
}
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed local wallet is required');

const program = new Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [miningPool] = PublicKey.findProgramAddressSync([Buffer.from('mining_pool')], PROGRAM_ID);
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool')], PROGRAM_ID);
const u64Buffer = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value.toString()));
  return buffer;
};
const roundPda = (roundId) => PublicKey.findProgramAddressSync(
  [Buffer.from('round'), u64Buffer(roundId)],
  PROGRAM_ID,
)[0];
const minerPda = (authority) => PublicKey.findProgramAddressSync(
  [Buffer.from('miner'), authority.toBuffer()],
  PROGRAM_ID,
)[0];
const stakePositionPda = (authority) => PublicKey.findProgramAddressSync(
  [Buffer.from('stake_position'), authority.toBuffer()],
  PROGRAM_ID,
)[0];
const receiptPda = (roundId, authority, nonce) => PublicKey.findProgramAddressSync([
  Buffer.from('bet'),
  u64Buffer(roundId),
  authority.toBuffer(),
  u64Buffer(nonce),
], PROGRAM_ID)[0];

const demoMiners = Array.from({ length: 10 }, (_, index) => {
  if (index < 5) {
    // Five persistent local miners cover every tile. Their per-tile amount is randomized between
    // 10x and 20x the 0.001 SOL demo base on each round, keeping every tile active and ensuring
    // the local viewer always has a populated previous-round roster.
    return { keypair: Keypair.generate(), coverAll: true, bids: {} };
  }
  const firstTile = (index * 2) % 25;
  const secondTile = (index * 5 + 6) % 25;
  return {
    keypair: Keypair.generate(),
    bids: { [firstTile]: 30_000_000, [secondTile]: 20_000_000 },
  };
});
const demoStakers = Array.from({ length: 3 }, () => ({ keypair: Keypair.generate(), amount: 5_000_000_000n }));

const log = (event, values = {}) => console.log(JSON.stringify({
  at: new Date().toISOString(),
  event,
  ...values,
}));

async function chainTime() {
  const slot = await provider.connection.getSlot('confirmed');
  return await provider.connection.getBlockTime(slot) ?? Math.floor(Date.now() / 1000);
}

async function prepareDemoMiners() {
  for (const [index, demo] of demoMiners.entries()) {
    const authority = demo.keypair.publicKey;
    const signature = await provider.connection.requestAirdrop(authority, (isDevnet ? 2 : 10) * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(signature, 'confirmed');
    const miner = minerPda(authority);
    if (!(await provider.connection.getAccountInfo(miner, 'confirmed'))) {
      await program.methods.registerMiner(PublicKey.default).accounts({
        config,
        miningPool,
        stakePool,
        miner,
        stakePosition: stakePositionPda(authority),
        referrerMiner: null,
        authority,
        systemProgram: SystemProgram.programId,
      }).signers([demo.keypair]).rpc();
    }
    log('demo-miner-ready', { index: index + 1, authority: authority.toBase58() });
  }
}

async function prepareDemoStakers() {
  const configState = await program.account.protocolConfig.fetch(config);
  const mint = configState.mint;
  const payerTokens = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, payer.publicKey);
  const vaultTokens = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, stakePool, true);
  for (const [index, demo] of demoStakers.entries()) {
    const authority = demo.keypair.publicKey;
    const signature = await provider.connection.requestAirdrop(authority, (isDevnet ? 2 : 5) * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(signature, 'confirmed');
    const miner = minerPda(authority);
    const stakePosition = stakePositionPda(authority);
    if (!(await provider.connection.getAccountInfo(miner, 'confirmed'))) {
      await program.methods.registerMiner(PublicKey.default).accounts({
        config, miningPool, stakePool, miner, stakePosition, referrerMiner: null,
        authority, systemProgram: SystemProgram.programId,
      }).signers([demo.keypair]).rpc();
    }
    const ownerTokens = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, authority);
    if ((await splToken.getAccount(provider.connection, ownerTokens.address)).amount < demo.amount) {
      await transfer(provider.connection, payer, payerTokens.address, ownerTokens.address, payer.publicKey, demo.amount, [], undefined, TOKEN_PROGRAM_ID);
    }
    const position = await program.account.stakePosition.fetch(stakePosition);
    if (BigInt(position.standardPrincipal.toString()) < demo.amount) {
      await program.methods.stakeStandard(new BN(demo.amount.toString())).accounts({
        config, stakePool, stakePosition, ownerTokens: ownerTokens.address, vaultTokens: vaultTokens.address,
        mint, authority, tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([demo.keypair]).rpc();
    }
    log('demo-staker-ready', { index: index + 1, authority: authority.toBase58(), myne: demo.amount.toString() });
  }
}

async function ensureRound(roundId, now, configState) {
  const round = roundPda(roundId);
  const existing = await program.account.round.fetchNullable(round);
  if (existing) return existing;
  const openedAt = Number(configState.initializedAt.toString())
    + Number(roundId) * Number(configState.roundDurationSeconds.toString());
  const bettingEndsAt = openedAt + Number(configState.bettingDurationSeconds.toString());
  if (now < openedAt || now >= bettingEndsAt) return null;
  await program.methods.openRound(new BN(roundId.toString())).accounts({
    config,
    round,
    payer: payer.publicKey,
    systemProgram: SystemProgram.programId,
  }).rpc();
  log('round-opened', { roundId: roundId.toString(), bettingEndsAt });
  return program.account.round.fetch(round);
}

async function deployDemoMiners(roundId) {
  const round = roundPda(roundId);
  for (const [index, demo] of demoMiners.entries()) {
    const authority = demo.keypair.publicKey;
    const nonce = roundId;
    const receipt = receiptPda(roundId, authority, nonce);
    if (await provider.connection.getAccountInfo(receipt, 'confirmed')) continue;
    const bids = demo.coverAll
      ? Object.fromEntries(Array.from({ length: 25 }, (_, tile) => [
        tile,
        (10 + (randomBytes(1)[0] % 11)) * 1_000_000,
      ]))
      : demo.bids;
    const amounts = Array.from({ length: 25 }, (_, tile) => new BN(String(bids[tile] ?? 0)));
    await program.methods.deploy(new BN(roundId.toString()), new BN(nonce.toString()), amounts).accounts({
      config,
      miner: minerPda(authority),
      round,
      receipt,
      authority,
      systemProgram: SystemProgram.programId,
    }).signers([demo.keypair]).rpc();
    log('demo-miner-deployed', {
      roundId: roundId.toString(),
      miner: index + 1,
      authority: authority.toBase58(),
      lamports: Object.values(bids).reduce((sum, amount) => sum + amount, 0),
    });
  }
}

async function executeAutoPlans(roundId) {
  const round = roundPda(roundId);
  const plans = await program.account.autoPlan.all();
  for (const { publicKey: autoPlan, account: plan } of plans) {
    const total = plan.amounts.reduce((sum, amount) => sum + BigInt(amount.toString()), 0n);
    if (!plan.active || BigInt(plan.balanceLamports.toString()) < total || BigInt(plan.lastRound.toString()) === roundId) continue;
    const nonce = BigInt(plan.nextNonce.toString());
    const receipt = receiptPda(roundId, plan.authority, nonce);
    if (await provider.connection.getAccountInfo(receipt, 'confirmed')) continue;
    await program.methods.executeAutoPlan(new BN(roundId.toString()), new BN(nonce.toString())).accounts({
      config,
      autoPlan,
      miner: minerPda(plan.authority),
      round,
      receipt,
      executor: payer.publicKey,
      systemProgram: SystemProgram.programId,
    }).rpc();
    log('auto-plan-executed', { roundId: roundId.toString(), authority: plan.authority.toBase58(), lamports: total.toString() });
  }
}

async function settleReadyRound(roundId, now, configState) {
  const round = roundPda(roundId);
  const state = await program.account.round.fetchNullable(round);
  if (!state || state.settled) return;
  if (now < Number(state.settlesAt) || now >= Number(state.refundAt)) return;
  const randomness = [...randomBytes(32)];
  await program.methods.settleRound(randomness).accounts({
    config,
    stakePool,
    round,
    randomnessAuthority: payer.publicKey,
    buybackWallet: configState.buybackWallet,
    adminFeeWallet: configState.adminFeeWallet,
  }).rpc();
  const settled = await program.account.round.fetch(round);
  log('round-settled', {
    roundId: roundId.toString(),
    winningTile: Number(settled.winningTile) + 1,
    mode: settled.soloMode ? 'solo' : 'split',
    deployedLamports: settled.grossDeployedLamports.toString(),
  });
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const [configState, now] = await Promise.all([
      program.account.protocolConfig.fetch(config),
      chainTime(),
    ]);
    assert.equal(configState.paused, false, 'Protocol is paused');
    const initializedAt = BigInt(configState.initializedAt.toString());
    const duration = BigInt(configState.roundDurationSeconds.toString());
    const nowBig = BigInt(now);
    if (nowBig < initializedAt) return;
    const currentRoundId = (nowBig - initializedAt) / duration;
    const round = await ensureRound(currentRoundId, now, configState);
    await settleReadyRound(currentRoundId, now, configState);
    if (currentRoundId > 0n) await settleReadyRound(currentRoundId - 1n, now, configState);
    if (!round || now >= Number(round.bettingEndsAt)) return;
    await deployDemoMiners(currentRoundId);
    await executeAutoPlans(currentRoundId);
  } catch (error) {
    log('keeper-error', { message: error instanceof Error ? error.message.split('\n')[0] : String(error) });
  } finally {
    ticking = false;
  }
}

if (isDevnet) {
  const configState = await program.account.protocolConfig.fetch(config);
  if (configState.paused) {
    await program.methods.setPaused(false).accounts({ config, admin: payer.publicKey }).rpc();
    log('devnet-unpaused', { admin: payer.publicKey.toBase58() });
  }
}

await prepareDemoMiners();
await prepareDemoStakers();
log('keeper-started', { rpc: provider.connection.rpcEndpoint, programId: PROGRAM_ID.toBase58() });
await tick();
// Check the boundary twice per second: the result window is intentionally only five seconds, so a
// one-second keeper cadence would consume a noticeable part of the confirmed winner display.
setInterval(() => { void tick(); }, 500);
