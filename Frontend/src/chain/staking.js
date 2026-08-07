import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

import { connection, getAccount } from './client.js';
import { parseEther } from './units.js';
import { apyPercent } from './staking-apy.js';
import { totalStakedBaseUnits, totalStakedMyne } from './staking-totals.js';
import { loadStakingRewardWindow } from './rounds-index.js';
import { getLiveMynePerSol } from '../sol-price.js';
import {
  asBn, derivePda, fetchProtocolAccount, getProtocolConfig,
  getWritableProgram, protocolPdas, sendInstructions,
} from './anchor-client.js';

export const TIER_FLEX = 0;
export const TIER_BURN = 1;
export const toWei = (value) => parseEther(String(value || 0));
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const toBig = (value) => BigInt(value?.toString?.() ?? value ?? 0);
export const APY_WINDOW_MINUTES = 30;
const STAKE_POOL_CACHE_MS = 4_000;
let stakePoolCache = null;
let stakePoolCacheAt = 0;
let stakePoolRequest = null;
let stakePoolCacheGeneration = 0;

const baseUnitsToTokens = (value) => {
  const units = toBig(value);
  return Number(units / 1_000_000_000n) + Number(units % 1_000_000_000n) / 1e9;
};

const invalidateStakePoolCache = () => {
  stakePoolCacheGeneration += 1;
  stakePoolCache = null;
  stakePoolCacheAt = 0;
  // Do not let a pre-transaction in-flight snapshot satisfy the first refresh
  // after a confirmed mutation. Its original callers may still receive it,
  // while new callers start a current read under the new generation.
  stakePoolRequest = null;
};

async function readStakePool() {
  if (stakePoolCache && Date.now() - stakePoolCacheAt < STAKE_POOL_CACHE_MS) return stakePoolCache;
  if (stakePoolRequest) return stakePoolRequest;
  const generation = stakePoolCacheGeneration;
  const request = fetchProtocolAccount('StakePool', protocolPdas.stakePool)
    .then((pool) => {
      // A transaction may have invalidated the cache while this RPC was in
      // flight. Return that snapshot to its original caller, but never publish
      // it as the next caller's current state.
      if (generation === stakePoolCacheGeneration) {
        stakePoolCache = pool;
        stakePoolCacheAt = Date.now();
      }
      return pool;
    })
    .finally(() => {
      if (stakePoolRequest === request) stakePoolRequest = null;
    });
  stakePoolRequest = request;
  return request;
}
const positionPda = (owner) => derivePda('stake_position', new PublicKey(owner));
const minerPda = (owner) => derivePda('miner', new PublicKey(owner));
const associatedToken = (owner, mint) => PublicKey.findProgramAddressSync(
  [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM_ID,
)[0];
const createAtaInstruction = (payer, owner, mint, ata) => new TransactionInstruction({
  programId: ASSOCIATED_TOKEN_PROGRAM_ID,
  keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ],
  data: new Uint8Array(),
});

async function livePending(position, pool) {
  if (!position || !pool || !toBig(position.rewardWeight)) return toBig(position?.pendingSol);
  const currentIndex = toBig(pool.rewardPerWeight);
  const debt = toBig(position.rewardDebt);
  if (currentIndex < debt) throw new Error('Stake reward index is behind the position checkpoint');
  const delta = currentIndex - debt;
  return toBig(position.pendingSol) + (toBig(position.rewardWeight) * delta) / 1_000_000_000_000_000_000n;
}

export async function readStaking(account = getAccount()) {
  const [config, pool] = await Promise.all([
    getProtocolConfig(), readStakePool(),
  ]);
  let position = null;
  let walletBullion = 0n;
  if (account) {
    position = await fetchProtocolAccount('StakePosition', positionPda(account));
    const rows = await connection.getParsedTokenAccountsByOwner(new PublicKey(account), { mint: config.mint }, 'confirmed');
    walletBullion = rows.value.reduce((sum, row) => sum + BigInt(row.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  const flexStaked = toBig(position?.standardPrincipal);
  const burnStaked = toBig(position?.burnPrincipal);
  const weight = toBig(position?.rewardWeight);
  const totalWeight = toBig(pool?.totalWeight);
  const pendingSol = await livePending(position, pool);
  return {
    stocks: [], hasClaimableStocks: false,
    totalStaked: totalStakedBaseUnits(pool?.totalStandard, pool?.totalBurn), totalWeight,
    walletBullion, flexStaked, burnStaked, weight,
    pendingEth: pendingSol,
    // StakePosition intentionally stores only the current pending balance.
    // Claim history is event-derived and not yet part of the production index;
    // null prevents the UI from presenting a fabricated lifetime zero/total.
    claimedEth: null, lifetimeEth: null, pendingBullion: 0n,
    unstakeClaimable: position && BigInt(Math.floor(Date.now() / 1000)) >= toBig(position.cooldownUnlockAt) ? toBig(position.cooldownAmount) : 0n,
    unstakePending: position && BigInt(Math.floor(Date.now() / 1000)) < toBig(position.cooldownUnlockAt) ? toBig(position.cooldownAmount) : 0n,
    share: totalWeight > 0n ? Number((weight * 1_000_000n) / totalWeight) / 10_000 : 0,
  };
}

export async function readStakeAllowance() { return 2n ** 64n - 1n; }
export async function approveStake() { return 'native-spl-transfer-authority'; }

async function stakeInstruction(amount, tier) {
  const account = getAccount();
  if (!account) throw new Error('Connect a Solana wallet first');
  const authority = new PublicKey(account);
  const config = await getProtocolConfig();
  const mint = new PublicKey(config.mint);
  const ownerTokens = associatedToken(authority, mint);
  const vaultTokens = associatedToken(protocolPdas.stakePool, mint);
  if (!(await connection.getAccountInfo(ownerTokens, 'confirmed'))) throw new Error('Your wallet has no MYNE token account');
  const { program } = await getWritableProgram();
  const instructions = [];
  const miner = minerPda(account);
  const stakePosition = positionPda(account);
  if (!(await connection.getAccountInfo(miner, 'confirmed'))) instructions.push(await program.methods.registerMiner(PublicKey.default).accounts({
    config: protocolPdas.config, miningPool: protocolPdas.miningPool, stakePool: protocolPdas.stakePool,
    miner, stakePosition, referrerMiner: null, authority, systemProgram: SystemProgram.programId,
  }).instruction());
  if (!(await connection.getAccountInfo(vaultTokens, 'confirmed'))) instructions.push(createAtaInstruction(authority, protocolPdas.stakePool, mint, vaultTokens));
  const method = tier === TIER_BURN ? program.methods.burnStake(asBn(amount)) : program.methods.stakeStandard(asBn(amount));
  const accounts = tier === TIER_BURN
    ? { config: protocolPdas.config, stakePool: protocolPdas.stakePool, stakePosition, ownerTokens, mint, authority, tokenProgram: TOKEN_PROGRAM_ID }
    : { config: protocolPdas.config, stakePool: protocolPdas.stakePool, stakePosition, ownerTokens, vaultTokens, mint, authority, tokenProgram: TOKEN_PROGRAM_ID };
  instructions.push(await method.accounts(accounts).instruction());
  const signature = await sendInstructions(instructions);
  invalidateStakePoolCache();
  return signature;
}
export const stake = stakeInstruction;

export async function requestUnstake(amount) {
  const account = getAccount(); const authority = new PublicKey(account); const { program } = await getWritableProgram();
  const signature = await sendInstructions([await program.methods.requestUnstake(asBn(amount)).accounts({ stakePool: protocolPdas.stakePool, stakePosition: positionPda(account), authority }).instruction()]);
  invalidateStakePoolCache();
  return signature;
}
export async function withdrawUnstaked() {
  const account = getAccount(); const authority = new PublicKey(account); const config = await getProtocolConfig(); const mint = new PublicKey(config.mint);
  const { program } = await getWritableProgram();
  return sendInstructions([await program.methods.withdrawUnstaked().accounts({
    config: protocolPdas.config, stakePool: protocolPdas.stakePool, stakePosition: positionPda(account),
    ownerTokens: associatedToken(authority, mint), vaultTokens: associatedToken(protocolPdas.stakePool, mint),
    mint, authority, tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction()]);
}
export async function claimStakingRewards() {
  const account = getAccount(); const authority = new PublicKey(account); const { program } = await getWritableProgram();
  const signature = await sendInstructions([await program.methods.claimStakingRewards().accounts({ stakePool: protocolPdas.stakePool, stakePosition: positionPda(account), authority }).instruction()]);
  invalidateStakePoolCache();
  return signature;
}

export async function readStakingMetrics() {
  const [pool, rewardWindow] = await Promise.all([
    readStakePool(),
    loadStakingRewardWindow(APY_WINDOW_MINUTES),
  ]);
  const standard = baseUnitsToTokens(pool?.totalStandard);
  const burn = baseUnitsToTokens(pool?.totalBurn);
  const totalStakedPrincipal = totalStakedMyne(pool?.totalStandard, pool?.totalBurn);
  // Rewards accrue by pool weight: standard MYNE contributes 1× and burn-staked MYNE 5×.
  // APY for a standard position must therefore use total weight, not raw principal.
  const totalWeight = baseUnitsToTokens(pool?.totalWeight);
  const mynePerSol = getLiveMynePerSol();
  const windowMinutes = rewardWindow?.complete ? rewardWindow.windowMinutes : 0;
  const rewardPerMinuteSol = rewardWindow?.complete
    ? baseUnitsToTokens(rewardWindow.rewardLamports) / rewardWindow.windowMinutes
    : 0;
  let aprStatus = 'live';
  if (!(totalWeight > 0)) aprStatus = 'stake';
  else if (!(mynePerSol > 0)) aprStatus = 'price';
  else if (!rewardWindow?.complete) aprStatus = 'window';
  const aprPct = aprStatus === 'live'
    ? apyPercent(rewardPerMinuteSol, totalWeight, mynePerSol)
    : null;
  if (aprStatus === 'live' && aprPct === null) aprStatus = 'math';
  const stakers = Number(toBig(pool?.activeStakers));
  const rewardPoolLamports = toBig(pool?.totalFundedLamports) - toBig(pool?.totalClaimedLamports);
  return {
    totalStakedPrincipal, flexStaked: standard, burnStaked: burn,
    totalWeight,
    rewardsPoolEth: baseUnitsToTokens(rewardPoolLamports),
    queuedLegacyStockEth: 0, rewardMode: 'eth', stakers, aprPct,
    aprStatus, aprWindowDays: windowMinutes / 1440,
    rewardsToStakersEth: rewardPerMinuteSol * 1440,
    aprWindowRounds: rewardWindow?.rounds ?? 0,
  };
}
export async function readStakingHistory() {
  const metrics = await readStakingMetrics();
  return { points: [{ time: Math.floor(Date.now() / 1000), value: metrics.totalStakedPrincipal }], current: metrics.totalStakedPrincipal };
}
