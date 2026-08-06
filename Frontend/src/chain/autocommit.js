import { PublicKey, SystemProgram } from '@solana/web3.js';

import { getAccount } from './client.js';
import { GRID } from './config.js';
import { parseEther } from './units.js';
import { asBn, derivePda, fetchProtocolAccount, getWritableProgram, protocolPdas, sendInstructions } from './anchor-client.js';

// Kept for UI compatibility only. The Solana plan has no play-count ceiling: it executes once per
// round until its prepaid balance can no longer cover the configured deployment.
export const UNLIMITED_PLAYS = 4294967295;
export const MAX_PLAYS_PER_EXECUTION = 1n;
const planPda = (account) => derivePda('auto_plan', new PublicKey(account));
const toBig = (value) => BigInt(value?.toString?.() ?? value ?? 0);

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
    tiles: amounts.flatMap((amount, index) => amount > 0n ? [index + 1] : []),
    amounts,
  };
}

export async function readFeeParams() { return { accountDeposit: 0n, maxFee: 0n }; }
export function requiredDeposit({ amountPerPlay, fundRounds }) { return amountPerPlay * BigInt(fundRounds); }

export async function configurePlan({ tiles, ethPerTile, deposit }) {
  const account = getAccount();
  if (!account) throw new Error('Connect a Solana wallet first');
  const authority = new PublicKey(account);
  const amounts = Array(GRID).fill(0n);
  const perTile = parseEther(String(ethPerTile));
  tiles.forEach((tile) => { amounts[Number(tile) - 1] = perTile; });
  const autoPlan = planPda(account);
  const { program } = await getWritableProgram();
  const exists = await fetchProtocolAccount('AutoPlan', autoPlan);
  const instructions = [];
  if (!exists) {
    instructions.push(await program.methods.createAutoPlan(amounts.map(asBn), asBn(deposit)).accounts({
      config: protocolPdas.config, autoPlan, authority, systemProgram: SystemProgram.programId,
    }).instruction());
  } else {
    instructions.push(await program.methods.configureAutoPlan(amounts.map(asBn), true).accounts({
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
