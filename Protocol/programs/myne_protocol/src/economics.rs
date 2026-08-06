use crate::{
    BETTING_DURATION_SECONDS, RESOLUTION_COUNTDOWN_SECONDS, ROUND_DURATION_SECONDS,
    WINNER_DISPLAY_SECONDS,
};
use anchor_lang::prelude::*;

pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MINING_PROTOCOL_FEE_BPS: u16 = 1_200;
// The full 12% mining fee is distributed every one-minute round. There is no
// administrator allocation: 8% funds stakers, 2% funds buyback/burn, and 2%
// funds the Motherlode SOL pool.
pub const MINING_STAKING_BPS: u16 = 800;
pub const MINING_BUYBACK_BPS: u16 = 200;
pub const MINING_MOTHERLODE_BPS: u16 = 200;
pub const MINING_ADMIN_BPS: u16 = 0;
pub const CLAIM_FEE_BPS: u16 = 1_000;
pub const CLAIM_PASSIVE_BPS: u16 = 900;
pub const CLAIM_REFERRAL_BPS: u16 = 100;

pub fn checked_bps(amount: u64, bps: u16) -> Result<u64> {
    let value = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(MyneError::ArithmeticOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(MyneError::ArithmeticOverflow)?;
    u64::try_from(value).map_err(|_| error!(MyneError::ArithmeticOverflow))
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
    #[msg("A verified randomness provider is required for this deployment")]
    RandomnessProviderRequired,
    #[msg("The round has no randomness account bound before betting")]
    RandomnessNotBound,
    #[msg("The supplied randomness account is invalid")]
    InvalidRandomnessAccount,
    #[msg("The randomness account has not been revealed in the current slot")]
    RandomnessNotResolved,
    #[msg("The randomness commitment was created too late")]
    RandomnessCommittedTooLate,
    #[msg("The receipt has already been processed")]
    ReceiptAlreadyProcessed,
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
        assert_eq!(
            checked_bps(50_000_000, MINING_PROTOCOL_FEE_BPS).unwrap(),
            6_000_000
        );
        assert_eq!(
            checked_bps(50_000_000, MINING_STAKING_BPS).unwrap(),
            4_000_000
        );
        assert_eq!(
            checked_bps(50_000_000, MINING_MOTHERLODE_BPS).unwrap(),
            1_000_000
        );
    }
}
