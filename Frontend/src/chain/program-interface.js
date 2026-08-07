import { PublicKey } from '@solana/web3.js';
import { PROGRAMS, SERVICES } from '../app-config.js';

/**
 * Stable Solana boundary shared by the frontend and the future generated Anchor client.
 *
 * Do not add EVM method names, ABIs, allowances, gas estimates or log scans here. Once the first
 * Anchor build produces an IDL, instruction encoders and account decoders should be generated from
 * that artifact rather than handwritten in this file.
 */
export const MYNE_SEEDS = Object.freeze({
  config: 'config',
  round: 'round',
  bet: 'bet',
  miner: 'miner',
  stakePool: 'stake_pool',
  stakePosition: 'stake_position',
  referral: 'referral',
  solVault: 'sol_vault',
  tokenVault: 'token_vault',
});

export const MYNE_INSTRUCTIONS = Object.freeze({
  initializeProtocol: 'initialize_protocol',
  setPaused: 'set_paused',
  proposeAdmin: 'propose_admin',
  acceptAdmin: 'accept_admin',
  setRandomnessAuthority: 'set_randomness_authority',
  registerMiner: 'register_miner',
  openRound: 'open_round',
  bindRoundRandomness: 'bind_round_randomness',
  recordRoundRandomnessCommit: 'record_round_randomness_commit',
  deployMining: 'deploy',
  settleRound: 'settle_round',
  settleRoundVerified: 'settle_round_verified',
  claimRound: 'claim_receipt',
  claimMyne: 'claim_myne',
  burnUnclaimedMyne: 'burn_unclaimed_myne',
  refundReceipt: 'refund_receipt',
  stake: 'stake_standard',
  burnStake: 'burn_stake',
  requestUnstake: 'request_unstake',
  withdrawUnstaked: 'withdraw_unstaked',
  claimStakingSol: 'claim_staking_rewards',
  fundStakingRewards: 'fund_staking_rewards',
  createAutoPlan: 'create_auto_plan',
  configureAutoPlan: 'configure_auto_plan',
  fundAutoPlan: 'fund_auto_plan',
  cancelAutoPlan: 'cancel_auto_plan',
  executeAutoPlan: 'execute_auto_plan',
  claimAutoBurnReceipt: 'claim_auto_burn_receipt',
});

const parsePublicKey = (value, label) => {
  if (!value) return null;
  try { return new PublicKey(value); }
  catch { throw new Error(`${label} is not a valid Solana public key`); }
};

export const getMyneDeployment = () => ({
  programId: parsePublicKey(PROGRAMS.protocol, 'MYNE program ID'),
  mint: parsePublicKey(PROGRAMS.tokenMint, 'MYNE mint'),
  randomnessProgramId: parsePublicKey(PROGRAMS.randomness, 'MYNE randomness program ID'),
  indexerUrl: SERVICES.indexerUrl,
});

export function deriveConfigPda(programId = getMyneDeployment().programId) {
  if (!programId) return null;
  return PublicKey.findProgramAddressSync([new TextEncoder().encode(MYNE_SEEDS.config)], programId);
}

export function deploymentStatus() {
  const deployment = getMyneDeployment();
  const missing = [];
  if (!deployment.programId) missing.push('VITE_MYNE_PROGRAM_ID');
  if (!deployment.mint) missing.push('VITE_MYNE_MINT_ADDRESS');
  if (!deployment.randomnessProgramId) missing.push('VITE_MYNE_RANDOMNESS_PROGRAM_ID');
  if (!deployment.indexerUrl) missing.push('VITE_SUPABASE_URL');
  return { ready: missing.length === 0, missing, ...deployment };
}
