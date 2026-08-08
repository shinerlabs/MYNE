import { PublicKey, SystemProgram } from '@solana/web3.js';

import { connection } from './client.js';
import { derivePda, protocolPdas } from './anchor-client.js';
import { resolveReferrerReference } from './referral.js';

export const minerPda = (authority) => derivePda('miner', new PublicKey(authority));
export const stakePositionPda = (authority) => derivePda('stake_position', new PublicKey(authority));

const referralReferenceFromLocation = () => {
  const match = globalThis.window?.location?.hash?.match(/[?&]ref=([^&]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
};

export async function registrationReferrer(authority) {
  const reference = referralReferenceFromLocation();
  if (!reference) return PublicKey.default;
  const resolved = await resolveReferrerReference(reference);
  if (!resolved) return PublicKey.default;
  const referrer = new PublicKey(resolved);
  return referrer.equals(new PublicKey(authority)) ? PublicKey.default : referrer;
}

/** Build the one-time Miner + StakePosition registration shared by manual and Auto Mine. */
export async function minerRegistrationInstruction({ program, authority }) {
  const miner = minerPda(authority);
  const stakePosition = stakePositionPda(authority);
  if (await connection.getAccountInfo(miner, 'confirmed')) {
    return { instruction: null, miner, stakePosition };
  }
  const referrer = await registrationReferrer(authority);
  const instruction = await program.methods.registerMiner(referrer).accounts({
    config: protocolPdas.config,
    miningPool: protocolPdas.miningPool,
    stakePool: protocolPdas.stakePool,
    miner,
    stakePosition,
    referrerMiner: referrer.equals(PublicKey.default) ? null : minerPda(referrer),
    authority,
    systemProgram: SystemProgram.programId,
  }).instruction();
  return { instruction, miner, stakePosition };
}
