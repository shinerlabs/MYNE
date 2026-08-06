import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

import anchor from '@anchor-lang/core';
import web3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';

const { AnchorProvider, BN, Program, setProvider } = anchor;
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = web3;
const { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, transfer } = splToken;
const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const DEVNET_KEEPER_CONFIRMATION = PROGRAM_ID.toBase58();
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SWITCHBOARD_DEVNET_PROGRAM = 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2';
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
const isLocalnet = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/i.test(provider.connection.rpcEndpoint);
const isDevnet = !isLocalnet;

// An OS-owned loopback listener is an automatically released process lock.
// This prevents two demo keepers racing the same round (the cause of stale
// local round/miner displays during testing) without leaving a stale lock file
// behind after a crash.
const lockPort = Number(process.env.MYNE_DEMO_KEEPER_LOCK_PORT || (isDevnet ? 17778 : 17777));
const processLock = createServer();
await new Promise((resolve, reject) => {
  processLock.once('error', (error) => reject(new Error(
    error?.code === 'EADDRINUSE'
      ? `Another MYNE demo keeper is already running on lock port ${lockPort}`
      : `Unable to acquire MYNE demo keeper lock: ${error.message}`,
  )));
  processLock.listen({ host: '127.0.0.1', port: lockPort, exclusive: true }, resolve);
});
if (isDevnet) {
  assert.equal(
    process.env.ALLOW_DEVNET_KEEPER,
    DEVNET_KEEPER_CONFIRMATION,
    `Set ALLOW_DEVNET_KEEPER=${DEVNET_KEEPER_CONFIRMATION} to authorize Devnet demo transactions`,
  );
  assert.equal(await provider.connection.getGenesisHash(), DEVNET_GENESIS_HASH, 'RPC is not Solana Devnet');
} else {
  assert.ok(isLocalnet, 'The demo keeper only accepts localnet or explicitly authorized Devnet');
}
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed local wallet is required');

const program = new Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [miningPool] = PublicKey.findProgramAddressSync([Buffer.from('mining_pool')], PROGRAM_ID);
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool')], PROGRAM_ID);
const [liquidityGate] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_gate')], PROGRAM_ID);
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

const demoWalletPath = '.localnet/devnet-demo-wallets.json';
let savedDemoWallets = null;
if (isDevnet) {
  try {
    savedDemoWallets = JSON.parse(await readFile(demoWalletPath, 'utf8'));
  } catch { /* first run creates a fresh controlled set */ }
}
const savedMinerKeys = Array.isArray(savedDemoWallets?.miners) ? savedDemoWallets.miners : [];
const savedStakerKeys = Array.isArray(savedDemoWallets?.stakers) ? savedDemoWallets.stakers : [];
const demoMiners = Array.from({ length: 10 }, (_, index) => {
  const keypair = savedMinerKeys[index]
    ? Keypair.fromSecretKey(Uint8Array.from(savedMinerKeys[index]))
    : Keypair.generate();
  if (index < 5) {
    // Five persistent demo miners cover every tile together. Each covers five tiles with a
    // randomized 10x–20x amount over the 0.001 SOL minimum, keeping every round winnable while
    // fitting inside a small Devnet test-wallet balance.
    return { keypair, coverAll: true, bids: {} };
  }
  const firstTile = (index * 2) % 25;
  const secondTile = (index * 5 + 6) % 25;
  return {
    keypair,
    bids: { [firstTile]: 30_000_000, [secondTile]: 20_000_000 },
  };
});
const demoStakers = Array.from({ length: 3 }, (_, index) => ({
  keypair: savedStakerKeys[index]
    ? Keypair.fromSecretKey(Uint8Array.from(savedStakerKeys[index]))
    : Keypair.generate(),
  amount: 5_000_000_000n,
}));
const submittedReceipts = new Set();
if (isDevnet && !savedDemoWallets) {
  await writeFile(demoWalletPath, JSON.stringify({
    miners: demoMiners.map(({ keypair }) => [...keypair.secretKey]),
    stakers: demoStakers.map(({ keypair }) => [...keypair.secretKey]),
  }), { mode: 0o600 });
}

const log = (event, values = {}) => console.log(JSON.stringify({
  at: new Date().toISOString(),
  event,
  ...values,
}));

async function chainTime() {
  const slot = await provider.connection.getSlot('confirmed');
  return await provider.connection.getBlockTime(slot) ?? Math.floor(Date.now() / 1000);
}

async function fundDemoWallet(authority, amountSol) {
  if (isDevnet) {
    const requiredLamports = Math.round(amountSol * LAMPORTS_PER_SOL);
    const existingLamports = await provider.connection.getBalance(authority, 'confirmed');
    if (existingLamports >= requiredLamports) return 'existing';
    // Skip the rate-limited public faucet on Devnet and use the authorized demo payer directly.
    const transaction = new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: authority,
      lamports: requiredLamports - existingLamports,
    }));
    await sendAndConfirmTransaction(provider.connection, transaction, [payer], { commitment: 'confirmed' });
    return 'payer';
  }
  try {
    const signature = await provider.connection.requestAirdrop(authority, amountSol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(signature, 'confirmed');
    return 'faucet';
  } catch (error) {
    if (!isDevnet) throw error;
    // Devnet's public faucet is commonly rate-limited. The authorized demo payer is the
    // controlled fallback; amounts are deliberately small and this path is Devnet-only.
    const transaction = new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: authority,
      lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
    }));
    await sendAndConfirmTransaction(provider.connection, transaction, [payer], { commitment: 'confirmed' });
    return 'payer';
  }
}

async function prepareDemoMiners() {
  for (const [index, demo] of demoMiners.entries()) {
    const authority = demo.keypair.publicKey;
    const funding = await fundDemoWallet(authority, isDevnet ? 0.1 : 10);
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
    log('demo-miner-ready', { index: index + 1, authority: authority.toBase58(), funding });
    await new Promise((resolve) => setTimeout(resolve, isDevnet ? 350 : 0));
  }
}

async function prepareDemoStakers() {
  const configState = await program.account.protocolConfig.fetch(config);
  const mint = configState.mint;
  const payerTokens = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, payer.publicKey);
  const vaultTokens = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, stakePool, true);
  for (const [index, demo] of demoStakers.entries()) {
    const authority = demo.keypair.publicKey;
    const funding = await fundDemoWallet(authority, isDevnet ? 0.05 : 5);
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
    log('demo-staker-ready', { index: index + 1, authority: authority.toBase58(), myne: demo.amount.toString(), funding });
    await new Promise((resolve) => setTimeout(resolve, isDevnet ? 350 : 0));
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
  const limit = Math.min(demoMiners.length, Number(process.env.DEMO_MINER_LIMIT || demoMiners.length));
  for (const [index, demo] of demoMiners.slice(0, limit).entries()) {
    const authority = demo.keypair.publicKey;
    const nonce = roundId;
    const receipt = receiptPda(roundId, authority, nonce);
    if (submittedReceipts.has(receipt.toBase58())) continue;
    const bids = demo.coverAll
      ? Object.fromEntries(Array.from({ length: isDevnet ? 5 : 25 }, (_, offset) => [
        (isDevnet ? index * 5 + offset : offset) % 25,
        (10 + (randomBytes(1)[0] % (isDevnet ? 6 : 11))) * 1_000_000,
      ]))
      : demo.bids;
    const amounts = Array.from({ length: 25 }, (_, tile) => new BN(String(bids[tile] ?? 0)));
    try {
      await program.methods.deploy(new BN(roundId.toString()), new BN(nonce.toString()), amounts).accounts({
        config,
        miner: minerPda(authority),
        round,
        receipt,
        authority,
        systemProgram: SystemProgram.programId,
      }).signers([demo.keypair]).rpc();
      submittedReceipts.add(receipt.toBase58());
      log('demo-miner-deployed', {
        roundId: roundId.toString(),
        miner: index + 1,
        authority: authority.toBase58(),
        lamports: Object.values(bids).reduce((sum, amount) => sum + amount, 0),
      });
    } catch (error) {
      log('demo-miner-deploy-error', { roundId: roundId.toString(), miner: index + 1, message: error instanceof Error ? error.message.split('\\n')[0] : String(error) });
    }
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
  // Switchboard-backed clusters are opened and settled exclusively by the
  // verified Switchboard keeper. This demo process only supplies test bids.
  if (!configState.randomnessProgram.equals(PublicKey.default)) return;
  const round = roundPda(roundId);
  const state = await program.account.round.fetchNullable(round);
  if (!state || state.settled) return;
  if (now < Number(state.settlesAt) || now >= Number(state.refundAt)) return;
  const randomness = [...randomBytes(32)];
  const poolGated = configState.randomnessProgram.toBase58() !== SWITCHBOARD_DEVNET_PROGRAM
    && !configState.randomnessProgram.equals(PublicKey.default);
  await program.methods.settleRound(randomness).accounts({
    config,
    stakePool,
    round,
    liquidityGate: poolGated ? liquidityGate : null,
    liquidityPool: poolGated ? (await program.account.liquidityGate.fetch(liquidityGate)).pool : null,
    randomnessAuthority: payer.publicKey,
    buybackWallet: configState.buybackWallet,
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
    const round = isDevnet
      ? await program.account.round.fetchNullable(roundPda(currentRoundId))
      : await ensureRound(currentRoundId, now, configState);
    await settleReadyRound(currentRoundId, now, configState);
    if (currentRoundId > 0n) await settleReadyRound(currentRoundId - 1n, now, configState);
    if (!round || now >= Number(round.bettingEndsAt)) return;
    await deployDemoMiners(currentRoundId);
    if (!isDevnet) await executeAutoPlans(currentRoundId);
  } catch (error) {
    log('keeper-error', { message: error instanceof Error ? error.message.split('\n')[0] : String(error) });
  } finally {
    ticking = false;
  }
}

if (isDevnet) {
  const configState = await program.account.protocolConfig.fetch(config);
  if (configState.paused) {
    const poolGated = configState.randomnessProgram.toBase58() !== SWITCHBOARD_DEVNET_PROGRAM
      && !configState.randomnessProgram.equals(PublicKey.default);
    const gateState = poolGated ? await program.account.liquidityGate.fetch(liquidityGate) : null;
    await program.methods.setPaused(false).accounts({
      config,
      liquidityGate: poolGated ? liquidityGate : null,
      liquidityPool: poolGated ? gateState.pool : null,
      admin: payer.publicKey,
    }).rpc();
    log('devnet-unpaused', { admin: payer.publicKey.toBase58() });
  }
}

if (process.env.SKIP_DEMO_MINERS !== '1') await prepareDemoMiners();
if (process.env.SKIP_DEMO_STAKERS !== '1') await prepareDemoStakers();
log('keeper-started', { rpc: provider.connection.rpcEndpoint, programId: PROGRAM_ID.toBase58() });
await tick();
// Check the boundary twice per second: the result window is intentionally only five seconds, so a
// one-second keeper cadence would consume a noticeable part of the confirmed winner display.
setInterval(() => { void tick(); }, 500);
