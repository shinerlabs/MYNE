import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

import anchor from '@anchor-lang/core';
import web3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';

import { demoCoverageBids } from './demo-miner-bids.mjs';
import { autoPlanExecutionFunding } from './auto-plan-executor.mjs';

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
const autoPlanPda = (authority) => PublicKey.findProgramAddressSync(
  [Buffer.from('auto_plan'), authority.toBuffer()],
  PROGRAM_ID,
)[0];
const BET_RECEIPT_ACCOUNT_BYTES = 468;
const AUTO_REWARD_BURN = 1;

const demoWalletPath = isDevnet
  ? '.localnet/devnet-demo-wallets.json'
  : '.localnet/local-demo-wallets.json';
let savedDemoWallets = null;
try {
  savedDemoWallets = JSON.parse(await readFile(demoWalletPath, 'utf8'));
} catch { /* first run on this cluster creates a fresh controlled set */ }
const savedMinerKeys = Array.isArray(savedDemoWallets?.miners) ? savedDemoWallets.miners : [];
const savedStakerKeys = Array.isArray(savedDemoWallets?.stakers) ? savedDemoWallets.stakers : [];
const demoMiners = Array.from({ length: 10 }, (_, index) => {
  const keypair = savedMinerKeys[index]
    ? Keypair.fromSecretKey(Uint8Array.from(savedMinerKeys[index]))
    : Keypair.generate();
  if (index < 5) {
    // Five persistent demo miners cover every local tile with the same per-tile amount. Devnet
    // partitions the 25 tiles between them to control faucet spend. The shared amount still moves
    // from 10x-20x between rounds, but equal-looking winning bids are now exactly equal.
    return { keypair, coverAll: true, autoBurn: index < 4, bids: {} };
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
if (!savedDemoWallets) {
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
    const signature = await provider.connection.requestAirdrop(
      authority,
      Math.round(amountSol * LAMPORTS_PER_SOL),
    );
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

/**
 * Keep four real Auto-burn plans aligned with the controlled equal-bid cohort.
 *
 * These are not presentation flags: the plan commits reward_mode=1 into every
 * receipt before the winner is known. Once that receipt is settled, the program
 * adds its MYNE reward to both the owner's permanent burn principal and the
 * pool-wide total_burn counter, with 5x added to total reward weight.
 */
async function prepareDemoAutoBurnPlans(roundId) {
  const receiptRent = BigInt(await provider.connection.getMinimumBalanceForRentExemption(
    BET_RECEIPT_ACCOUNT_BYTES,
  ));
  const fundingRounds = isDevnet ? 1n : 2n;
  for (const [index, demo] of demoMiners.entries()) {
    if (!demo.autoBurn) continue;
    const authority = demo.keypair.publicKey;
    const bids = demoCoverageBids(roundId, index, isDevnet);
    const rawAmounts = Array.from({ length: 25 }, (_, tile) => BigInt(bids[tile] ?? 0));
    const amounts = rawAmounts.map((amount) => new BN(amount.toString()));
    const perRound = rawAmounts.reduce((sum, amount) => sum + amount, 0n);
    const requiredBalance = perRound + receiptRent;
    const targetBalance = requiredBalance * fundingRounds;
    const autoPlan = autoPlanPda(authority);
    let plan = await program.account.autoPlan.fetchNullable(autoPlan);

    if (!plan) {
      await fundDemoWallet(authority, Number(targetBalance) / LAMPORTS_PER_SOL + 0.05);
      await program.methods
        .createAutoPlan(amounts, new BN(targetBalance.toString()), AUTO_REWARD_BURN)
        .accounts({ config, autoPlan, authority, systemProgram: SystemProgram.programId })
        .signers([demo.keypair])
        .rpc();
      plan = await program.account.autoPlan.fetch(autoPlan);
      log('demo-auto-burn-created', {
        miner: index + 1,
        authority: authority.toBase58(),
        balanceLamports: plan.balanceLamports.toString(),
      });
    } else {
      const currentAmounts = plan.amounts.map((amount) => BigInt(amount.toString()));
      const amountsChanged = currentAmounts.some((amount, tile) => amount !== rawAmounts[tile]);
      if (!plan.active || Number(plan.rewardMode?.toString()) !== AUTO_REWARD_BURN || amountsChanged) {
        await program.methods
          .configureAutoPlan(amounts, true, AUTO_REWARD_BURN)
          .accounts({ config, autoPlan, authority })
          .signers([demo.keypair])
          .rpc();
      }
    }

    const balance = BigInt(plan.balanceLamports.toString());
    if (balance < requiredBalance) {
      const topUp = targetBalance - balance;
      await fundDemoWallet(authority, Number(topUp) / LAMPORTS_PER_SOL + 0.05);
      await program.methods
        .fundAutoPlan(new BN(topUp.toString()))
        .accounts({ autoPlan, authority, systemProgram: SystemProgram.programId })
        .signers([demo.keypair])
        .rpc();
      log('demo-auto-burn-funded', {
        miner: index + 1,
        authority: authority.toBase58(),
        lamports: topUp.toString(),
      });
    }
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
  const roundState = await program.account.round.fetch(round);
  const randomnessAccount = roundState.randomnessAccount.equals(PublicKey.default)
    ? null
    : roundState.randomnessAccount;
  const limit = Math.min(demoMiners.length, Number(process.env.DEMO_MINER_LIMIT || demoMiners.length));
  for (const [index, demo] of demoMiners.slice(0, limit).entries()) {
    // The first four demo miners enter through execute_auto_plan below. Sending
    // a normal deploy as well would create an accumulate receipt and make the
    // UI's Auto-burn treatment dishonest.
    if (demo.autoBurn) continue;
    const authority = demo.keypair.publicKey;
    const nonce = roundId;
    const receipt = receiptPda(roundId, authority, nonce);
    if (submittedReceipts.has(receipt.toBase58())) continue;
    const bids = demo.coverAll
      ? demoCoverageBids(roundId, index, isDevnet)
      : demo.bids;
    const amounts = Array.from({ length: 25 }, (_, tile) => new BN(String(bids[tile] ?? 0)));
    try {
      await program.methods.deploy(new BN(roundId.toString()), new BN(nonce.toString()), amounts).accounts({
        config,
        miner: minerPda(authority),
        round,
        receipt,
        randomnessAccount,
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

/**
 * Localnet has no production Supabase indexer, so complete every settled
 * receipt here. settle_receipt is permissionless, but all writable PDAs and
 * the SOL beneficiary remain constrained to the immutable receipt authority.
 * It handles both reward modes and is replay-safe through claimed/refunded.
 */
async function settleLocalReceipts(roundId) {
  if (!isLocalnet || roundId < 0n) return;
  const round = roundPda(roundId);
  const roundState = await program.account.round.fetchNullable(round);
  if (!roundState?.settled) return;
  if (BigInt(roundState.processedReceipts.toString()) >= BigInt(roundState.totalReceipts.toString())) return;
  const rows = await program.account.betReceipt.all();
  const receipts = rows.filter(({ account }) => (
    BigInt(account.roundId.toString()) === roundId
    && !account.claimed
    && !account.refunded
  ));
  for (const { publicKey: receipt, account } of receipts) {
    const beneficiary = account.authority;
    try {
      await program.methods.settleReceipt().accounts({
        config,
        miningPool,
        stakePool,
        miner: minerPda(beneficiary),
        stakePosition: stakePositionPda(beneficiary),
        round,
        receipt,
        beneficiary,
        executor: payer.publicKey,
      }).rpc();
      log('demo-receipt-settled', {
        roundId: roundId.toString(),
        authority: beneficiary.toBase58(),
        rewardMode: Number(account.rewardMode),
      });
    } catch (error) {
      log('demo-receipt-settle-error', {
        roundId: roundId.toString(),
        authority: beneficiary.toBase58(),
        message: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
    }
  }
}

async function executeAutoPlans(roundId) {
  const round = roundPda(roundId);
  const plans = await program.account.autoPlan.all();
  const autoPlanStakePool = await program.account.stakePool.fetch(stakePool);
  const receiptRent = BigInt(await provider.connection.getMinimumBalanceForRentExemption(
    BET_RECEIPT_ACCOUNT_BYTES,
  ));
  for (const { publicKey: autoPlan, account: plan } of plans) {
    const total = plan.amounts.reduce((sum, amount) => sum + BigInt(amount.toString()), 0n);
    const rewardMode = Number(plan.rewardMode ?? 0);
    const reinvestSol = (rewardMode & 2) !== 0;
    const stakePosition = stakePositionPda(plan.authority);
    const position = reinvestSol
      ? await program.account.stakePosition.fetchNullable(stakePosition)
      : null;
    const funding = autoPlanExecutionFunding({
      rewardMode,
      balanceLamports: plan.balanceLamports,
      pendingSol: position?.pendingSol ?? 0,
      rewardPerWeight: autoPlanStakePool.rewardPerWeight,
      rewardWeight: position?.rewardWeight ?? 0,
      rewardDebt: position?.rewardDebt ?? 0,
      requiredLamports: total + receiptRent,
    });
    if (!plan.active
        || !funding.executable
        || BigInt(plan.lastRound.toString()) === roundId) continue;
    const nonce = BigInt(plan.nextNonce.toString());
    const receipt = receiptPda(roundId, plan.authority, nonce);
    if (await provider.connection.getAccountInfo(receipt, 'confirmed')) continue;
    const instructions = [];
    if (reinvestSol && funding.pendingSol > 0n) {
      instructions.push(await program.methods.reinvestAutoPlanRewards().accounts({
        config, autoPlan, stakePool, stakePosition, executor: payer.publicKey,
      }).instruction());
    }
    instructions.push(await program.methods.executeAutoPlan(
      new BN(roundId.toString()), new BN(nonce.toString()),
    ).accounts({
      config, autoPlan, miner: minerPda(plan.authority), round, receipt,
      randomnessAccount: null, executor: payer.publicKey,
      systemProgram: SystemProgram.programId,
    }).instruction());
    const transaction = new Transaction().add(...instructions);
    await provider.sendAndConfirm(transaction, []);
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
    assert.equal(Number(configState.version), 6, 'Local keeper requires protocol fee schedule v6');
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
    // Settle the newest completed rounds before preparing the next deployments.
    // This is what makes pool.total_burn—and therefore every staking stat—rise
    // as Auto-burn miners earn MYNE.
    if (isLocalnet) {
      for (let offset = 0n; offset < 4n && currentRoundId >= offset; offset += 1n) {
        await settleLocalReceipts(currentRoundId - offset);
      }
    }
    if (!round || now >= Number(round.bettingEndsAt)) return;
    await prepareDemoAutoBurnPlans(currentRoundId);
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
