use anchor_lang::prelude::*;

pub const TILE_COUNT: usize = 25;
pub const REWARD_SCALE: u128 = 1_000_000_000_000_000_000;

#[account]
#[derive(InitSpace)]
pub struct MiningPool {
    pub bump: u8,
    pub total_unclaimed: u64,
    pub reward_per_unclaimed: u128,
    pub undistributed_base_units: u64,
}

#[account]
#[derive(InitSpace)]
pub struct StakePool {
    pub bump: u8,
    pub total_standard: u64,
    pub total_burn: u64,
    pub total_weight: u64,
    pub reward_per_weight: u128,
    pub undistributed_lamports: u64,
    pub total_funded_lamports: u64,
    pub total_claimed_lamports: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Miner {
    pub bump: u8,
    pub authority: Pubkey,
    pub referrer: Pubkey,
    pub unclaimed_myne: u64,
    pub passive_reward_debt: u128,
    pub lifetime_deployed_lamports: u64,
    pub lifetime_sol_claimed: u64,
    pub lifetime_myne_claimed: u64,
}

#[account]
#[derive(InitSpace)]
pub struct StakePosition {
    pub bump: u8,
    pub authority: Pubkey,
    pub standard_principal: u64,
    pub burn_principal: u64,
    pub reward_weight: u64,
    pub reward_debt: u128,
    pub pending_sol: u64,
    pub cooldown_amount: u64,
    pub cooldown_unlock_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub bump: u8,
    pub id: u64,
    pub opened_at: i64,
    pub betting_ends_at: i64,
    pub settles_at: i64,
    pub refund_at: i64,
    pub settled: bool,
    pub winning_tile: u8,
    pub solo_mode: bool,
    pub motherlode_hit: bool,
    pub randomness: [u8; 32],
    /// Switchboard randomness account bound before betting closes. A default
    /// key is only allowed for the explicitly local/devnet legacy path.
    pub randomness_account: Pubkey,
    pub randomness_commit_slot: u64,
    pub solo_sample: u64,
    pub tile_lamports: [u64; TILE_COUNT],
    pub tile_receipts: [u64; TILE_COUNT],
    pub gross_deployed_lamports: u64,
    pub prize_lamports: u64,
    pub motherlode_payout_lamports: u64,
    pub claimed_lamports: u64,
    pub base_emission: u64,
    pub motherlode_emission: u64,
}

#[account]
#[derive(InitSpace)]
pub struct BetReceipt {
    pub bump: u8,
    pub round_id: u64,
    pub authority: Pubkey,
    pub nonce: u64,
    pub amounts: [u64; TILE_COUNT],
    pub cumulative_starts: [u64; TILE_COUNT],
    pub total_lamports: u64,
    pub claimed: bool,
    pub refunded: bool,
}

#[account]
#[derive(InitSpace)]
pub struct AutoPlan {
    pub bump: u8,
    pub authority: Pubkey,
    pub active: bool,
    pub amounts: [u64; TILE_COUNT],
    pub balance_lamports: u64,
    pub next_nonce: u64,
    pub last_round: u64,
}
