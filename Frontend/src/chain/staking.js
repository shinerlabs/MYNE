import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

import { connection, getAccount } from './client.js';
import { parseEther } from './units.js';
import { apyPercent } from './staking-apy.js';
import {
  asBn, decodeProtocolAccount, derivePda, fetchProtocolAccount, getProtocolConfig,
  getWritableProgram, protocolPdas, protocolProgramId, sendInstructions,
} from './anchor-client.js';

export const TIER_FLEX = 0;
export const TIER_BURN = 1;
export const toWei = (value) => parseEther(String(value || 0));
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const toBig = (value) => BigInt(value?.toString?.() ?? value ?? 0);
let apySample = null;
let lastApy = { aprPct: null, aprStatus: 'window', windowMinutes: 0, rewardPerMinuteSol: 0 };
export const APY_WINDOW_MINUTES = 30;
// 8-byte discriminator + the fixed StakePosition fields in state.rs.
const STAKE_POSITION_ACCOUNT_SIZE = 105;
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
  const delta = toBig(pool.rewardPerWeight) - toBig(position.rewardDebt);
  return toBig(position.pendingSol) + (toBig(position.rewardWeight) * delta) / 1_000_000_000_000_000_000n;
}

export async function readStaking(account = getAccount()) {
  const [config, pool] = await Promise.all([
    getProtocolConfig(), fetchProtocolAccount('StakePool', protocolPdas.stakePool),
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
  return {
    stocks: [], hasClaimableStocks: false,
    totalStaked: toBig(pool?.totalStandard) + toBig(pool?.totalBurn), totalWeight,
    walletBullion, flexStaked, burnStaked, weight,
    pendingEth: await livePending(position, pool), claimedEth: 0n,
    lifetimeEth: await livePending(position, pool), pendingBullion: 0n,
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
  return sendInstructions(instructions);
}
export const stake = stakeInstruction;

export async function requestUnstake(amount) {
  const account = getAccount(); const authority = new PublicKey(account); const { program } = await getWritableProgram();
  return sendInstructions([await program.methods.requestUnstake(asBn(amount)).accounts({ stakePool: protocolPdas.stakePool, stakePosition: positionPda(account), authority }).instruction()]);
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
  return sendInstructions([await program.methods.claimStakingRewards().accounts({ stakePool: protocolPdas.stakePool, stakePosition: positionPda(account), authority }).instruction()]);
}

export async function readStakingMetrics() {
  const [pool, positionAccounts] = await Promise.all([
    fetchProtocolAccount('StakePool', protocolPdas.stakePool),
    protocolProgramId
      ? connection.getProgramAccounts(protocolProgramId, {
          commitment: 'confirmed', filters: [{ dataSize: STAKE_POSITION_ACCOUNT_SIZE }],
        })
      : [],
  ]);
  const standard = Number(toBig(pool?.totalStandard)) / 1e9;
  const burn = Number(toBig(pool?.totalBurn)) / 1e9;
  const totalStakedPrincipal = standard + burn;
  // Rewards accrue by pool weight: standard MYNE contributes 1× and burn-staked MYNE 5×.
  // APY for a standard position must therefore use total weight, not raw principal.
  const totalWeight = Number(toBig(pool?.totalWeight)) / 1e9;
  const fundedSol = Number(toBig(pool?.totalFundedLamports)) / 1e9;
  const now = Date.now();
  if (!apySample) {
    apySample = { at: now, fundedSol };
    lastApy = { aprPct: null, aprStatus: 'window', windowMinutes: 0, rewardPerMinuteSol: 0 };
  } else {
    const windowMinutes = (now - apySample.at) / 60_000;
    if (windowMinutes >= APY_WINDOW_MINUTES) {
      const rewardDeltaSol = Math.max(0, fundedSol - apySample.fundedSol);
      const rewardPerMinuteSol = rewardDeltaSol / windowMinutes;
      lastApy = {
        aprPct: apyPercent(rewardPerMinuteSol, totalWeight),
        aprStatus: totalStakedPrincipal > 0 ? 'live' : 'stake',
        windowMinutes,
        rewardPerMinuteSol,
      };
      apySample = { at: now, fundedSol };
    }
  }
  const stakers = positionAccounts.reduce((count, entry) => {
    try {
      const position = decodeProtocolAccount('StakePosition', entry.account.data);
      return count + (toBig(position?.rewardWeight) > 0n ? 1 : 0);
    } catch {
      return count;
    }
  }, 0);
  return {
    totalStakedPrincipal, flexStaked: standard, burnStaked: burn,
    totalWeight,
    rewardsPoolEth: Number(toBig(pool?.totalFundedLamports) - toBig(pool?.totalClaimedLamports)) / 1e9,
    queuedLegacyStockEth: 0, rewardMode: 'eth', stakers, aprPct: lastApy.aprPct,
    aprStatus: lastApy.aprStatus, aprWindowDays: lastApy.windowMinutes / 1440,
    rewardsToStakersEth: lastApy.rewardPerMinuteSol * 1440,
    aprMinWeightGld: 1000,
  };
}
export async function readStakingHistory() {
  const metrics = await readStakingMetrics();
  return { points: [{ time: Math.floor(Date.now() / 1000), value: metrics.totalStakedPrincipal }], current: metrics.totalStakedPrincipal };
}
