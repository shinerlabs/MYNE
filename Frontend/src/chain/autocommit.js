import { PublicKey, SystemProgram } from '@solana/web3.js';

import { connection, getAccount } from './client.js';
import { GRID } from './config.js';
import { parseEther } from './units.js';
import { asBn, derivePda, fetchProtocolAccount, getWritableProgram, protocolPdas, sendInstructions } from './anchor-client.js';

// Kept for UI compatibility only. The Solana plan has no play-count ceiling: it executes once per
// round until its prepaid balance can no longer cover the configured deployment.
export const UNLIMITED_PLAYS = 4294967295;
export const MAX_PLAYS_PER_EXECUTION = 1n;
const planPda = (account) => derivePda('auto_plan', new PublicKey(account));
const toBig = (value) => BigInt(value?.toString?.() ?? value ?? 0);
export const AUTO_PLAN_FUNDING_BPS = 9_000n;
const BPS_DENOMINATOR = 10_000n;

export function evenAllocation(count) {
  if (count < 1) return [];
  const base = Math.floor(10000 / count);
  const values = Array(count).fill(base);
  values[count - 1] += 10000 - base * count;
  return values;
}

export async function readPlan(account = getAccount()) {
  if (!account) return null;
  const plan = await fetchProtocolAccount('AutoPlan', planPda(account));
  if (!plan) return null;
  const amounts = plan.amounts.map(toBig);
  return {
    canClaim: false,
    enabled: plan.active,
    nextRoundId: toBig(plan.lastRound) === 2n ** 64n - 1n ? 0n : toBig(plan.lastRound) + 1n,
    playsRemaining: UNLIMITED_PLAYS,
    unlimited: true,
    amountPerPlay: amounts.reduce((sum, amount) => sum + amount, 0n),
    balance: toBig(plan.balanceLamports),
    autoClaim: false,
    rewardMode: Number(plan.rewardMode ?? 0) === 1 ? 'burn' : 'accumulate',
    tiles: amounts.flatMap((amount, index) => amount > 0n ? [index + 1] : []),
    amounts,
  };
}

const BET_RECEIPT_ACCOUNT_BYTES = 468;
const FEE_PARAMS_CACHE_MS = 60_000;
let feeParamsCache = null;
let feeParamsCacheAt = 0;

export async function readFeeParams({ force = false } = {}) {
  if (!force && feeParamsCache && Date.now() - feeParamsCacheAt < FEE_PARAMS_CACHE_MS) {
    return feeParamsCache;
  }
  const receiptRent = await connection.getMinimumBalanceForRentExemption(BET_RECEIPT_ACCOUNT_BYTES);
  feeParamsCache = { accountDeposit: 0n, maxFee: BigInt(receiptRent) };
  feeParamsCacheAt = Date.now();
  return feeParamsCache;
}
export function requiredDeposit({ amountPerPlay, fundRounds, maxFee = 0n }) {
  return (amountPerPlay + maxFee) * BigInt(fundRounds);
}

/** Keep 10% of the live wallet balance outside an Auto-round transfer for rent and tx fees. */
export function maxAutoPlanFundingLamports(walletBalanceLamports) {
  const balance = toBig(walletBalanceLamports);
  if (balance <= 0n) return 0n;
  return (balance * AUTO_PLAN_FUNDING_BPS) / BPS_DENOMINATOR;
}

export function affordableAutoPlanRounds({ walletBalance, amountPerPlay, maxFee }) {
  const perRound = toBig(amountPerPlay) + toBig(maxFee);
  return perRound > 0n ? maxAutoPlanFundingLamports(walletBalance) / perRound : 0n;
}

async function assertFundingWithinWalletBudget(value, authority) {
  const funding = toBig(value);
  if (funding <= 0n) return;
  // Re-read immediately before instruction construction; the render balance can be stale after
  // another tab or wallet action. This is the transaction-boundary enforcement, not just UI copy.
  const liveBalance = BigInt(await connection.getBalance(authority, 'confirmed'));
  const maximum = maxAutoPlanFundingLamports(liveBalance);
  if (funding > maximum) {
    throw new Error(`Auto-round funding is limited to 90% of this wallet's SOL balance (${Number(maximum) / 1e9} SOL available)`);
  }
}

export async function configurePlan({ tiles, ethPerTile, deposit, rewardMode = 'accumulate' }) {
  const account = getAccount();
  if (!account) throw new Error('Connect a Solana wallet first');
  const authority = new PublicKey(account);
  await assertFundingWithinWalletBudget(deposit, authority);
  const amounts = Array(GRID).fill(0n);
  const perTile = parseEther(String(ethPerTile));
  tiles.forEach((tile) => { amounts[Number(tile) - 1] = perTile; });
  const autoPlan = planPda(account);
  const { program } = await getWritableProgram();
  const exists = await fetchProtocolAccount('AutoPlan', autoPlan);
  const instructions = [];
  const rewardModeCode = rewardMode === 'burn' ? 1 : 0;
  if (!exists) {
    instructions.push(await program.methods.createAutoPlan(amounts.map(asBn), asBn(deposit), rewardModeCode).accounts({
      config: protocolPdas.config, autoPlan, authority, systemProgram: SystemProgram.programId,
    }).instruction());
  } else {
    instructions.push(await program.methods.configureAutoPlan(amounts.map(asBn), true, rewardModeCode).accounts({
      config: protocolPdas.config, autoPlan, authority,
    }).instruction());
    if (deposit > 0n) instructions.push(await program.methods.fundAutoPlan(asBn(deposit)).accounts({
      autoPlan, authority, systemProgram: SystemProgram.programId,
    }).instruction());
  }
  return sendInstructions(instructions);
}

export async function depositToPlan(value) {
  const account = getAccount();
  const authority = new PublicKey(account);
  await assertFundingWithinWalletBudget(value, authority);
  const { program } = await getWritableProgram();
  return sendInstructions([await program.methods.fundAutoPlan(asBn(value)).accounts({
    autoPlan: planPda(account), authority, systemProgram: SystemProgram.programId,
  }).instruction()]);
}
export async function cancelPlan() {
  const account = getAccount();
  const authority = new PublicKey(account);
  const { program } = await getWritableProgram();
  return sendInstructions([await program.methods.cancelAutoPlan().accounts({
    config: protocolPdas.config, autoPlan: planPda(account), authority,
  }).instruction()]);
}
export const withdrawFromPlan = cancelPlan;
export async function isClaimDelegate() { return false; }
export async function approveClaimDelegate() { throw new Error('Auto-claim is not enabled on Solana; receipt claims remain user-signed'); }
