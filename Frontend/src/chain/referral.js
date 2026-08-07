import { PublicKey, SystemProgram } from '@solana/web3.js';

import { connection, getAccount } from './client.js';
import { derivePda, fetchProtocolAccount, getWritableProgram, protocolPdas, sendInstructions } from './anchor-client.js';
import { isSocialConfigured, supabase } from '../social/config.js';
import {
  canonicalSolanaAddress, isReferralCode, referralCodeFor,
} from './referral-code.js';
import {
  boundedReferralPage, referralLeaderFromRow, referralNetworkFromRow, referralStatsFromRow,
} from './referral-read-model.js';

const minerPda = (owner) => derivePda('miner', new PublicKey(owner));
const positionPda = (owner) => derivePda('stake_position', new PublicKey(owner));

export async function readReferrerOf(account) {
  if (!account) return PublicKey.default.toBase58();
  const miner = await fetchProtocolAccount('Miner', minerPda(account));
  return miner?.referrer?.toBase58() ?? PublicKey.default.toBase58();
}

export async function readReferralStats(account = getAccount()) {
  if (!account) return null;
  const authority = new PublicKey(account).toBase58();
  const miner = await fetchProtocolAccount('Miner', minerPda(authority));
  const referrer = miner?.referrer ?? PublicKey.default;
  let indexed = { lifetime: 0n, referrals: 0, active: 0 };
  if (isSocialConfigured && supabase) {
    const { data, error } = await supabase
      .from('mine_referral_stats_v1')
      .select('referrals, active, earned_base_units::text')
      .eq('wallet_address', authority)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Referral index unavailable: ${error.message}`);
    if (data) indexed = referralStatsFromRow(data);
  }
  return {
    referrer: referrer.toBase58(),
    hasReferrer: !referrer.equals(PublicKey.default),
    // There is no separate referral-reward balance or claim instruction. Claim-event credits are
    // merged into the miner's general reward shares, so generic unclaimed MYNE must not be
    // presented as referral-claimable MYNE.
    claimable: 0n,
    ...indexed,
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
  throw new Error('Referral MYNE is included in the standard MYNE claim; there is no separate referral balance');
}

// Reverse referral enumeration is intentionally delegated to the indexer. The program keeps no
// global user vector, preserving the protocol-level no-user-cap requirement.
export async function readLeaderboard(limit = 10, offset = 0) {
  if (!isSocialConfigured || !supabase) return [];
  const page = boundedReferralPage({ limit, offset });
  const { data, error } = await supabase
    .from('mine_referral_stats_v1')
    .select('wallet_address, referrals, active, earned_base_units::text')
    .order('earned_base_units', { ascending: false })
    .order('active', { ascending: false })
    .order('referrals', { ascending: false })
    .order('wallet_address', { ascending: true })
    .range(page.offset, page.offset + page.limit - 1);
  if (error) throw new Error(`Referral leaderboard unavailable: ${error.message}`);
  return (data ?? []).map(referralLeaderFromRow);
}

export async function readMyReferrals(
  account = getAccount(),
  { limit = 100, offset = 0 } = {},
) {
  if (!account) return [];
  if (!isSocialConfigured || !supabase) return [];
  const authority = new PublicKey(account).toBase58();
  const page = boundedReferralPage({ limit, offset });
  const { data, error } = await supabase
    .from('mine_referral_network_v1')
    .select('referred_wallet, active, earned_base_units::text')
    .eq('referrer_wallet', authority)
    .order('earned_base_units', { ascending: false })
    .order('referred_wallet', { ascending: true })
    .range(page.offset, page.offset + page.limit - 1);
  if (error) throw new Error(`Referral network unavailable: ${error.message}`);
  return (data ?? []).map(referralNetworkFromRow);
}
