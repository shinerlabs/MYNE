import { PublicKey, SystemProgram } from '@solana/web3.js';

import { connection, getAccount } from './client.js';
import { derivePda, fetchProtocolAccount, getWritableProgram, protocolPdas, sendInstructions } from './anchor-client.js';
import { isSocialConfigured, supabase } from '../social/config.js';
import {
  canonicalSolanaAddress, isReferralCode, referralCodeFor,
} from './referral-code.js';

const minerPda = (owner) => derivePda('miner', new PublicKey(owner));
const positionPda = (owner) => derivePda('stake_position', new PublicKey(owner));

export async function readReferrerOf(account) {
  if (!account) return PublicKey.default.toBase58();
  const miner = await fetchProtocolAccount('Miner', minerPda(account));
  return miner?.referrer?.toBase58() ?? PublicKey.default.toBase58();
}

export async function readReferralStats(account = getAccount()) {
  if (!account) return null;
  const miner = await fetchProtocolAccount('Miner', minerPda(account));
  const referrer = miner?.referrer ?? PublicKey.default;
  return {
    referrer: referrer.toBase58(),
    hasReferrer: !referrer.equals(PublicKey.default),
    // Referral rewards are credited directly into the same unclaimed MYNE balance.
    claimable: BigInt(miner?.unclaimedMyne?.toString?.() ?? 0),
    lifetime: 0n, referrals: 0, active: 0,
  };
}

export async function setReferrer(referrerAddress) {
  const account = getAccount();
  if (!account) throw new Error('Connect a Solana wallet first');
  const existing = await connection.getAccountInfo(minerPda(account), 'confirmed');
  if (existing) throw new Error('Referral attribution is permanent and this miner is already registered');
  const authority = new PublicKey(account);
  const referrer = new PublicKey(referrerAddress);
  if (authority.equals(referrer)) throw new Error('Self-referral is not allowed');
  const { program } = await getWritableProgram();
  return sendInstructions([await program.methods.registerMiner(referrer).accounts({
    config: protocolPdas.config, miningPool: protocolPdas.miningPool, stakePool: protocolPdas.stakePool,
    miner: minerPda(account), stakePosition: positionPda(account), referrerMiner: minerPda(referrer), authority,
    systemProgram: SystemProgram.programId,
  }).instruction()]);
}

/**
 * Resolve the compact public referral code through the indexed, read-only mapping. Old links
 * containing a complete Solana address remain valid, but newly shared links never expose it.
 * The deterministic suffix is checked again client-side so a corrupt index row cannot redirect
 * attribution to a different wallet.
 */
export async function resolveReferrerReference(reference) {
  const raw = String(reference ?? '').trim();
  const legacyAddress = canonicalSolanaAddress(raw);
  if (legacyAddress) return legacyAddress;
  if (!isReferralCode(raw) || !isSocialConfigured || !supabase) return null;

  const { data, error } = await supabase
    .from('mine_referral_codes')
    .select('wallet_address')
    .eq('code', raw)
    .maybeSingle();
  if (error || !data?.wallet_address) return null;

  const address = canonicalSolanaAddress(data.wallet_address);
  return address && referralCodeFor(address) === raw ? address : null;
}

export async function claimReferral() {
  throw new Error('Referral MYNE is already included in your standard unclaimed MYNE balance');
}

// Reverse referral enumeration is intentionally delegated to the indexer. The program keeps no
// global user vector, preserving the protocol-level no-user-cap requirement.
export async function readLeaderboard() { return []; }
export async function readMyReferrals() { return []; }
