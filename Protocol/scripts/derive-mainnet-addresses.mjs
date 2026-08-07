/** Derive canonical MYNE Mainnet addresses without creating or funding accounts. */
import assert from 'node:assert/strict';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

const FIXED_PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const programId = new PublicKey(process.env.MYNE_PROGRAM_ID || FIXED_PROGRAM_ID);
assert.ok(programId.equals(FIXED_PROGRAM_ID), `Mainnet program ID must remain ${FIXED_PROGRAM_ID.toBase58()}`);

const adminFeeWallet = new PublicKey(process.env.MAINNET_ADMIN_FEE_WALLET || '');
const fallbackInput = process.env.MAINNET_REFERRAL_FALLBACK_WALLET;
if (fallbackInput) {
  assert.ok(
    new PublicKey(fallbackInput).equals(adminFeeWallet),
    'The referral fallback is the configured admin-fee wallet; the two values must match',
  );
}

const pda = (seed, ...extra) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), ...extra],
  programId,
);
const [config, configBump] = pda('config');
const [miningPool, miningPoolBump] = pda('mining_pool');
const [stakePool, stakePoolBump] = pda('stake_pool');
const [liquidityGate, liquidityGateBump] = pda('liquidity_gate');
const [adminMiner, adminMinerBump] = pda('miner', adminFeeWallet.toBuffer());
const [adminStakePosition, adminStakePositionBump] = pda('stake_position', adminFeeWallet.toBuffer());

const mint = process.env.MAINNET_MINT_ADDRESS
  ? new PublicKey(process.env.MAINNET_MINT_ADDRESS)
  : null;
const adminFallbackTokenAccount = mint
  ? getAssociatedTokenAddressSync(
    mint,
    adminFeeWallet,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  : null;
const transactionPayer = process.env.MAINNET_TRANSACTION_PAYER
  ? new PublicKey(process.env.MAINNET_TRANSACTION_PAYER).toBase58()
  : null;

console.log(JSON.stringify({
  created: false,
  programId: programId.toBase58(),
  roles: {
    adminFeeAndReferralFallback: adminFeeWallet.toBase58(),
  },
  canonicalPdas: {
    config: { address: config.toBase58(), bump: configBump },
    miningPool: { address: miningPool.toBase58(), bump: miningPoolBump },
    stakePool: { address: stakePool.toBase58(), bump: stakePoolBump },
    liquidityGate: { address: liquidityGate.toBase58(), bump: liquidityGateBump },
    adminMiner: { address: adminMiner.toBase58(), bump: adminMinerBump },
    adminStakePosition: { address: adminStakePosition.toBase58(), bump: adminStakePositionBump },
  },
  adminFallbackTokenAccount: adminFallbackTokenAccount?.toBase58() || null,
  funding: {
    transactionPayer,
    instruction: transactionPayer
      ? 'Fund only this controlled signer before initialization.'
      : 'Set MAINNET_TRANSACTION_PAYER to the controlled signer that will pay initialization rent and fees.',
    warning: 'Do not send SOL to any derived PDA before its initialize instruction. A PDA cannot sign, and pre-funding can block Anchor account creation.',
  },
  next: mint
    ? 'Initialize paused, verify every account, then run prepare:admin-ata.'
    : 'Create and verify the Mainnet mint before deriving the fallback token account.',
}, null, 2));
