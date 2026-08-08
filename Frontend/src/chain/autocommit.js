import { PublicKey, SystemProgram } from '@solana/web3.js';

import { connection, getAccount } from './client.js';
import { GRID } from './config.js';
import { parseEther } from './units.js';
import {
  asBn, derivePda, fetchProtocolAccount, getProtocolConfig, getWritableProgram, protocolPdas,
  sendInstructions,
} from './anchor-client.js';
import { minerPda, minerRegistrationInstruction } from './miner-registration.js';

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
const AUTO_PLAN_ACCOUNT_BYTES = 267;
const MINER_ACCOUNT_BYTES = 121;
const STAKE_POSITION_ACCOUNT_BYTES = 105;
const BASE_TRANSACTION_FEE_LAMPORTS = 5_000n;
const FEE_PARAMS_CACHE_MS = 60_000;
let feeParamsCache = null;
let feeParamsCacheAt = 0;

export async function readFeeParams({ force = false } = {}) {
  if (!force && feeParamsCache && Date.now() - feeParamsCacheAt < FEE_PARAMS_CACHE_MS) {
    return feeParamsCache;
  }
  const [receiptRent, autoPlanRent, minerRent, stakePositionRent] = await Promise.all([
    BET_RECEIPT_ACCOUNT_BYTES, AUTO_PLAN_ACCOUNT_BYTES, MINER_ACCOUNT_BYTES, STAKE_POSITION_ACCOUNT_BYTES,
  ].map((bytes) => connection.getMinimumBalanceForRentExemption(bytes)));
  const configuredPriorityFee = Number(import.meta.env?.VITE_PRIORITY_FEE_MICROLAMPORTS || 0);
  const priorityMicrolamports = Number.isFinite(configuredPriorityFee)
    ? Math.max(0, Math.min(1_000_000, Math.floor(configuredPriorityFee)))
    : 0;
  const transactionFeeReserve = BASE_TRANSACTION_FEE_LAMPORTS
    + BigInt(Math.ceil((1_400_000 * priorityMicrolamports) / 1_000_000));
  feeParamsCache = {
    accountDeposit: 0n,
    maxFee: BigInt(receiptRent),
    autoPlanRent: BigInt(autoPlanRent),
    minerRent: BigInt(minerRent),
    stakePositionRent: BigInt(stakePositionRent),
    transactionFeeReserve,
  };
  feeParamsCacheAt = Date.now();
  return feeParamsCache;
}
export function requiredDeposit({ amountPerPlay, fundRounds, maxFee = 0n }) {
  return (amountPerPlay + maxFee) * BigInt(fundRounds);
}

export function autoPlanSetupReserve({ hasMiner, hasPlan, feeParams }) {
  return toBig(feeParams?.transactionFeeReserve ?? 0n)
    + (hasPlan ? 0n : toBig(feeParams?.autoPlanRent ?? 0n))
    + (hasMiner ? 0n : toBig(feeParams?.minerRent ?? 0n) + toBig(feeParams?.stakePositionRent ?? 0n));
}

/** Keep 10% of spendable SOL outside plan funding after exact setup costs are reserved. */
export function maxAutoPlanFundingLamports(walletBalanceLamports, setupReserveLamports = 0n) {
  const balance = toBig(walletBalanceLamports);
  const reserve = toBig(setupReserveLamports);
  if (balance <= reserve) return 0n;
  return ((balance - reserve) * AUTO_PLAN_FUNDING_BPS) / BPS_DENOMINATOR;
}

export function affordableAutoPlanRounds({ walletBalance, amountPerPlay, maxFee, setupReserve = 0n }) {
  const perRound = toBig(amountPerPlay) + toBig(maxFee);
  return perRound > 0n ? maxAutoPlanFundingLamports(walletBalance, setupReserve) / perRound : 0n;
}

async function assertFundingWithinWalletBudget(value, authority, setupReserve = 0n) {
  const funding = toBig(value);
  if (funding <= 0n) return;
  // Re-read immediately before instruction construction; the render balance can be stale after
  // another tab or wallet action. This is the transaction-boundary enforcement, not just UI copy.
  const liveBalance = BigInt(await connection.getBalance(authority, 'confirmed'));
  const maximum = maxAutoPlanFundingLamports(liveBalance, setupReserve);
  if (funding > maximum) {
    throw new Error(`Auto-round funding is limited to 90% of this wallet's SOL balance (${Number(maximum) / 1e9} SOL available)`);
  }
}

export async function configurePlan({ tiles, ethPerTile, deposit, rewardMode = 'accumulate' }) {
  const account = getAccount();
  if (!account) throw new Error('Connect a Solana wallet first');
  const configState = await getProtocolConfig();
  if (configState.paused) {
    throw new Error('Mining is temporarily paused while maintenance is completed. Auto-round cannot be started right now.');
  }
  const authority = new PublicKey(account);
  const amounts = Array(GRID).fill(0n);
  const perTile = parseEther(String(ethPerTile));
  tiles.forEach((tile) => { amounts[Number(tile) - 1] = perTile; });
  const autoPlan = planPda(account);
  const { program } = await getWritableProgram();
  const exists = await fetchProtocolAccount('AutoPlan', autoPlan);
  const minerExists = Boolean(await connection.getAccountInfo(minerPda(authority), 'confirmed'));
  const feeParams = await readFeeParams();
  const setupReserve = autoPlanSetupReserve({ hasMiner: minerExists, hasPlan: Boolean(exists), feeParams });
  await assertFundingWithinWalletBudget(deposit, authority, setupReserve);
  const instructions = [];
  if (!minerExists) {
    const registration = await minerRegistrationInstruction({ program, authority });
    if (registration.instruction) instructions.push(registration.instruction);
  }
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
  const configState = await getProtocolConfig();
  if (configState.paused) {
    throw new Error('Mining is temporarily paused while maintenance is completed. Auto-round cannot be funded right now.');
  }
  const feeParams = await readFeeParams();
  await assertFundingWithinWalletBudget(value, authority, feeParams.transactionFeeReserve);
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
