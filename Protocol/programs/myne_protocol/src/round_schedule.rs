use anchor_lang::prelude::*;

use crate::{MyneError, PROVIDER_PREPARATION_LEAD_SECONDS};

/// Validates when a scheduled round PDA may be created.
///
/// Provider-backed rounds may be prepared shortly before their scheduled
/// opening so the provider account/commitment can be bound before betting
/// starts. Local legacy rounds retain the original schedule and cannot be
/// opened early.
pub(crate) fn assert_round_can_open_at(
    now: i64,
    opened_at: i64,
    betting_ends_at: i64,
    provider_backed: bool,
) -> Result<()> {
    let opening_window_starts_at = if provider_backed {
        opened_at
            .checked_sub(PROVIDER_PREPARATION_LEAD_SECONDS)
            .ok_or(MyneError::ArithmeticOverflow)?
    } else {
        opened_at
    };

    require!(
        now >= opening_window_starts_at && now < betting_ends_at,
        MyneError::InvalidRoundSchedule
    );
    Ok(())
}

/// Enforces the exact user betting interval for every wager path.
///
/// A provider-backed round may already exist before `opened_at`, but neither
/// manual nor automated deployments may be accepted until that scheduled
/// timestamp. The end is exclusive, yielding exactly the configured 60-second
/// interval `[opened_at, betting_ends_at)`.
pub(crate) fn assert_round_accepting_deployments_at(
    settled: bool,
    now: i64,
    opened_at: i64,
    betting_ends_at: i64,
) -> Result<()> {
    require!(
        !settled && now >= opened_at && now < betting_ends_at,
        MyneError::BettingClosed
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BETTING_DURATION_SECONDS;

    const OPENED_AT: i64 = 1_000;
    const BETTING_ENDS_AT: i64 = OPENED_AT + BETTING_DURATION_SECONDS as i64;

    #[test]
    fn provider_round_preopen_is_accepted_at_the_bounded_lead() {
        let earliest = OPENED_AT - PROVIDER_PREPARATION_LEAD_SECONDS;
        assert!(assert_round_can_open_at(earliest, OPENED_AT, BETTING_ENDS_AT, true).is_ok());
        assert!(assert_round_can_open_at(OPENED_AT - 1, OPENED_AT, BETTING_ENDS_AT, true).is_ok());
    }

    #[test]
    fn provider_round_preopen_rejects_even_one_second_too_early() {
        let too_early = OPENED_AT - PROVIDER_PREPARATION_LEAD_SECONDS - 1;
        assert!(assert_round_can_open_at(too_early, OPENED_AT, BETTING_ENDS_AT, true).is_err());
    }

    #[test]
    fn local_default_round_keeps_the_original_no_preopen_policy() {
        assert!(
            assert_round_can_open_at(OPENED_AT - 1, OPENED_AT, BETTING_ENDS_AT, false).is_err()
        );
        assert!(assert_round_can_open_at(OPENED_AT, OPENED_AT, BETTING_ENDS_AT, false).is_ok());
    }

    #[test]
    fn manual_and_auto_paths_reject_wagers_during_provider_preparation() {
        // Both public wager handlers call this guard. A pre-created and bound
        // round therefore cannot accept either path before its scheduled start.
        for now in [OPENED_AT - PROVIDER_PREPARATION_LEAD_SECONDS, OPENED_AT - 1] {
            assert!(
                assert_round_accepting_deployments_at(false, now, OPENED_AT, BETTING_ENDS_AT,)
                    .is_err()
            );
        }
    }

    #[test]
    fn every_scheduled_betting_second_is_accepted_and_only_those_seconds() {
        let accepted_seconds = (OPENED_AT - 1..=BETTING_ENDS_AT)
            .filter(|now| {
                assert_round_accepting_deployments_at(false, *now, OPENED_AT, BETTING_ENDS_AT)
                    .is_ok()
            })
            .count();

        assert_eq!(accepted_seconds, BETTING_DURATION_SECONDS as usize);
        assert!(assert_round_accepting_deployments_at(
            false,
            OPENED_AT,
            OPENED_AT,
            BETTING_ENDS_AT,
        )
        .is_ok());
        assert!(assert_round_accepting_deployments_at(
            false,
            BETTING_ENDS_AT - 1,
            OPENED_AT,
            BETTING_ENDS_AT,
        )
        .is_ok());
        assert!(assert_round_accepting_deployments_at(
            false,
            BETTING_ENDS_AT,
            OPENED_AT,
            BETTING_ENDS_AT,
        )
        .is_err());
        assert!(
            assert_round_accepting_deployments_at(true, OPENED_AT, OPENED_AT, BETTING_ENDS_AT,)
                .is_err()
        );
    }
}
