use crate::{
    BETTING_DURATION_SECONDS, RESOLUTION_COUNTDOWN_SECONDS, ROUND_DURATION_SECONDS,
    WINNER_DISPLAY_SECONDS,
};
use anchor_lang::prelude::*;

pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MINING_PROTOCOL_FEE_BPS: u16 = 1_200;
// The full 12% mining fee is distributed every one-minute round: 8% is the
// gross staking allocation, 2% funds the Motherlode SOL pool, 1% funds
// buyback/burn, and 1% is paid directly to the configured administrator fee
// wallet. Ten percent of the gross staking allocation is also paid directly
// to that wallet before the net staking rewards are indexed for stakers.
pub const MINING_STAKING_BPS: u16 = 800;
pub const MINING_BUYBACK_BPS: u16 = 100;
pub const MINING_MOTHERLODE_BPS: u16 = 200;
pub const MINING_ADMIN_BPS: u16 = 100;
pub const STAKING_ADMIN_SHARE_BPS: u16 = 1_000;
pub const CLAIM_FEE_BPS: u16 = 1_000;
pub const CLAIM_PASSIVE_BPS: u16 = 900;
pub const CLAIM_REFERRAL_BPS: u16 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MiningFeeAllocation {
    pub total: u64,
    pub staking_gross: u64,
    pub staking_admin: u64,
    pub staking_net: u64,
    pub buyback: u64,
    pub motherlode: u64,
    /// Includes any sub-lamport basis-point rounding remainder so the total
    /// charged fee always equals the advertised 12% floor exactly.
    pub mining_admin: u64,
    pub admin_total: u64,
}

pub fn checked_bps(amount: u64, bps: u16) -> Result<u64> {
    let value = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(MyneError::ArithmeticOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(MyneError::ArithmeticOverflow)?;
    u64::try_from(value).map_err(|_| error!(MyneError::ArithmeticOverflow))
}

pub fn mining_fee_allocation(amount: u64) -> Result<MiningFeeAllocation> {
    let total = checked_bps(amount, MINING_PROTOCOL_FEE_BPS)?;
    let staking_gross = checked_bps(amount, MINING_STAKING_BPS)?;
    let buyback = checked_bps(amount, MINING_BUYBACK_BPS)?;
    let motherlode = checked_bps(amount, MINING_MOTHERLODE_BPS)?;

    // Derive the direct mining-admin leg from the advertised total after the
    // other destinations are rounded down. This is deterministic, keeps the
    // fee at exactly 12%, and makes every lamport auditable rather than
    // leaving silent dust in the round vault.
    let non_admin = staking_gross
        .checked_add(buyback)
        .and_then(|value| value.checked_add(motherlode))
        .ok_or(MyneError::ArithmeticOverflow)?;
    let mining_admin = total
        .checked_sub(non_admin)
        .ok_or(MyneError::InvalidFeeSchedule)?;
    let staking_admin = checked_bps(staking_gross, STAKING_ADMIN_SHARE_BPS)?;
    let staking_net = staking_gross
        .checked_sub(staking_admin)
        .ok_or(MyneError::ArithmeticOverflow)?;
    let admin_total = mining_admin
        .checked_add(staking_admin)
        .ok_or(MyneError::ArithmeticOverflow)?;

    Ok(MiningFeeAllocation {
        total,
        staking_gross,
        staking_admin,
        staking_net,
        buyback,
        motherlode,
        mining_admin,
        admin_total,
    })
}

pub fn validate_economics() -> Result<()> {
    require!(
        BETTING_DURATION_SECONDS
            .checked_add(RESOLUTION_COUNTDOWN_SECONDS)
            .and_then(|value| value.checked_add(WINNER_DISPLAY_SECONDS))
            == Some(ROUND_DURATION_SECONDS),
        MyneError::InvalidTiming
    );
    require!(
        MINING_STAKING_BPS
            .checked_add(MINING_BUYBACK_BPS)
            .and_then(|v| v.checked_add(MINING_MOTHERLODE_BPS))
            .and_then(|v| v.checked_add(MINING_ADMIN_BPS))
            == Some(MINING_PROTOCOL_FEE_BPS),
        MyneError::InvalidFeeSchedule
    );
    require!(
        CLAIM_PASSIVE_BPS.checked_add(CLAIM_REFERRAL_BPS) == Some(CLAIM_FEE_BPS),
        MyneError::InvalidFeeSchedule
    );
    require!(
        STAKING_ADMIN_SHARE_BPS <= BPS_DENOMINATOR as u16,
        MyneError::InvalidFeeSchedule
    );
    Ok(())
}

#[error_code]
pub enum MyneError {
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("The configured fee destinations do not sum to the advertised fee")]
    InvalidFeeSchedule,
    #[msg("Authority cannot be the default public key")]
    InvalidAuthority,
    #[msg("Timing parameters are invalid")]
    InvalidTiming,
    #[msg("Supply parameters are invalid")]
    InvalidSupply,
    #[msg("No pending administrator matches this signer")]
    InvalidPendingAdmin,
    #[msg("The executable program is not linked to the supplied ProgramData account")]
    InvalidProgramData,
    #[msg("The initializer is not the program upgrade authority")]
    InvalidUpgradeAuthority,
    #[msg("The mint is not owned by the supplied token program")]
    InvalidTokenProgram,
    #[msg("The MYNE mint must use nine decimals")]
    InvalidMintDecimals,
    #[msg("The MYNE mint authority must be the protocol config PDA")]
    InvalidMintAuthority,
    #[msg("The MYNE mint must not have a freeze authority")]
    InvalidFreezeAuthority,
    #[msg("The protocol is paused")]
    ProtocolPaused,
    #[msg("The supplied amount is below the minimum deployment")]
    DeploymentTooSmall,
    #[msg("This round is not accepting deployments")]
    BettingClosed,
    #[msg("This round is not ready for settlement")]
    RoundNotReady,
    #[msg("This round has already settled")]
    RoundAlreadySettled,
    #[msg("The randomness signer is not authorized")]
    InvalidRandomnessAuthority,
    #[msg("Pause the protocol before changing the randomness authority")]
    RandomnessAuthorityLocked,
    #[msg("Pause the protocol before rotating funded operational wallets")]
    OperationalWalletsLocked,
    #[msg("A verified randomness provider is required for this deployment")]
    RandomnessProviderRequired,
    #[msg("The round has no randomness account bound before betting")]
    RandomnessNotBound,
    #[msg("The supplied randomness account is invalid")]
    InvalidRandomnessAccount,
    #[msg("The randomness account has not been revealed in the current slot")]
    RandomnessNotResolved,
    #[msg("The randomness account was revealed before settlement")]
    RandomnessAlreadyRevealed,
    #[msg("The randomness account has not been committed")]
    RandomnessNotCommitted,
    #[msg("The randomness account was committed before betting closed")]
    RandomnessAlreadyCommitted,
    #[msg("The randomness commitment is not a fresh post-betting commitment")]
    RandomnessCommittedTooLate,
    #[msg("The receipt has already been processed")]
    ReceiptAlreadyProcessed,
    #[msg("The receipt must be claimed or refunded before it can close")]
    ReceiptNotProcessed,
    #[msg("The receipt authority is invalid")]
    InvalidReceiptAuthority,
    #[msg("The requested token or SOL amount is unavailable")]
    InsufficientBalance,
    #[msg("The supplied referrer is invalid")]
    InvalidReferrer,
    #[msg("The staking cooldown has not completed")]
    CooldownActive,
    #[msg("The staking position does not match this authority")]
    InvalidStakeAuthority,
    #[msg("The provided fee destination does not match protocol configuration")]
    InvalidFeeDestination,
    #[msg("A verified Meteora liquidity pool is required before unpausing")]
    LiquidityPoolNotVerified,
    #[msg("The configured liquidity pool is invalid")]
    InvalidLiquidityPool,
    #[msg("The round ID does not match this account")]
    InvalidRound,
    #[msg("Only the current scheduled round can be opened")]
    InvalidRoundSchedule,
    #[msg("This automation plan already executed for the round")]
    AutoPlanAlreadyExecuted,
    #[msg("This automation plan is inactive")]
    AutoPlanInactive,
    #[msg("Production mode cannot be downgraded after mainnet randomness is selected")]
    ProductionModeLocked,
    #[msg("This production artifact requires an approved mainnet randomness mode")]
    ProductionRandomnessRequired,
    #[msg("The staking token account is not the canonical stake-pool vault")]
    InvalidStakeVault,
    #[msg("The automation reward mode is invalid")]
    InvalidRewardMode,
    #[msg("The fixed MYNE emission schedule has completed")]
    EmissionComplete,
    #[msg("The round archive hash cannot be zero")]
    InvalidArchiveHash,
    #[msg("The round has already been archived")]
    RoundAlreadyArchived,
    #[msg("The round has not been archived")]
    RoundNotArchived,
    #[msg("Not every receipt has completed the cleanup lifecycle")]
    RoundCleanupIncomplete,
    #[msg("The buyback has already been marked complete")]
    BuybackAlreadyCompleted,
    #[msg("The round buyback has not completed")]
    BuybackNotCompleted,
    #[msg("The round still contains SOL allocated to player payouts")]
    RoundPayoutIncomplete,
    #[msg("The protocol configuration must be migrated to the current fee schedule")]
    ProtocolUpgradeRequired,
    #[msg("Pause the protocol before migrating its fee schedule")]
    MigrationRequiresPause,
    #[msg("The v5 mining pool must have no unclaimed balances before migration")]
    MiningPoolMigrationRequiresEmpty,
    #[msg("The pre-launch mint migration does not match the one approved recovery path")]
    InvalidPrelaunchMintMigration,
    #[msg("The protocol has activity or liabilities and can no longer use the pre-launch mint migration")]
    PrelaunchStateNotEmpty,
    #[msg("The unclaimed mining-reward share accounting is inconsistent")]
    InvalidMiningPoolAccounting,
    #[msg("The mining reward is below the unclaimed-share precision")]
    MiningRewardBelowSharePrecision,
    #[msg("This instruction requires MYNE server commit-reveal mode")]
    ServerRandomnessModeRequired,
    #[msg("The server randomness commitment or reveal is invalid")]
    InvalidServerRandomnessCommitment,
    #[msg("The server commitment is not awaiting an entropy-slot lock")]
    ServerRandomnessNotPending,
    #[msg("The server entropy slot has not been locked")]
    ServerEntropyNotLocked,
    #[msg("The locked server entropy slot has not yet been produced")]
    ServerEntropySlotNotReached,
    #[msg("The locked server entropy slot is no longer available")]
    ServerEntropyUnavailable,
    #[msg("The supplied SlotHashes sysvar is invalid")]
    InvalidSlotHashesSysvar,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_fee_schedules_balance() {
        validate_economics().unwrap();
    }

    #[test]
    fn mining_fee_is_twelve_percent() {
        let fees = mining_fee_allocation(50_000_000).unwrap();
        assert_eq!(fees.total, 6_000_000);
        assert_eq!(fees.staking_gross, 4_000_000);
        assert_eq!(fees.staking_admin, 400_000);
        assert_eq!(fees.staking_net, 3_600_000);
        assert_eq!(fees.motherlode, 1_000_000);
        assert_eq!(fees.buyback, 500_000);
        assert_eq!(fees.mining_admin, 500_000);
        assert_eq!(fees.admin_total, 900_000);
        assert_eq!(
            fees.staking_net
                .checked_add(fees.staking_admin)
                .and_then(|value| value.checked_add(fees.buyback))
                .and_then(|value| value.checked_add(fees.motherlode))
                .and_then(|value| value.checked_add(fees.mining_admin)),
            Some(fees.total),
        );
    }

    #[test]
    fn fee_rounding_is_conserved_and_visible() {
        let fees = mining_fee_allocation(12_345).unwrap();
        assert_eq!(fees.total, 1_481);
        assert_eq!(fees.mining_admin, 125);
        assert_eq!(
            fees.staking_net
                .checked_add(fees.staking_admin)
                .and_then(|value| value.checked_add(fees.buyback))
                .and_then(|value| value.checked_add(fees.motherlode))
                .and_then(|value| value.checked_add(fees.mining_admin)),
            Some(fees.total),
        );
        assert_eq!(
            fees.staking_admin,
            checked_bps(fees.staking_gross, 1_000).unwrap()
        );
    }

    #[test]
    fn fee_conservation_holds_at_boundaries() {
        for gross in [0, 1, 8, 9, 10, 99, 9_999, 10_000, 10_001, u64::MAX] {
            let fees = mining_fee_allocation(gross).unwrap();
            assert_eq!(fees.total, checked_bps(gross, 1_200).unwrap());
            assert_eq!(fees.buyback, checked_bps(gross, 100).unwrap());
            assert_eq!(fees.motherlode, checked_bps(gross, 200).unwrap());
            assert_eq!(fees.staking_gross, checked_bps(gross, 800).unwrap());
            assert_eq!(
                fees.staking_admin,
                checked_bps(fees.staking_gross, 1_000).unwrap()
            );
            assert_eq!(fees.staking_net + fees.staking_admin, fees.staking_gross);
            assert_eq!(fees.mining_admin + fees.staking_admin, fees.admin_total);
            assert_eq!(
                fees.staking_net
                    + fees.staking_admin
                    + fees.buyback
                    + fees.motherlode
                    + fees.mining_admin,
                fees.total,
            );
        }
    }
}
