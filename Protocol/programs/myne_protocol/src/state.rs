use anchor_lang::prelude::*;

pub const TILE_COUNT: usize = 25;
pub const REWARD_SCALE: u128 = 1_000_000_000_000_000_000;

#[account]
#[derive(InitSpace)]
pub struct MiningPool {
    pub bump: u8,
    /// Exact MYNE base-unit liability represented by all outstanding shares.
    pub total_unclaimed: u64,
    /// v6: total outstanding unclaimed-reward shares. This field retains its
    /// original name to preserve the binary account layout across migration.
    pub reward_per_unclaimed: u128,
    /// Passive claim fees assessed when no eligible unclaimed holder exists.
    /// These base units remain permanently unissued and never accrue to a
    /// future miner.
    pub undistributed_base_units: u64,
}

#[account]
#[derive(InitSpace)]
pub struct StakePool {
    pub bump: u8,
    pub active_stakers: u64,
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
    /// Cached share value, refreshed whenever this miner touches the program.
    pub unclaimed_myne: u64,
    /// v6: this miner's unclaimed-reward shares. The legacy field name keeps
    /// the account layout stable; v5 pools must be empty before migration.
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
    /// Wallet that funded this account's rent. It is the only permitted close
    /// destination, so permissionless cleanup cannot redirect recovered SOL.
    pub rent_payer: Pubkey,
    pub opened_at: i64,
    pub betting_ends_at: i64,
    pub settles_at: i64,
    pub refund_at: i64,
    pub settled: bool,
    pub winning_tile: u8,
    pub solo_mode: bool,
    pub motherlode_hit: bool,
    pub randomness: [u8; 32],
    /// Switchboard account for legacy/verified rounds, or the 32-byte server
    /// commitment interpreted as a Pubkey for commit-reveal rounds. A default
    /// key is allowed only for the explicitly local rehearsal path.
    pub randomness_account: Pubkey,
    /// Plain Switchboard commit slot when the high bit is clear. Server mode
    /// uses the high bit as a mode tag; all ones means commitment pending, and
    /// a finite tagged value is the locked/final entropy slot.
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
    /// Receipt lifecycle counters. A round cannot close until every receipt has
    /// been settled/refunded and subsequently closed after archival.
    pub total_receipts: u64,
    pub processed_receipts: u64,
    pub closed_receipts: u64,
    /// The buyback keeper attests completion only after the allocated SOL was
    /// swapped through the registered pool and the purchased MYNE was burned.
    pub buyback_completed: bool,
    /// Hash of the canonical database snapshot committed by the randomness
    /// authority. Non-zero means history and proof data were durably archived.
    pub archive_hash: [u8; 32],
    pub archived_at_slot: u64,
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
    /// 0 = accumulate MYNE for a later user-signed claim; 1 = permissionless
    /// auto-burn into the user's 5x virtual staking position.
    pub reward_mode: u8,
    pub claimed: bool,
    pub refunded: bool,
}

#[account]
#[derive(InitSpace)]
pub struct AutoPlan {
    pub bump: u8,
    pub authority: Pubkey,
    pub active: bool,
    pub reward_mode: u8,
    pub amounts: [u64; TILE_COUNT],
    pub balance_lamports: u64,
    pub next_nonce: u64,
    pub last_round: u64,
}
