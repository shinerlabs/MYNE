use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program_option::COption, system_instruction};
use anchor_spl::token_interface::{
    self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};
use solana_sha256_hasher::hashv;

mod economics;
mod state;
use economics::*;
use state::*;

declare_id!("D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MINING_POOL_SEED: &[u8] = b"mining_pool";
pub const STAKE_POOL_SEED: &[u8] = b"stake_pool";
pub const LIQUIDITY_GATE_SEED: &[u8] = b"liquidity_gate";
pub const MINER_SEED: &[u8] = b"miner";
pub const STAKE_POSITION_SEED: &[u8] = b"stake_position";
pub const ROUND_SEED: &[u8] = b"round";
pub const BET_SEED: &[u8] = b"bet";
pub const CURRENT_VERSION: u8 = 3;
pub const MYNE_DECIMALS: u8 = 9;
pub const GENESIS_TOKENS: u64 = 100;
pub const MAX_TOKENS: u64 = 2_000_000;
pub const MINIMUM_ROUND_LAMPORTS: u64 = 50_000_000;
pub const ROUND_DURATION_SECONDS: u64 = 65;
pub const BETTING_DURATION_SECONDS: u64 = 60;
pub const RESOLUTION_COUNTDOWN_SECONDS: u64 = 0;
pub const WINNER_DISPLAY_SECONDS: u64 = 5;
pub const MOTHERLODE_ODDS: u64 = 650;
pub const REFUND_DELAY_SECONDS: i64 = 10 * 60;
pub const UNSTAKE_DELAY_SECONDS: u64 = 30 * 24 * 60 * 60;
pub const GENESIS_BASE_UNITS: u64 = GENESIS_TOKENS * 1_000_000_000;
pub const BASE_ROUND_EMISSION: u64 = 1_000_000_000;
pub const MOTHERLODE_ROUND_EMISSION: u64 = 200_000_000;
pub const BURN_WEIGHT_MULTIPLIER: u64 = 5;

// Switchboard On-Demand randomness account identifiers. The account layout is
// intentionally parsed locally so the protocol does not depend on an Anchor
// version-specific SDK at build time. These IDs are pinned to Switchboard's
// published deployments; the configured ProtocolConfig value is still checked
// for every request and settlement.
pub const SWITCHBOARD_DEVNET_PROGRAM: Pubkey =
    pubkey!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
pub const SWITCHBOARD_MAINNET_PROGRAM: Pubkey =
    pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
/// Meteora's canonical DLMM program. Mainnet/devnet activation must use this
/// program; accepting an arbitrary owner would allow an unrelated account to
/// satisfy the liquidity gate.
pub const METEORA_DLMM_PROGRAM: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
pub const WRAPPED_SOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const SWITCHBOARD_RANDOMNESS_DISCRIMINATOR: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];
const SWITCHBOARD_RANDOMNESS_ACCOUNT_SIZE: usize = 408;

#[program]
pub mod myne_protocol {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        args: InitializeArgs,
    ) -> Result<()> {
        validate_economics()?;
        require!(
            args.randomness_authority != Pubkey::default(),
            MyneError::InvalidAuthority
        );
        require!(
            args.buyback_wallet != Pubkey::default(),
            MyneError::InvalidAuthority
        );
        require!(
            args.motherlode_wallet != Pubkey::default(),
            MyneError::InvalidAuthority
        );
        require!(
            args.admin_fee_wallet != Pubkey::default(),
            MyneError::InvalidAuthority
        );
        if args.randomness_program != Pubkey::default() {
            require!(
                args.randomness_program == SWITCHBOARD_DEVNET_PROGRAM
                    || args.randomness_program == SWITCHBOARD_MAINNET_PROGRAM,
                MyneError::InvalidRandomnessAccount
            );
        }
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            ctx.accounts.token_program.key(),
            MyneError::InvalidTokenProgram
        );
        require!(
            ctx.accounts.mint.decimals == MYNE_DECIMALS,
            MyneError::InvalidMintDecimals
        );
        require!(
            ctx.accounts.mint.supply == GENESIS_BASE_UNITS,
            MyneError::InvalidSupply
        );
        require!(
            ctx.accounts.mint.mint_authority == COption::Some(ctx.accounts.config.key()),
            MyneError::InvalidMintAuthority
        );
        require!(
            ctx.accounts.mint.freeze_authority == COption::None,
            MyneError::InvalidFreezeAuthority
        );

        let config = &mut ctx.accounts.config;
        config.version = CURRENT_VERSION;
        config.bump = ctx.bumps.config;
        config.paused = true;
        config.admin = ctx.accounts.upgrade_authority.key();
        config.pending_admin = Pubkey::default();
        config.mint = ctx.accounts.mint.key();
        config.randomness_authority = args.randomness_authority;
        config.randomness_program = args.randomness_program;
        config.buyback_wallet = args.buyback_wallet;
        config.motherlode_wallet = args.motherlode_wallet;
        config.admin_fee_wallet = args.admin_fee_wallet;
        config.initialized_at = Clock::get()?.unix_timestamp;
        config.genesis_tokens = GENESIS_TOKENS;
        config.max_tokens = MAX_TOKENS;
        config.minimum_round_lamports = MINIMUM_ROUND_LAMPORTS;
        config.round_duration_seconds = ROUND_DURATION_SECONDS;
        config.betting_duration_seconds = BETTING_DURATION_SECONDS;
        config.unstake_delay_seconds = UNSTAKE_DELAY_SECONDS;
        config.motherlode_base_units = 0;
        config.motherlode_lamports = 0;
        config.virtual_burn_base_units = 0;

        let mining_pool = &mut ctx.accounts.mining_pool;
        mining_pool.bump = ctx.bumps.mining_pool;
        mining_pool.total_unclaimed = 0;
        mining_pool.reward_per_unclaimed = 0;
        mining_pool.undistributed_base_units = 0;

        let stake_pool = &mut ctx.accounts.stake_pool;
        stake_pool.bump = ctx.bumps.stake_pool;
        stake_pool.total_standard = 0;
        stake_pool.total_burn = 0;
        stake_pool.total_weight = 0;
        stake_pool.reward_per_weight = 0;
        stake_pool.undistributed_lamports = 0;
        stake_pool.total_funded_lamports = 0;
        stake_pool.total_claimed_lamports = 0;

        emit!(ProtocolInitialized {
            admin: config.admin,
            mint: config.mint,
            genesis_tokens: config.genesis_tokens,
            max_tokens: config.max_tokens
        });
        Ok(())
    }

    pub fn initialize_liquidity_gate(
        ctx: Context<InitializeLiquidityGate>,
        pool: Pubkey,
        pool_program: Pubkey,
        min_sol_lamports: u64,
        min_myne_base_units: u64,
    ) -> Result<()> {
        require!(ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require!(pool != Pubkey::default(), MyneError::InvalidLiquidityPool);
        require!(
            pool_program != Pubkey::default(),
            MyneError::InvalidLiquidityPool
        );
        require!(min_sol_lamports > 0, MyneError::InvalidLiquidityPool);
        require!(min_myne_base_units > 0, MyneError::InvalidLiquidityPool);
        if ctx.accounts.config.randomness_program != Pubkey::default() {
            require_keys_eq!(
                pool_program,
                METEORA_DLMM_PROGRAM,
                MyneError::InvalidLiquidityPool
            );
            let base_vault = ctx
                .accounts
                .base_vault
                .as_ref()
                .ok_or(MyneError::InvalidLiquidityPool)?;
            let quote_vault = ctx
                .accounts
                .quote_vault
                .as_ref()
                .ok_or(MyneError::InvalidLiquidityPool)?;
            require!(
                (base_vault.mint == ctx.accounts.config.mint
                    && quote_vault.mint == WRAPPED_SOL_MINT)
                    || (quote_vault.mint == ctx.accounts.config.mint
                        && base_vault.mint == WRAPPED_SOL_MINT),
                MyneError::InvalidLiquidityPool
            );
            let myne_vault = if base_vault.mint == ctx.accounts.config.mint {
                base_vault
            } else {
                quote_vault
            };
            let sol_vault = if base_vault.mint == WRAPPED_SOL_MINT {
                base_vault
            } else {
                quote_vault
            };
            require!(
                myne_vault.amount >= min_myne_base_units && sol_vault.amount >= min_sol_lamports,
                MyneError::InvalidLiquidityPool
            );
        }
        require!(
            ctx.accounts.pool.key() == pool,
            MyneError::InvalidLiquidityPool
        );
        require!(
            !ctx.accounts.pool.data_is_empty(),
            MyneError::InvalidLiquidityPool
        );
        require_keys_eq!(
            *ctx.accounts.pool.owner,
            pool_program,
            MyneError::InvalidLiquidityPool
        );

        let gate = &mut ctx.accounts.liquidity_gate;
        gate.bump = ctx.bumps.liquidity_gate;
        gate.pool = pool;
        gate.pool_program = pool_program;
        gate.min_sol_lamports = min_sol_lamports;
        gate.min_myne_base_units = min_myne_base_units;
        if let (Some(base_vault), Some(quote_vault)) = (
            ctx.accounts.base_vault.as_ref(),
            ctx.accounts.quote_vault.as_ref(),
        ) {
            gate.myne_vault = if base_vault.mint == ctx.accounts.config.mint {
                base_vault.key()
            } else {
                quote_vault.key()
            };
            gate.sol_vault = if base_vault.mint == WRAPPED_SOL_MINT {
                base_vault.key()
            } else {
                quote_vault.key()
            };
        } else {
            gate.myne_vault = Pubkey::default();
            gate.sol_vault = Pubkey::default();
        }
        gate.verified = true;
        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        if !paused && liquidity_gate_required(ctx.accounts.config.randomness_program) {
            let gate = ctx
                .accounts
                .liquidity_gate
                .as_ref()
                .ok_or_else(|| error!(MyneError::LiquidityPoolNotVerified))?;
            let pool = ctx
                .accounts
                .liquidity_pool
                .as_ref()
                .ok_or_else(|| error!(MyneError::LiquidityPoolNotVerified))?;
            assert_liquidity_pool(
                gate,
                &pool.to_account_info(),
                &ctx.accounts.config,
                ctx.accounts.base_vault.as_ref(),
                ctx.accounts.quote_vault.as_ref(),
            )?;
        }
        ctx.accounts.config.paused = paused;
        emit!(PauseChanged { paused });
        Ok(())
    }

    pub fn propose_admin(ctx: Context<AdminConfig>, pending_admin: Pubkey) -> Result<()> {
        require!(
            pending_admin != Pubkey::default(),
            MyneError::InvalidAuthority
        );
        ctx.accounts.config.pending_admin = pending_admin;
        emit!(AdminProposed { pending_admin });
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.pending_admin.key(),
            ctx.accounts.config.pending_admin,
            MyneError::InvalidPendingAdmin
        );
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.pending_admin.key();
        config.pending_admin = Pubkey::default();
        emit!(AdminAccepted {
            admin: config.admin
        });
        Ok(())
    }

    pub fn set_randomness_authority(
        ctx: Context<AdminConfig>,
        randomness_authority: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.config.paused,
            MyneError::RandomnessAuthorityLocked
        );
        require!(
            randomness_authority != Pubkey::default(),
            MyneError::InvalidAuthority
        );
        ctx.accounts.config.randomness_authority = randomness_authority;
        emit!(RandomnessAuthorityChanged {
            randomness_authority
        });
        Ok(())
    }

    /// Selects the randomness deployment mode while the protocol is paused.
    /// Devnet and the local harness intentionally do not require a Meteora
    /// pool; mainnet remains pool-gated. This is also the safe migration path
    /// for an already-initialized Devnet config.
    pub fn set_randomness_program(
        ctx: Context<AdminConfig>,
        randomness_program: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.config.paused,
            MyneError::RandomnessAuthorityLocked
        );
        require!(
            randomness_program == Pubkey::default()
                || randomness_program == SWITCHBOARD_DEVNET_PROGRAM
                || randomness_program == SWITCHBOARD_MAINNET_PROGRAM,
            MyneError::InvalidRandomnessAccount
        );
        ctx.accounts.config.randomness_program = randomness_program;
        emit!(RandomnessProgramChanged { randomness_program });
        Ok(())
    }

    pub fn register_miner(ctx: Context<RegisterMiner>, referrer: Pubkey) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require!(
            referrer != ctx.accounts.authority.key(),
            MyneError::InvalidReferrer
        );
        if referrer != Pubkey::default() {
            let referrer_miner = ctx
                .accounts
                .referrer_miner
                .as_ref()
                .ok_or(MyneError::InvalidReferrer)?;
            require_keys_eq!(
                referrer_miner.authority,
                referrer,
                MyneError::InvalidReferrer
            );
            require!(
                referrer_miner.referrer != ctx.accounts.authority.key(),
                MyneError::InvalidReferrer
            );
        }
        let miner = &mut ctx.accounts.miner;
        miner.bump = ctx.bumps.miner;
        miner.authority = ctx.accounts.authority.key();
        miner.referrer = referrer;
        miner.unclaimed_myne = 0;
        miner.passive_reward_debt = ctx.accounts.mining_pool.reward_per_unclaimed;
        miner.lifetime_deployed_lamports = 0;
        miner.lifetime_sol_claimed = 0;
        miner.lifetime_myne_claimed = 0;
        let position = &mut ctx.accounts.stake_position;
        position.bump = ctx.bumps.stake_position;
        position.authority = ctx.accounts.authority.key();
        position.standard_principal = 0;
        position.burn_principal = 0;
        position.reward_weight = 0;
        position.reward_debt = ctx.accounts.stake_pool.reward_per_weight;
        position.pending_sol = 0;
        position.cooldown_amount = 0;
        position.cooldown_unlock_at = 0;
        emit!(MinerRegistered {
            authority: miner.authority,
            referrer
        });
        Ok(())
    }

    pub fn open_round(ctx: Context<OpenRound>, round_id: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        let now = Clock::get()?.unix_timestamp;
        let round_offset_seconds = round_id
            .checked_mul(ctx.accounts.config.round_duration_seconds)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let round_offset_seconds = i64::try_from(round_offset_seconds)
            .map_err(|_| error!(MyneError::ArithmeticOverflow))?;
        let opened_at = ctx
            .accounts
            .config
            .initialized_at
            .checked_add(round_offset_seconds)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let betting_ends_at = opened_at
            .checked_add(BETTING_DURATION_SECONDS as i64)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let settles_at = betting_ends_at
            .checked_add(RESOLUTION_COUNTDOWN_SECONDS as i64)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let round_ends_at = opened_at
            .checked_add(ROUND_DURATION_SECONDS as i64)
            .ok_or(MyneError::ArithmeticOverflow)?;
        require!(
            now >= opened_at && now < betting_ends_at,
            MyneError::InvalidRoundSchedule
        );
        let round = &mut ctx.accounts.round;
        round.bump = ctx.bumps.round;
        round.id = round_id;
        round.opened_at = opened_at;
        round.betting_ends_at = betting_ends_at;
        round.settles_at = settles_at;
        round.refund_at = round_ends_at
            .checked_add(REFUND_DELAY_SECONDS)
            .ok_or(MyneError::ArithmeticOverflow)?;
        round.settled = false;
        round.winning_tile = u8::MAX;
        round.solo_mode = false;
        round.motherlode_hit = false;
        round.randomness = [0; 32];
        round.randomness_account = Pubkey::default();
        round.randomness_commit_slot = 0;
        round.solo_sample = 0;
        round.tile_lamports = [0; TILE_COUNT];
        round.tile_receipts = [0; TILE_COUNT];
        round.gross_deployed_lamports = 0;
        round.prize_lamports = 0;
        round.motherlode_payout_lamports = 0;
        round.claimed_lamports = 0;
        round.base_emission = 0;
        round.motherlode_emission = 0;
        emit!(RoundOpened {
            round_id,
            betting_ends_at: round.betting_ends_at,
            settles_at: round.settles_at
        });
        Ok(())
    }

    /// Bind a Switchboard randomness account before any deployment is accepted.
    /// The account must still be committed (not revealed) at bind time. This
    /// prevents a keeper or miner from selecting an already-known outcome.
    pub fn bind_round_randomness(ctx: Context<BindRoundRandomness>, round_id: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_keys_neq!(
            ctx.accounts.config.randomness_program,
            Pubkey::default(),
            MyneError::RandomnessProviderRequired
        );
        require!(ctx.accounts.round.id == round_id, MyneError::InvalidRound);
        require!(
            !ctx.accounts.round.settled
                && Clock::get()?.unix_timestamp < ctx.accounts.round.betting_ends_at,
            MyneError::BettingClosed
        );
        let clock = Clock::get()?;
        let parsed = parse_switchboard_randomness(
            &ctx.accounts.randomness_account.to_account_info(),
            &ctx.accounts.config.randomness_program,
        )?;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.randomness_authority,
            MyneError::InvalidRandomnessAuthority
        );
        require!(
            parsed.reveal_slot == 0 || parsed.reveal_slot > clock.slot,
            MyneError::RandomnessNotResolved
        );
        require!(
            ctx.accounts.round.randomness_account == Pubkey::default(),
            MyneError::RandomnessNotBound
        );
        ctx.accounts.round.randomness_account = ctx.accounts.randomness_account.key();
        ctx.accounts.round.randomness_commit_slot = clock.slot;
        Ok(())
    }

    pub fn deploy(
        ctx: Context<Deploy>,
        round_id: u64,
        nonce: u64,
        amounts: [u64; TILE_COUNT],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require!(ctx.accounts.round.id == round_id, MyneError::InvalidRound);
        require!(
            !ctx.accounts.round.settled
                && Clock::get()?.unix_timestamp < ctx.accounts.round.betting_ends_at,
            MyneError::BettingClosed
        );
        if ctx.accounts.config.randomness_program != Pubkey::default() {
            require_keys_neq!(
                ctx.accounts.round.randomness_account,
                Pubkey::default(),
                MyneError::RandomnessNotBound
            );
        }
        let total = checked_sum(&amounts)?;
        require!(
            total >= ctx.accounts.config.minimum_round_lamports,
            MyneError::DeploymentTooSmall
        );

        let round = &mut ctx.accounts.round;
        let receipt = &mut ctx.accounts.receipt;
        receipt.bump = ctx.bumps.receipt;
        receipt.round_id = round_id;
        receipt.authority = ctx.accounts.authority.key();
        receipt.nonce = nonce;
        receipt.amounts = amounts;
        receipt.cumulative_starts = round.tile_lamports;
        receipt.total_lamports = total;
        receipt.claimed = false;
        receipt.refunded = false;
        for (index, amount) in amounts.iter().enumerate() {
            round.tile_lamports[index] = checked_add(round.tile_lamports[index], *amount)?;
            if *amount > 0 {
                round.tile_receipts[index] = checked_add(round.tile_receipts[index], 1)?;
            }
        }
        round.gross_deployed_lamports = checked_add(round.gross_deployed_lamports, total)?;
        round.prize_lamports = checked_add(round.prize_lamports, total)?;
        ctx.accounts.miner.lifetime_deployed_lamports =
            checked_add(ctx.accounts.miner.lifetime_deployed_lamports, total)?;
        invoke(
            &system_instruction::transfer(&ctx.accounts.authority.key(), &round.key(), total),
            &[
                ctx.accounts.authority.to_account_info(),
                round.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        emit!(DeploymentCreated {
            round_id,
            authority: ctx.accounts.authority.key(),
            nonce,
            total_lamports: total
        });
        Ok(())
    }

    pub fn create_auto_plan(
        ctx: Context<CreateAutoPlan>,
        amounts: [u64; TILE_COUNT],
        deposit_lamports: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        let per_round = checked_sum(&amounts)?;
        require!(
            per_round >= ctx.accounts.config.minimum_round_lamports,
            MyneError::DeploymentTooSmall
        );
        let plan = &mut ctx.accounts.auto_plan;
        plan.bump = ctx.bumps.auto_plan;
        plan.authority = ctx.accounts.authority.key();
        plan.active = true;
        plan.amounts = amounts;
        plan.balance_lamports = deposit_lamports;
        plan.next_nonce = 0;
        plan.last_round = u64::MAX;
        if deposit_lamports > 0 {
            invoke(
                &system_instruction::transfer(
                    &ctx.accounts.authority.key(),
                    &plan.key(),
                    deposit_lamports,
                ),
                &[
                    ctx.accounts.authority.to_account_info(),
                    plan.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }
        emit!(AutoPlanConfigured {
            authority: plan.authority,
            per_round_lamports: per_round,
            balance_lamports: plan.balance_lamports,
            active: true
        });
        Ok(())
    }

    pub fn configure_auto_plan(
        ctx: Context<ManageAutoPlan>,
        amounts: [u64; TILE_COUNT],
        active: bool,
    ) -> Result<()> {
        let per_round = checked_sum(&amounts)?;
        require!(
            per_round >= ctx.accounts.config.minimum_round_lamports,
            MyneError::DeploymentTooSmall
        );
        ctx.accounts.auto_plan.amounts = amounts;
        ctx.accounts.auto_plan.active = active;
        emit!(AutoPlanConfigured {
            authority: ctx.accounts.authority.key(),
            per_round_lamports: per_round,
            balance_lamports: ctx.accounts.auto_plan.balance_lamports,
            active
        });
        Ok(())
    }

    pub fn fund_auto_plan(ctx: Context<FundAutoPlan>, lamports: u64) -> Result<()> {
        require!(lamports > 0, MyneError::InsufficientBalance);
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.authority.key(),
                &ctx.accounts.auto_plan.key(),
                lamports,
            ),
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.auto_plan.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        ctx.accounts.auto_plan.balance_lamports =
            checked_add(ctx.accounts.auto_plan.balance_lamports, lamports)?;
        emit!(AutoPlanFunded {
            authority: ctx.accounts.authority.key(),
            lamports,
            balance_lamports: ctx.accounts.auto_plan.balance_lamports
        });
        Ok(())
    }

    pub fn cancel_auto_plan(ctx: Context<ManageAutoPlan>) -> Result<()> {
        let amount = ctx.accounts.auto_plan.balance_lamports;
        move_lamports(
            &ctx.accounts.auto_plan.to_account_info(),
            &ctx.accounts.authority.to_account_info(),
            amount,
        )?;
        ctx.accounts.auto_plan.balance_lamports = 0;
        ctx.accounts.auto_plan.active = false;
        emit!(AutoPlanCancelled {
            authority: ctx.accounts.authority.key(),
            returned_lamports: amount
        });
        Ok(())
    }

    pub fn execute_auto_plan(
        ctx: Context<ExecuteAutoPlan>,
        round_id: u64,
        nonce: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require!(ctx.accounts.auto_plan.active, MyneError::AutoPlanInactive);
        require!(
            ctx.accounts.auto_plan.last_round != round_id,
            MyneError::AutoPlanAlreadyExecuted
        );
        require!(
            ctx.accounts.auto_plan.next_nonce == nonce,
            MyneError::InvalidRound
        );
        require!(ctx.accounts.round.id == round_id, MyneError::InvalidRound);
        if ctx.accounts.config.randomness_program != Pubkey::default() {
            require_keys_neq!(
                ctx.accounts.round.randomness_account,
                Pubkey::default(),
                MyneError::RandomnessNotBound
            );
        }
        require!(
            !ctx.accounts.round.settled
                && Clock::get()?.unix_timestamp < ctx.accounts.round.betting_ends_at,
            MyneError::BettingClosed
        );
        let amounts = ctx.accounts.auto_plan.amounts;
        let total = checked_sum(&amounts)?;
        require!(
            ctx.accounts.auto_plan.balance_lamports >= total,
            MyneError::InsufficientBalance
        );

        let receipt = &mut ctx.accounts.receipt;
        receipt.bump = ctx.bumps.receipt;
        receipt.round_id = round_id;
        receipt.authority = ctx.accounts.auto_plan.authority;
        receipt.nonce = nonce;
        receipt.amounts = amounts;
        receipt.cumulative_starts = ctx.accounts.round.tile_lamports;
        receipt.total_lamports = total;
        receipt.claimed = false;
        receipt.refunded = false;
        for (index, amount) in amounts.iter().enumerate() {
            ctx.accounts.round.tile_lamports[index] =
                checked_add(ctx.accounts.round.tile_lamports[index], *amount)?;
            if *amount > 0 {
                ctx.accounts.round.tile_receipts[index] =
                    checked_add(ctx.accounts.round.tile_receipts[index], 1)?;
            }
        }
        ctx.accounts.round.gross_deployed_lamports =
            checked_add(ctx.accounts.round.gross_deployed_lamports, total)?;
        ctx.accounts.round.prize_lamports = checked_add(ctx.accounts.round.prize_lamports, total)?;
        ctx.accounts.miner.lifetime_deployed_lamports =
            checked_add(ctx.accounts.miner.lifetime_deployed_lamports, total)?;
        move_lamports(
            &ctx.accounts.auto_plan.to_account_info(),
            &ctx.accounts.round.to_account_info(),
            total,
        )?;
        ctx.accounts.auto_plan.balance_lamports = ctx
            .accounts
            .auto_plan
            .balance_lamports
            .checked_sub(total)
            .ok_or(MyneError::ArithmeticOverflow)?;
        ctx.accounts.auto_plan.next_nonce = checked_add(ctx.accounts.auto_plan.next_nonce, 1)?;
        ctx.accounts.auto_plan.last_round = round_id;
        emit!(AutoPlanExecuted {
            authority: ctx.accounts.auto_plan.authority,
            executor: ctx.accounts.executor.key(),
            round_id,
            nonce,
            total_lamports: total,
            balance_lamports: ctx.accounts.auto_plan.balance_lamports
        });
        Ok(())
    }

    pub fn settle_round(ctx: Context<SettleRound>, randomness: [u8; 32]) -> Result<()> {
        // This path is retained solely for local/devnet rehearsal. Production
        // configurations set a Switchboard provider and therefore cannot use a
        // caller-supplied random byte array.
        require_keys_eq!(
            ctx.accounts.config.randomness_program,
            Pubkey::default(),
            MyneError::RandomnessProviderRequired
        );
        let liquidity_pool = ctx
            .accounts
            .liquidity_pool
            .as_ref()
            .map(|pool| pool.to_account_info());
        settle_round_core(
            &mut ctx.accounts.round,
            &mut ctx.accounts.config,
            &mut ctx.accounts.stake_pool,
            ctx.accounts.liquidity_gate.as_ref(),
            liquidity_pool.as_ref(),
            &ctx.accounts.buyback_wallet.to_account_info(),
            None,
            None,
            randomness,
        )
    }

    pub fn settle_round_verified(ctx: Context<SettleRoundVerified>) -> Result<()> {
        require!(!ctx.accounts.round.settled, MyneError::RoundAlreadySettled);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.round.settles_at && now < ctx.accounts.round.refund_at,
            MyneError::RoundNotReady
        );
        require_keys_eq!(
            ctx.accounts.round.randomness_account,
            ctx.accounts.randomness_account.key(),
            MyneError::InvalidRandomnessAccount
        );
        require_keys_eq!(
            ctx.accounts.buyback_wallet.key(),
            ctx.accounts.config.buyback_wallet,
            MyneError::InvalidFeeDestination
        );
        let clock = Clock::get()?;
        let randomness = parse_switchboard_randomness(
            &ctx.accounts.randomness_account.to_account_info(),
            &ctx.accounts.config.randomness_program,
        )?;
        require!(
            randomness.seed_slot >= ctx.accounts.round.randomness_commit_slot,
            MyneError::RandomnessCommittedTooLate
        );
        require!(
            randomness.seed_slot < clock.slot,
            MyneError::RandomnessNotResolved
        );
        // Switchboard's consume rule is deliberately strict: the randomness
        // must be consumed in the same slot in which it was revealed. This
        // prevents replaying an old favourable value.
        require!(
            randomness.reveal_slot == clock.slot,
            MyneError::RandomnessNotResolved
        );
        let liquidity_pool = ctx
            .accounts
            .liquidity_pool
            .as_ref()
            .map(|pool| pool.to_account_info());
        settle_round_core(
            &mut ctx.accounts.round,
            &mut ctx.accounts.config,
            &mut ctx.accounts.stake_pool,
            ctx.accounts.liquidity_gate.as_ref(),
            liquidity_pool.as_ref(),
            &ctx.accounts.buyback_wallet.to_account_info(),
            ctx.accounts.myne_vault.as_ref(),
            ctx.accounts.sol_vault.as_ref(),
            randomness.value,
        )
    }

    /*
    pub fn settle_round_legacy_body(ctx: Context<SettleRound>, randomness: [u8; 32]) -> Result<()> {
        assert_liquidity_pool(
            &ctx.accounts.liquidity_gate,
            &ctx.accounts.liquidity_pool.to_account_info(),
        )?;
        require!(!ctx.accounts.round.settled, MyneError::RoundAlreadySettled);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.round.settles_at && now < ctx.accounts.round.refund_at,
            MyneError::RoundNotReady
        );
        require_keys_eq!(
            ctx.accounts.randomness_authority.key(),
            ctx.accounts.config.randomness_authority,
            MyneError::InvalidRandomnessAuthority
        );
        require_keys_eq!(
            ctx.accounts.buyback_wallet.key(),
            ctx.accounts.config.buyback_wallet,
            MyneError::InvalidFeeDestination
        );

        let round = &mut ctx.accounts.round;
        let tile_hash = domain_hash(b"tile", round.id, &randomness);
        let mode_hash = domain_hash(b"mode", round.id, &randomness);
        let solo_hash = domain_hash(b"solo", round.id, &randomness);
        let motherlode_hash = domain_hash(b"motherlode", round.id, &randomness);
        let tile_sample = u64::from_le_bytes(
            tile_hash[..8]
                .try_into()
                .map_err(|_| error!(MyneError::ArithmeticOverflow))?,
        );
        let mode_sample = u64::from_le_bytes(
            mode_hash[..8]
                .try_into()
                .map_err(|_| error!(MyneError::ArithmeticOverflow))?,
        );
        let solo_sample = u64::from_le_bytes(
            solo_hash[..8]
                .try_into()
                .map_err(|_| error!(MyneError::ArithmeticOverflow))?,
        );
        let motherlode_sample = u64::from_le_bytes(
            motherlode_hash[..8]
                .try_into()
                .map_err(|_| error!(MyneError::ArithmeticOverflow))?,
        );
        let winning_tile = (tile_sample % TILE_COUNT as u64) as usize;
        round.winning_tile = winning_tile as u8;
        round.solo_mode = mode_sample % 2 == 0;
        round.motherlode_hit = motherlode_hit(motherlode_sample);
        round.randomness = randomness;
        let winning_total = round.tile_lamports[winning_tile];
        round.solo_sample = if winning_total == 0 {
            0
        } else {
            solo_sample % winning_total
        };

        let staking_fee = checked_bps(round.gross_deployed_lamports, MINING_STAKING_BPS)?;
        let buyback_fee = checked_bps(round.gross_deployed_lamports, MINING_BUYBACK_BPS)?;
        let motherlode_fee = checked_bps(round.gross_deployed_lamports, MINING_MOTHERLODE_BPS)?;
        let total_fee = checked_add(checked_add(staking_fee, buyback_fee)?, motherlode_fee)?;
        round.prize_lamports = round
            .gross_deployed_lamports
            .checked_sub(total_fee)
            .ok_or(MyneError::ArithmeticOverflow)?;
        move_lamports(
            &round.to_account_info(),
            &ctx.accounts.stake_pool.to_account_info(),
            staking_fee,
        )?;
        fund_stake_rewards(&mut ctx.accounts.stake_pool, staking_fee)?;
        move_lamports(
            &round.to_account_info(),
            &ctx.accounts.buyback_wallet.to_account_info(),
            buyback_fee,
        )?;
        emit!(BuybackAllocation {
            round_id: round.id,
            wallet: ctx.accounts.buyback_wallet.key(),
            lamports: buyback_fee,
        });
        move_lamports(
            &round.to_account_info(),
            &ctx.accounts.config.to_account_info(),
            motherlode_fee,
        )?;
        ctx.accounts.config.motherlode_lamports =
            checked_add(ctx.accounts.config.motherlode_lamports, motherlode_fee)?;
        ctx.accounts.config.motherlode_base_units = checked_add(
            ctx.accounts.config.motherlode_base_units,
            MOTHERLODE_ROUND_EMISSION,
        )?;
        round.base_emission = if winning_total > 0 {
            BASE_ROUND_EMISSION
        } else {
            0
        };
        if winning_total == 0 {
            let rollover = round.prize_lamports;
            move_lamports(
                &round.to_account_info(),
                &ctx.accounts.config.to_account_info(),
                rollover,
            )?;
            ctx.accounts.config.motherlode_lamports =
                checked_add(ctx.accounts.config.motherlode_lamports, rollover)?;
            round.prize_lamports = 0;
        } else if round.motherlode_hit {
            round.motherlode_emission = ctx.accounts.config.motherlode_base_units;
            ctx.accounts.config.motherlode_base_units = 0;
            let motherlode_payout = ctx.accounts.config.motherlode_lamports;
            move_lamports(
                &ctx.accounts.config.to_account_info(),
                &round.to_account_info(),
                motherlode_payout,
            )?;
            round.motherlode_payout_lamports = motherlode_payout;
            ctx.accounts.config.motherlode_lamports = 0;
        }
        round.settled = true;
        emit!(RoundSettled {
            round_id: round.id,
            winning_tile: round.winning_tile,
            solo_mode: round.solo_mode,
            motherlode_hit: round.motherlode_hit,
            prize_lamports: round.prize_lamports,
            motherlode_payout_lamports: round.motherlode_payout_lamports
        });
        Ok(())
    }
    */

    pub fn claim_receipt(ctx: Context<ClaimReceipt>) -> Result<()> {
        require!(ctx.accounts.round.settled, MyneError::RoundNotReady);
        require!(
            !ctx.accounts.receipt.claimed && !ctx.accounts.receipt.refunded,
            MyneError::ReceiptAlreadyProcessed
        );
        require_keys_eq!(
            ctx.accounts.receipt.authority,
            ctx.accounts.authority.key(),
            MyneError::InvalidReceiptAuthority
        );
        require!(
            ctx.accounts.receipt.round_id == ctx.accounts.round.id,
            MyneError::InvalidRound
        );
        checkpoint_miner(&mut ctx.accounts.miner, &ctx.accounts.mining_pool)?;
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;

        let tile = ctx.accounts.round.winning_tile as usize;
        let amount = ctx.accounts.receipt.amounts[tile];
        let winning_total = ctx.accounts.round.tile_lamports[tile];
        let mut sol_reward = 0;
        let mut myne_reward = 0;
        let mut motherlode_reward = 0;
        let mut motherlode_sol_reward = 0;
        if amount > 0 && winning_total > 0 {
            sol_reward = mul_div(ctx.accounts.round.prize_lamports, amount, winning_total)?;
            if ctx.accounts.round.solo_mode {
                let start = ctx.accounts.receipt.cumulative_starts[tile];
                let end = checked_add(start, amount)?;
                if ctx.accounts.round.solo_sample >= start && ctx.accounts.round.solo_sample < end {
                    myne_reward = ctx.accounts.round.base_emission;
                    motherlode_reward = ctx.accounts.round.motherlode_emission;
                }
            } else {
                myne_reward = mul_div(ctx.accounts.round.base_emission, amount, winning_total)?;
                motherlode_reward = mul_div(
                    ctx.accounts.round.motherlode_emission,
                    amount,
                    winning_total,
                )?;
            }
        }
        // A Motherlode hit is a round-wide shared payout. It is independent of the winning tile
        // and the normal solo/split mode: every miner receives their share of total round SOL.
        let (shared_sol_reward, shared_motherlode_reward) = motherlode_share(
            ctx.accounts.round.motherlode_payout_lamports,
            ctx.accounts.round.motherlode_emission,
            ctx.accounts.receipt.total_lamports,
            ctx.accounts.round.gross_deployed_lamports,
        )?;
        if shared_sol_reward > 0 || shared_motherlode_reward > 0 {
            motherlode_sol_reward = shared_sol_reward;
            motherlode_reward = shared_motherlode_reward;
        }
        sol_reward = checked_add(sol_reward, motherlode_sol_reward)?;
        if sol_reward > 0 {
            move_lamports(
                &ctx.accounts.round.to_account_info(),
                &ctx.accounts.authority.to_account_info(),
                sol_reward,
            )?;
            ctx.accounts.round.claimed_lamports =
                checked_add(ctx.accounts.round.claimed_lamports, sol_reward)?;
            ctx.accounts.miner.lifetime_sol_claimed =
                checked_add(ctx.accounts.miner.lifetime_sol_claimed, sol_reward)?;
        }
        if myne_reward > 0 {
            ctx.accounts.miner.unclaimed_myne =
                checked_add(ctx.accounts.miner.unclaimed_myne, myne_reward)?;
            ctx.accounts.mining_pool.total_unclaimed =
                checked_add(ctx.accounts.mining_pool.total_unclaimed, myne_reward)?;
            distribute_mining_rewards(&mut ctx.accounts.mining_pool, 0)?;
        }
        if motherlode_reward > 0 {
            let weight = motherlode_reward
                .checked_mul(BURN_WEIGHT_MULTIPLIER)
                .ok_or(MyneError::ArithmeticOverflow)?;
            ctx.accounts.stake_position.burn_principal = checked_add(
                ctx.accounts.stake_position.burn_principal,
                motherlode_reward,
            )?;
            ctx.accounts.stake_position.reward_weight =
                checked_add(ctx.accounts.stake_position.reward_weight, weight)?;
            ctx.accounts.stake_pool.total_burn =
                checked_add(ctx.accounts.stake_pool.total_burn, motherlode_reward)?;
            ctx.accounts.stake_pool.total_weight =
                checked_add(ctx.accounts.stake_pool.total_weight, weight)?;
            ctx.accounts.config.virtual_burn_base_units = checked_add(
                ctx.accounts.config.virtual_burn_base_units,
                motherlode_reward,
            )?;
            fund_stake_rewards(&mut ctx.accounts.stake_pool, 0)?;
        }
        ctx.accounts.receipt.claimed = true;
        emit!(ReceiptClaimed {
            round_id: ctx.accounts.round.id,
            authority: ctx.accounts.authority.key(),
            nonce: ctx.accounts.receipt.nonce,
            sol_lamports: sol_reward,
            myne_base_units: myne_reward,
            motherlode_base_units: motherlode_reward
        });
        Ok(())
    }

    pub fn refund_receipt(ctx: Context<RefundReceipt>) -> Result<()> {
        require!(
            !ctx.accounts.round.settled
                && Clock::get()?.unix_timestamp >= ctx.accounts.round.refund_at,
            MyneError::RoundNotReady
        );
        require!(
            !ctx.accounts.receipt.claimed && !ctx.accounts.receipt.refunded,
            MyneError::ReceiptAlreadyProcessed
        );
        require_keys_eq!(
            ctx.accounts.receipt.authority,
            ctx.accounts.authority.key(),
            MyneError::InvalidReceiptAuthority
        );
        move_lamports(
            &ctx.accounts.round.to_account_info(),
            &ctx.accounts.authority.to_account_info(),
            ctx.accounts.receipt.total_lamports,
        )?;
        for (index, amount) in ctx.accounts.receipt.amounts.iter().enumerate() {
            ctx.accounts.round.tile_lamports[index] = ctx.accounts.round.tile_lamports[index]
                .checked_sub(*amount)
                .ok_or(MyneError::ArithmeticOverflow)?;
        }
        ctx.accounts.round.gross_deployed_lamports = ctx
            .accounts
            .round
            .gross_deployed_lamports
            .checked_sub(ctx.accounts.receipt.total_lamports)
            .ok_or(MyneError::ArithmeticOverflow)?;
        ctx.accounts.round.prize_lamports = ctx
            .accounts
            .round
            .prize_lamports
            .checked_sub(ctx.accounts.receipt.total_lamports)
            .ok_or(MyneError::ArithmeticOverflow)?;
        ctx.accounts.receipt.refunded = true;
        emit!(ReceiptRefunded {
            round_id: ctx.accounts.round.id,
            authority: ctx.accounts.authority.key(),
            nonce: ctx.accounts.receipt.nonce,
            lamports: ctx.accounts.receipt.total_lamports
        });
        Ok(())
    }

    pub fn fund_staking_rewards(ctx: Context<FundStakingRewards>, lamports: u64) -> Result<()> {
        require!(lamports > 0, MyneError::InsufficientBalance);
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.funder.key(),
                &ctx.accounts.stake_pool.key(),
                lamports,
            ),
            &[
                ctx.accounts.funder.to_account_info(),
                ctx.accounts.stake_pool.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        fund_stake_rewards(&mut ctx.accounts.stake_pool, lamports)?;
        emit!(StakingRewardsFunded {
            funder: ctx.accounts.funder.key(),
            lamports
        });
        Ok(())
    }

    pub fn stake_standard(ctx: Context<StakeTokens>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require!(amount > 0, MyneError::InsufficientBalance);
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.owner_tokens.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault_tokens.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
            MYNE_DECIMALS,
        )?;
        ctx.accounts.stake_position.standard_principal =
            checked_add(ctx.accounts.stake_position.standard_principal, amount)?;
        ctx.accounts.stake_position.reward_weight =
            checked_add(ctx.accounts.stake_position.reward_weight, amount)?;
        ctx.accounts.stake_pool.total_standard =
            checked_add(ctx.accounts.stake_pool.total_standard, amount)?;
        ctx.accounts.stake_pool.total_weight =
            checked_add(ctx.accounts.stake_pool.total_weight, amount)?;
        fund_stake_rewards(&mut ctx.accounts.stake_pool, 0)?;
        emit!(StakeChanged {
            authority: ctx.accounts.authority.key(),
            standard_delta: amount as i128,
            burn_delta: 0
        });
        Ok(())
    }

    pub fn burn_stake(ctx: Context<BurnStake>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require!(amount > 0, MyneError::InsufficientBalance);
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.owner_tokens.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        let weight = amount
            .checked_mul(BURN_WEIGHT_MULTIPLIER)
            .ok_or(MyneError::ArithmeticOverflow)?;
        ctx.accounts.stake_position.burn_principal =
            checked_add(ctx.accounts.stake_position.burn_principal, amount)?;
        ctx.accounts.stake_position.reward_weight =
            checked_add(ctx.accounts.stake_position.reward_weight, weight)?;
        ctx.accounts.stake_pool.total_burn =
            checked_add(ctx.accounts.stake_pool.total_burn, amount)?;
        ctx.accounts.stake_pool.total_weight =
            checked_add(ctx.accounts.stake_pool.total_weight, weight)?;
        fund_stake_rewards(&mut ctx.accounts.stake_pool, 0)?;
        emit!(StakeChanged {
            authority: ctx.accounts.authority.key(),
            standard_delta: 0,
            burn_delta: amount as i128
        });
        Ok(())
    }

    pub fn request_unstake(ctx: Context<ManageStake>, amount: u64) -> Result<()> {
        require!(
            amount > 0 && amount <= ctx.accounts.stake_position.standard_principal,
            MyneError::InsufficientBalance
        );
        require!(
            ctx.accounts.stake_position.cooldown_amount == 0,
            MyneError::CooldownActive
        );
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;
        ctx.accounts.stake_position.standard_principal = ctx
            .accounts
            .stake_position
            .standard_principal
            .checked_sub(amount)
            .ok_or(MyneError::ArithmeticOverflow)?;
        ctx.accounts.stake_position.reward_weight = ctx
            .accounts
            .stake_position
            .reward_weight
            .checked_sub(amount)
            .ok_or(MyneError::ArithmeticOverflow)?;
        ctx.accounts.stake_position.cooldown_amount = amount;
        ctx.accounts.stake_position.cooldown_unlock_at = Clock::get()?
            .unix_timestamp
            .checked_add(UNSTAKE_DELAY_SECONDS as i64)
            .ok_or(MyneError::ArithmeticOverflow)?;
        ctx.accounts.stake_pool.total_standard = ctx
            .accounts
            .stake_pool
            .total_standard
            .checked_sub(amount)
            .ok_or(MyneError::ArithmeticOverflow)?;
        ctx.accounts.stake_pool.total_weight = ctx
            .accounts
            .stake_pool
            .total_weight
            .checked_sub(amount)
            .ok_or(MyneError::ArithmeticOverflow)?;
        emit!(UnstakeRequested {
            authority: ctx.accounts.authority.key(),
            amount,
            unlock_at: ctx.accounts.stake_position.cooldown_unlock_at
        });
        Ok(())
    }

    pub fn withdraw_unstaked(ctx: Context<WithdrawUnstaked>) -> Result<()> {
        require!(
            ctx.accounts.stake_position.cooldown_amount > 0,
            MyneError::InsufficientBalance
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.stake_position.cooldown_unlock_at,
            MyneError::CooldownActive
        );
        let amount = ctx.accounts.stake_position.cooldown_amount;
        let signer: &[&[&[u8]]] = &[&[STAKE_POOL_SEED, &[ctx.accounts.stake_pool.bump]]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault_tokens.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_tokens.to_account_info(),
                    authority: ctx.accounts.stake_pool.to_account_info(),
                },
                signer,
            ),
            amount,
            MYNE_DECIMALS,
        )?;
        ctx.accounts.stake_position.cooldown_amount = 0;
        ctx.accounts.stake_position.cooldown_unlock_at = 0;
        emit!(UnstakeWithdrawn {
            authority: ctx.accounts.authority.key(),
            amount
        });
        Ok(())
    }

    pub fn claim_staking_rewards(ctx: Context<ManageStake>) -> Result<()> {
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;
        let amount = ctx.accounts.stake_position.pending_sol;
        require!(amount > 0, MyneError::InsufficientBalance);
        move_lamports(
            &ctx.accounts.stake_pool.to_account_info(),
            &ctx.accounts.authority.to_account_info(),
            amount,
        )?;
        ctx.accounts.stake_position.pending_sol = 0;
        ctx.accounts.stake_pool.total_claimed_lamports =
            checked_add(ctx.accounts.stake_pool.total_claimed_lamports, amount)?;
        emit!(StakingRewardsClaimed {
            authority: ctx.accounts.authority.key(),
            lamports: amount
        });
        Ok(())
    }

    pub fn claim_myne(ctx: Context<ClaimMyne>) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        checkpoint_miner(&mut ctx.accounts.miner, &ctx.accounts.mining_pool)?;
        let gross = ctx.accounts.miner.unclaimed_myne;
        require!(gross > 0, MyneError::InsufficientBalance);
        ctx.accounts.miner.unclaimed_myne = 0;
        ctx.accounts.mining_pool.total_unclaimed = ctx
            .accounts
            .mining_pool
            .total_unclaimed
            .checked_sub(gross)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let total_fee = checked_bps(gross, CLAIM_FEE_BPS)?;
        let passive_fee = checked_bps(gross, CLAIM_PASSIVE_BPS)?;
        let referral_share = total_fee
            .checked_sub(passive_fee)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let has_referrer = ctx.accounts.miner.referrer != Pubkey::default();
        let referral_fee = if has_referrer { referral_share } else { 0 };
        let admin_fee = if has_referrer { 0 } else { referral_share };
        if referral_fee > 0 {
            let referrer = ctx
                .accounts
                .referrer_miner
                .as_mut()
                .ok_or(MyneError::InvalidReferrer)?;
            require_keys_eq!(
                referrer.authority,
                ctx.accounts.miner.referrer,
                MyneError::InvalidReferrer
            );
            checkpoint_miner(referrer, &ctx.accounts.mining_pool)?;
            referrer.unclaimed_myne = checked_add(referrer.unclaimed_myne, referral_fee)?;
            ctx.accounts.mining_pool.total_unclaimed =
                checked_add(ctx.accounts.mining_pool.total_unclaimed, referral_fee)?;
        }
        // Keep the passive holder pool at exactly 9%. If no referrer was recorded, the remaining
        // 1% is paid to the configured admin fee wallet instead of silently joining that pool.
        distribute_mining_rewards(&mut ctx.accounts.mining_pool, passive_fee)?;
        let net = gross
            .checked_sub(total_fee)
            .ok_or(MyneError::ArithmeticOverflow)?;
        // The fallback path mints the 1% admin allocation separately when no
        // referrer exists, so both mint legs must fit under the hard cap.
        let total_mint = checked_add(net, admin_fee)?;
        let max_supply = GENESIS_BASE_UNITS
            .checked_mul(MAX_TOKENS / GENESIS_TOKENS)
            .ok_or(MyneError::ArithmeticOverflow)?;
        require!(
            ctx.accounts
                .mint
                .supply
                .checked_add(total_mint)
                .ok_or(MyneError::ArithmeticOverflow)?
                <= max_supply,
            MyneError::InvalidSupply
        );
        let signer: &[&[&[u8]]] = &[&[CONFIG_SEED, &[ctx.accounts.config.bump]]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination_tokens.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            net,
        )?;
        if admin_fee > 0 {
            token_interface::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    MintTo {
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.admin_fee_tokens.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer,
                ),
                admin_fee,
            )?;
        }
        ctx.accounts.miner.lifetime_myne_claimed =
            checked_add(ctx.accounts.miner.lifetime_myne_claimed, net)?;
        ctx.accounts.miner.passive_reward_debt = ctx.accounts.mining_pool.reward_per_unclaimed;
        emit!(MyneClaimed {
            authority: ctx.accounts.authority.key(),
            gross_base_units: gross,
            net_base_units: net,
            fee_base_units: total_fee,
            referral_base_units: referral_fee,
            admin_base_units: admin_fee,
        });
        Ok(())
    }
}

fn checked_add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(MyneError::ArithmeticOverflow))
}
fn checked_sum(values: &[u64; TILE_COUNT]) -> Result<u64> {
    values
        .iter()
        .try_fold(0u64, |sum, value| checked_add(sum, *value))
}
fn mul_div(value: u64, numerator: u64, denominator: u64) -> Result<u64> {
    require!(denominator > 0, MyneError::ArithmeticOverflow);
    let result = (value as u128)
        .checked_mul(numerator as u128)
        .ok_or(MyneError::ArithmeticOverflow)?
        .checked_div(denominator as u128)
        .ok_or(MyneError::ArithmeticOverflow)?;
    u64::try_from(result).map_err(|_| error!(MyneError::ArithmeticOverflow))
}

/// Shares a Motherlode hit across every receipt in proportion to that receipt's
/// total round deployment. The SOL and MYNE legs use the same denominator, so
/// each claimant receives both awards atomically during `claim_receipt`.
fn motherlode_share(
    payout_lamports: u64,
    emission_base_units: u64,
    receipt_total_lamports: u64,
    round_total_lamports: u64,
) -> Result<(u64, u64)> {
    if payout_lamports == 0 || round_total_lamports == 0 || receipt_total_lamports == 0 {
        return Ok((0, 0));
    }
    Ok((
        mul_div(
            payout_lamports,
            receipt_total_lamports,
            round_total_lamports,
        )?,
        mul_div(
            emission_base_units,
            receipt_total_lamports,
            round_total_lamports,
        )?,
    ))
}

fn motherlode_hit(sample: u64) -> bool {
    sample.is_multiple_of(MOTHERLODE_ODDS)
}

fn assert_liquidity_pool(
    gate: &LiquidityGate,
    pool: &AccountInfo<'_>,
    config: &ProtocolConfig,
    base_vault: Option<&InterfaceAccount<'_, TokenAccount>>,
    quote_vault: Option<&InterfaceAccount<'_, TokenAccount>>,
) -> Result<()> {
    require!(gate.verified, MyneError::LiquidityPoolNotVerified);
    require_keys_eq!(pool.key(), gate.pool, MyneError::InvalidLiquidityPool);
    require!(!pool.data_is_empty(), MyneError::InvalidLiquidityPool);
    require_keys_eq!(
        *pool.owner,
        gate.pool_program,
        MyneError::InvalidLiquidityPool
    );
    if config.randomness_program != Pubkey::default() {
        require_keys_eq!(
            gate.pool_program,
            METEORA_DLMM_PROGRAM,
            MyneError::InvalidLiquidityPool
        );
        let base_vault = base_vault.ok_or(MyneError::InvalidLiquidityPool)?;
        let quote_vault = quote_vault.ok_or(MyneError::InvalidLiquidityPool)?;
        require_keys_eq!(
            base_vault.key(),
            gate.myne_vault,
            MyneError::InvalidLiquidityPool
        );
        require_keys_eq!(
            quote_vault.key(),
            gate.sol_vault,
            MyneError::InvalidLiquidityPool
        );
        require_keys_eq!(
            base_vault.mint,
            config.mint,
            MyneError::InvalidLiquidityPool
        );
        require_keys_eq!(
            quote_vault.mint,
            WRAPPED_SOL_MINT,
            MyneError::InvalidLiquidityPool
        );
        require!(
            base_vault.amount >= gate.min_myne_base_units
                && quote_vault.amount >= gate.min_sol_lamports,
            MyneError::InvalidLiquidityPool
        );
    }
    Ok(())
}

#[cfg(test)]
mod motherlode_tests {
    use super::{
        checked_bps, liquidity_gate_required, motherlode_hit, motherlode_share, mul_div,
        BASE_ROUND_EMISSION, BURN_WEIGHT_MULTIPLIER, MINING_PROTOCOL_FEE_BPS, MOTHERLODE_ODDS,
        SWITCHBOARD_DEVNET_PROGRAM, SWITCHBOARD_MAINNET_PROGRAM,
    };

    #[test]
    fn devnet_provider_does_not_require_a_pool() {
        assert!(!liquidity_gate_required(SWITCHBOARD_DEVNET_PROGRAM));
    }

    #[test]
    fn mainnet_provider_remains_pool_gated() {
        assert!(liquidity_gate_required(SWITCHBOARD_MAINNET_PROGRAM));
    }

    #[test]
    fn motherlode_is_one_in_650_per_round() {
        assert!(motherlode_hit(0));
        assert!(motherlode_hit(MOTHERLODE_ODDS));
        assert!(!motherlode_hit(1));
        assert!(!motherlode_hit(MOTHERLODE_ODDS - 1));
    }

    #[test]
    fn motherlode_shares_sol_and_myne_by_total_deployment() {
        let (sol, myne) = motherlode_share(13_000, 200, 25, 100).unwrap();
        assert_eq!(sol, 3_250);
        assert_eq!(myne, 50);
    }

    #[test]
    fn split_winning_rewards_follow_each_receipts_tile_contribution() {
        let prize_lamports = 880_000_000;
        let winning_tile_total = 1_000_000_000;
        let larger_share = 900_000_000;
        let smaller_share = 100_000_000;

        assert_eq!(
            mul_div(prize_lamports, larger_share, winning_tile_total).unwrap(),
            792_000_000
        );
        assert_eq!(
            mul_div(prize_lamports, smaller_share, winning_tile_total).unwrap(),
            88_000_000
        );
        assert_eq!(
            mul_div(BASE_ROUND_EMISSION, larger_share, winning_tile_total).unwrap(),
            900_000_000
        );
        assert_eq!(
            mul_div(BASE_ROUND_EMISSION, smaller_share, winning_tile_total).unwrap(),
            100_000_000
        );
    }

    #[test]
    fn winning_prize_includes_losing_tile_deployments_after_the_twelve_percent_fee() {
        // Two SOL are deployed in total: only 0.10 SOL is on the winning tile and the
        // remaining 1.90 SOL is on losing tiles. The 12% fee is taken from the full 2 SOL,
        // so a 0.02 SOL winning-tile share receives 20% of the 1.76 SOL prize.
        let gross: u64 = 2_000_000_000;
        let fee = checked_bps(gross, MINING_PROTOCOL_FEE_BPS).unwrap();
        let prize = gross.checked_sub(fee).unwrap();
        assert_eq!(fee, 240_000_000);
        assert_eq!(prize, 1_760_000_000);
        assert_eq!(
            mul_div(prize, 20_000_000, 100_000_000).unwrap(),
            352_000_000
        );
    }

    #[test]
    fn empty_motherlode_share_is_zero_and_burn_weight_is_five_x() {
        assert_eq!(motherlode_share(13_000, 200, 0, 100).unwrap(), (0, 0));
        assert_eq!(
            200_000_000u64.checked_mul(BURN_WEIGHT_MULTIPLIER).unwrap(),
            1_000_000_000
        );
    }
}
fn domain_hash(domain: &[u8], round_id: u64, randomness: &[u8; 32]) -> [u8; 32] {
    hashv(&[b"MYNE_V1", domain, &round_id.to_le_bytes(), randomness]).to_bytes()
}

#[allow(clippy::too_many_arguments)]
fn settle_round_core(
    round: &mut Account<Round>,
    config: &mut Account<ProtocolConfig>,
    stake_pool: &mut Account<StakePool>,
    liquidity_gate: Option<&Account<LiquidityGate>>,
    liquidity_pool: Option<&AccountInfo<'_>>,
    buyback_wallet: &AccountInfo<'_>,
    myne_vault: Option<&InterfaceAccount<'_, TokenAccount>>,
    sol_vault: Option<&InterfaceAccount<'_, TokenAccount>>,
    randomness: [u8; 32],
) -> Result<()> {
    if liquidity_gate_required(config.randomness_program) {
        let gate = liquidity_gate.ok_or(MyneError::LiquidityPoolNotVerified)?;
        let pool = liquidity_pool.ok_or(MyneError::LiquidityPoolNotVerified)?;
        assert_liquidity_pool(gate, pool, config, myne_vault, sol_vault)?;
    }
    require!(!round.settled, MyneError::RoundAlreadySettled);
    let tile_hash = domain_hash(b"tile", round.id, &randomness);
    let mode_hash = domain_hash(b"mode", round.id, &randomness);
    let solo_hash = domain_hash(b"solo", round.id, &randomness);
    let motherlode_hash = domain_hash(b"motherlode", round.id, &randomness);
    let tile_sample = u64::from_le_bytes(
        tile_hash[..8]
            .try_into()
            .map_err(|_| error!(MyneError::ArithmeticOverflow))?,
    );
    let mode_sample = u64::from_le_bytes(
        mode_hash[..8]
            .try_into()
            .map_err(|_| error!(MyneError::ArithmeticOverflow))?,
    );
    let solo_sample = u64::from_le_bytes(
        solo_hash[..8]
            .try_into()
            .map_err(|_| error!(MyneError::ArithmeticOverflow))?,
    );
    let motherlode_sample = u64::from_le_bytes(
        motherlode_hash[..8]
            .try_into()
            .map_err(|_| error!(MyneError::ArithmeticOverflow))?,
    );
    let winning_tile = (tile_sample % TILE_COUNT as u64) as usize;
    round.winning_tile = winning_tile as u8;
    round.solo_mode = mode_sample % 2 == 0;
    round.motherlode_hit = motherlode_hit(motherlode_sample);
    round.randomness = randomness;
    let winning_total = round.tile_lamports[winning_tile];
    round.solo_sample = if winning_total > 0 {
        solo_sample % winning_total
    } else {
        0
    };

    let staking_fee = checked_bps(round.gross_deployed_lamports, MINING_STAKING_BPS)?;
    let buyback_fee = checked_bps(round.gross_deployed_lamports, MINING_BUYBACK_BPS)?;
    let motherlode_fee = checked_bps(round.gross_deployed_lamports, MINING_MOTHERLODE_BPS)?;
    let total_fee = checked_add(checked_add(staking_fee, buyback_fee)?, motherlode_fee)?;
    round.prize_lamports = round
        .gross_deployed_lamports
        .checked_sub(total_fee)
        .ok_or(MyneError::ArithmeticOverflow)?;
    move_lamports(
        &round.to_account_info(),
        &stake_pool.to_account_info(),
        staking_fee,
    )?;
    fund_stake_rewards(stake_pool, staking_fee)?;
    move_lamports(&round.to_account_info(), buyback_wallet, buyback_fee)?;
    emit!(BuybackAllocation {
        round_id: round.id,
        wallet: *buyback_wallet.key,
        lamports: buyback_fee,
    });
    move_lamports(
        &round.to_account_info(),
        &config.to_account_info(),
        motherlode_fee,
    )?;
    config.motherlode_lamports = checked_add(config.motherlode_lamports, motherlode_fee)?;
    config.motherlode_base_units =
        checked_add(config.motherlode_base_units, MOTHERLODE_ROUND_EMISSION)?;
    round.base_emission = if winning_total > 0 {
        BASE_ROUND_EMISSION
    } else {
        0
    };
    if winning_total == 0 {
        let rollover = round.prize_lamports;
        move_lamports(
            &round.to_account_info(),
            &config.to_account_info(),
            rollover,
        )?;
        config.motherlode_lamports = checked_add(config.motherlode_lamports, rollover)?;
        round.prize_lamports = 0;
    } else if round.motherlode_hit {
        round.motherlode_emission = config.motherlode_base_units;
        config.motherlode_base_units = 0;
        let motherlode_payout = config.motherlode_lamports;
        move_lamports(
            &config.to_account_info(),
            &round.to_account_info(),
            motherlode_payout,
        )?;
        round.motherlode_payout_lamports = motherlode_payout;
        config.motherlode_lamports = 0;
    }
    round.settled = true;
    emit!(RoundSettled {
        round_id: round.id,
        winning_tile: round.winning_tile,
        solo_mode: round.solo_mode,
        motherlode_hit: round.motherlode_hit,
        prize_lamports: round.prize_lamports,
        motherlode_payout_lamports: round.motherlode_payout_lamports,
    });
    Ok(())
}

/// Mainnet settlement is pool-gated. Devnet deliberately runs without a
/// Meteora dependency so the full mining/staking flow can be exercised before
/// production liquidity exists. Unknown providers fail closed and remain
/// pool-gated.
fn liquidity_gate_required(randomness_program: Pubkey) -> bool {
    randomness_program != SWITCHBOARD_DEVNET_PROGRAM && randomness_program != Pubkey::default()
}

struct SwitchboardRandomness {
    seed_slot: u64,
    reveal_slot: u64,
    value: [u8; 32],
}

/// Parse the stable zero-copy Switchboard randomness account layout without
/// importing its Anchor SDK. The SDK documents an 8-byte discriminator
/// followed by the account fields; keeping this parser local avoids pulling a
/// second Anchor version into the MYNE program.
fn parse_switchboard_randomness(
    account: &AccountInfo<'_>,
    expected_owner: &Pubkey,
) -> Result<SwitchboardRandomness> {
    require_keys_eq!(
        *account.owner,
        *expected_owner,
        MyneError::InvalidRandomnessAccount
    );
    let data = account
        .try_borrow_data()
        .map_err(|_| error!(MyneError::InvalidRandomnessAccount))?;
    require!(
        data.len() >= SWITCHBOARD_RANDOMNESS_ACCOUNT_SIZE,
        MyneError::InvalidRandomnessAccount
    );
    require!(
        data[..8] == SWITCHBOARD_RANDOMNESS_DISCRIMINATOR,
        MyneError::InvalidRandomnessAccount
    );
    let seed_slot = u64::from_le_bytes(
        data[104..112]
            .try_into()
            .map_err(|_| error!(MyneError::InvalidRandomnessAccount))?,
    );
    let reveal_slot = u64::from_le_bytes(
        data[144..152]
            .try_into()
            .map_err(|_| error!(MyneError::InvalidRandomnessAccount))?,
    );
    let mut value = [0u8; 32];
    value.copy_from_slice(&data[152..184]);
    Ok(SwitchboardRandomness {
        seed_slot,
        reveal_slot,
        value,
    })
}
fn move_lamports(from: &AccountInfo<'_>, to: &AccountInfo<'_>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(MyneError::InsufficientBalance)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(MyneError::ArithmeticOverflow)?;
    Ok(())
}
fn checkpoint_miner(miner: &mut Account<Miner>, pool: &MiningPool) -> Result<()> {
    if pool.reward_per_unclaimed > miner.passive_reward_debt && miner.unclaimed_myne > 0 {
        let delta = pool
            .reward_per_unclaimed
            .checked_sub(miner.passive_reward_debt)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let reward = (miner.unclaimed_myne as u128)
            .checked_mul(delta)
            .ok_or(MyneError::ArithmeticOverflow)?
            .checked_div(REWARD_SCALE)
            .ok_or(MyneError::ArithmeticOverflow)?;
        miner.unclaimed_myne = checked_add(
            miner.unclaimed_myne,
            u64::try_from(reward).map_err(|_| error!(MyneError::ArithmeticOverflow))?,
        )?;
    }
    miner.passive_reward_debt = pool.reward_per_unclaimed;
    Ok(())
}
fn distribute_mining_rewards(pool: &mut MiningPool, amount: u64) -> Result<()> {
    let total = checked_add(amount, pool.undistributed_base_units)?;
    if pool.total_unclaimed == 0 {
        pool.undistributed_base_units = total;
        return Ok(());
    }
    let increment = (total as u128)
        .checked_mul(REWARD_SCALE)
        .ok_or(MyneError::ArithmeticOverflow)?
        .checked_div(pool.total_unclaimed as u128)
        .ok_or(MyneError::ArithmeticOverflow)?;
    pool.reward_per_unclaimed = pool
        .reward_per_unclaimed
        .checked_add(increment)
        .ok_or(MyneError::ArithmeticOverflow)?;
    pool.total_unclaimed = checked_add(pool.total_unclaimed, total)?;
    pool.undistributed_base_units = 0;
    Ok(())
}
fn checkpoint_stake(position: &mut Account<StakePosition>, pool: &StakePool) -> Result<()> {
    if pool.reward_per_weight > position.reward_debt && position.reward_weight > 0 {
        let delta = pool
            .reward_per_weight
            .checked_sub(position.reward_debt)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let reward = (position.reward_weight as u128)
            .checked_mul(delta)
            .ok_or(MyneError::ArithmeticOverflow)?
            .checked_div(REWARD_SCALE)
            .ok_or(MyneError::ArithmeticOverflow)?;
        position.pending_sol = checked_add(
            position.pending_sol,
            u64::try_from(reward).map_err(|_| error!(MyneError::ArithmeticOverflow))?,
        )?;
    }
    position.reward_debt = pool.reward_per_weight;
    Ok(())
}
fn fund_stake_rewards(pool: &mut Account<StakePool>, amount: u64) -> Result<()> {
    pool.total_funded_lamports = checked_add(pool.total_funded_lamports, amount)?;
    let total = checked_add(amount, pool.undistributed_lamports)?;
    if pool.total_weight == 0 {
        pool.undistributed_lamports = total;
        return Ok(());
    }
    let increment = (total as u128)
        .checked_mul(REWARD_SCALE)
        .ok_or(MyneError::ArithmeticOverflow)?
        .checked_div(pool.total_weight as u128)
        .ok_or(MyneError::ArithmeticOverflow)?;
    pool.reward_per_weight = pool
        .reward_per_weight
        .checked_add(increment)
        .ok_or(MyneError::ArithmeticOverflow)?;
    pool.undistributed_lamports = 0;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeArgs {
    pub randomness_authority: Pubkey,
    /// Switchboard On-Demand program ID. A default key explicitly selects the
    /// local/devnet legacy randomness harness and is rejected for production
    /// settlement by the verified instruction.
    pub randomness_program: Pubkey,
    pub buyback_wallet: Pubkey,
    pub motherlode_wallet: Pubkey,
    pub admin_fee_wallet: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub version: u8,
    pub bump: u8,
    pub paused: bool,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub mint: Pubkey,
    pub randomness_authority: Pubkey,
    pub randomness_program: Pubkey,
    pub buyback_wallet: Pubkey,
    pub motherlode_wallet: Pubkey,
    pub admin_fee_wallet: Pubkey,
    pub initialized_at: i64,
    pub genesis_tokens: u64,
    pub max_tokens: u64,
    pub minimum_round_lamports: u64,
    pub round_duration_seconds: u64,
    pub betting_duration_seconds: u64,
    pub unstake_delay_seconds: u64,
    pub motherlode_base_units: u64,
    pub motherlode_lamports: u64,
    pub virtual_burn_base_units: u64,
}

#[account]
#[derive(InitSpace)]
pub struct LiquidityGate {
    pub bump: u8,
    pub verified: bool,
    pub pool: Pubkey,
    pub pool_program: Pubkey,
    pub min_sol_lamports: u64,
    pub min_myne_base_units: u64,
    pub myne_vault: Pubkey,
    pub sol_vault: Pubkey,
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(init, payer = payer, space = 8 + ProtocolConfig::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(init, payer = payer, space = 8 + MiningPool::INIT_SPACE, seeds = [MINING_POOL_SEED], bump)]
    pub mining_pool: Account<'info, MiningPool>,
    #[account(init, payer = payer, space = 8 + StakePool::INIT_SPACE, seeds = [STAKE_POOL_SEED], bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ MyneError::InvalidProgramData)]
    pub program: Program<'info>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ MyneError::InvalidUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub upgrade_authority: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump, has_one=admin)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(seeds=[LIQUIDITY_GATE_SEED], bump)]
    pub liquidity_gate: Option<Account<'info, LiquidityGate>>,
    /// CHECK: The account is checked against the immutable pool and owner stored in LiquidityGate.
    pub liquidity_pool: Option<UncheckedAccount<'info>>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeLiquidityGate<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump, has_one=admin)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(init, payer=admin, space=8+LiquidityGate::INIT_SPACE, seeds=[LIQUIDITY_GATE_SEED], bump)]
    pub liquidity_gate: Account<'info, LiquidityGate>,
    /// CHECK: The pool is verified by its exact configured address and owner program.
    pub pool: UncheckedAccount<'info>,
    /// Optional for local legacy mode; mandatory when a Switchboard provider is configured.
    pub base_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    pub quote_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump, has_one=admin)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(seeds=[LIQUIDITY_GATE_SEED], bump)]
    pub liquidity_gate: Option<Account<'info, LiquidityGate>>,
    /// CHECK: The pool address and owner are checked against the immutable gate.
    pub liquidity_pool: Option<UncheckedAccount<'info>>,
    pub base_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    pub quote_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    pub admin: Signer<'info>,
}
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    pub pending_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegisterMiner<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Account<'info, MiningPool>,
    #[account(seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(init, payer=authority, space=8+Miner::INIT_SPACE, seeds=[MINER_SEED, authority.key().as_ref()], bump)]
    pub miner: Account<'info, Miner>,
    #[account(init, payer=authority, space=8+StakePosition::INIT_SPACE, seeds=[STAKE_POSITION_SEED, authority.key().as_ref()], bump)]
    pub stake_position: Account<'info, StakePosition>,
    pub referrer_miner: Option<Account<'info, Miner>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct OpenRound<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(init, payer=payer, space=8+Round::INIT_SPACE, seeds=[ROUND_SEED, &round_id.to_le_bytes()], bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct BindRoundRandomness<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[ROUND_SEED, &round_id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: owner, discriminator and freshness are validated in the handler.
    pub randomness_account: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
#[instruction(round_id: u64, nonce: u64)]
pub struct Deploy<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[MINER_SEED, authority.key().as_ref()], bump=miner.bump, has_one=authority)]
    pub miner: Account<'info, Miner>,
    #[account(mut, seeds=[ROUND_SEED, &round_id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(init, payer=authority, space=8+BetReceipt::INIT_SPACE, seeds=[BET_SEED, &round_id.to_le_bytes(), authority.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub receipt: Box<Account<'info, BetReceipt>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct CreateAutoPlan<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(init, payer=authority, space=8+AutoPlan::INIT_SPACE, seeds=[b"auto_plan", authority.key().as_ref()], bump)]
    pub auto_plan: Account<'info, AutoPlan>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ManageAutoPlan<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[b"auto_plan", authority.key().as_ref()], bump=auto_plan.bump, has_one=authority)]
    pub auto_plan: Account<'info, AutoPlan>,
    #[account(mut)]
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct FundAutoPlan<'info> {
    #[account(mut, seeds=[b"auto_plan", authority.key().as_ref()], bump=auto_plan.bump, has_one=authority)]
    pub auto_plan: Account<'info, AutoPlan>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(round_id: u64, nonce: u64)]
pub struct ExecuteAutoPlan<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[b"auto_plan", auto_plan.authority.as_ref()], bump=auto_plan.bump)]
    pub auto_plan: Account<'info, AutoPlan>,
    #[account(mut, seeds=[MINER_SEED, auto_plan.authority.as_ref()], bump=miner.bump)]
    pub miner: Account<'info, Miner>,
    #[account(mut, seeds=[ROUND_SEED, &round_id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(init, payer=executor, space=8+BetReceipt::INIT_SPACE, seeds=[BET_SEED, &round_id.to_le_bytes(), auto_plan.authority.as_ref(), &nonce.to_le_bytes()], bump)]
    pub receipt: Box<Account<'info, BetReceipt>>,
    #[account(mut)]
    pub executor: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SettleRound<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Box<Account<'info, StakePool>>,
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(seeds=[LIQUIDITY_GATE_SEED], bump=liquidity_gate.bump)]
    pub liquidity_gate: Option<Account<'info, LiquidityGate>>,
    /// CHECK: The pool address and owner are checked against LiquidityGate before settlement.
    pub liquidity_pool: Option<UncheckedAccount<'info>>,
    pub randomness_authority: Signer<'info>,
    /// CHECK: Address constrained to immutable configuration.
    #[account(mut)]
    pub buyback_wallet: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct SettleRoundVerified<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Box<Account<'info, StakePool>>,
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(seeds=[LIQUIDITY_GATE_SEED], bump=liquidity_gate.bump)]
    pub liquidity_gate: Option<Account<'info, LiquidityGate>>,
    /// CHECK: pool key and owner are checked against LiquidityGate.
    pub liquidity_pool: Option<UncheckedAccount<'info>>,
    pub myne_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    pub sol_vault: Option<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: owner, discriminator, account binding and freshness are checked
    /// by parse_switchboard_randomness and the settlement handler.
    pub randomness_account: UncheckedAccount<'info>,
    /// CHECK: constrained to the immutable configured fee destination.
    #[account(mut)]
    pub buyback_wallet: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct ClaimReceipt<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Box<Account<'info, MiningPool>>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Box<Account<'info, StakePool>>,
    #[account(mut, seeds=[MINER_SEED, authority.key().as_ref()], bump=miner.bump, has_one=authority)]
    pub miner: Account<'info, Miner>,
    #[account(mut, seeds=[STAKE_POSITION_SEED, authority.key().as_ref()], bump=stake_position.bump, has_one=authority)]
    pub stake_position: Account<'info, StakePosition>,
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds=[BET_SEED, &round.id.to_le_bytes(), authority.key().as_ref(), &receipt.nonce.to_le_bytes()], bump=receipt.bump)]
    pub receipt: Box<Account<'info, BetReceipt>>,
    #[account(mut)]
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct RefundReceipt<'info> {
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds=[BET_SEED, &round.id.to_le_bytes(), authority.key().as_ref(), &receipt.nonce.to_le_bytes()], bump=receipt.bump)]
    pub receipt: Box<Account<'info, BetReceipt>>,
    #[account(mut)]
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct FundStakingRewards<'info> {
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut)]
    pub funder: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct StakeTokens<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump, has_one=mint)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut, seeds=[STAKE_POSITION_SEED, authority.key().as_ref()], bump=stake_position.bump, has_one=authority)]
    pub stake_position: Account<'info, StakePosition>,
    #[account(mut, token::mint=mint, token::authority=authority)]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint=mint, token::authority=stake_pool)]
    pub vault_tokens: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct BurnStake<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump, has_one=mint)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut, seeds=[STAKE_POSITION_SEED, authority.key().as_ref()], bump=stake_position.bump, has_one=authority)]
    pub stake_position: Account<'info, StakePosition>,
    #[account(mut, token::mint=mint, token::authority=authority)]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct ManageStake<'info> {
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut, seeds=[STAKE_POSITION_SEED, authority.key().as_ref()], bump=stake_position.bump, has_one=authority)]
    pub stake_position: Account<'info, StakePosition>,
    #[account(mut)]
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct WithdrawUnstaked<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump, has_one=mint)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut, seeds=[STAKE_POSITION_SEED, authority.key().as_ref()], bump=stake_position.bump, has_one=authority)]
    pub stake_position: Account<'info, StakePosition>,
    #[account(mut, token::mint=mint, token::authority=authority)]
    pub owner_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint=mint, token::authority=stake_pool)]
    pub vault_tokens: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
pub struct ClaimMyne<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump, has_one=mint)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Account<'info, MiningPool>,
    #[account(mut, seeds=[MINER_SEED, authority.key().as_ref()], bump=miner.bump, has_one=authority)]
    pub miner: Account<'info, Miner>,
    #[account(mut)]
    pub referrer_miner: Option<Account<'info, Miner>>,
    #[account(mut, token::mint=mint, token::authority=authority)]
    pub destination_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint=mint, token::authority=config.admin_fee_wallet)]
    pub admin_fee_tokens: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct ProtocolInitialized {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub genesis_tokens: u64,
    pub max_tokens: u64,
}
#[event]
pub struct PauseChanged {
    pub paused: bool,
}
#[event]
pub struct AdminProposed {
    pub pending_admin: Pubkey,
}
#[event]
pub struct AdminAccepted {
    pub admin: Pubkey,
}
#[event]
pub struct RandomnessAuthorityChanged {
    pub randomness_authority: Pubkey,
}
#[event]
pub struct RandomnessProgramChanged {
    pub randomness_program: Pubkey,
}
#[event]
pub struct MinerRegistered {
    pub authority: Pubkey,
    pub referrer: Pubkey,
}
#[event]
pub struct RoundOpened {
    pub round_id: u64,
    pub betting_ends_at: i64,
    pub settles_at: i64,
}
#[event]
pub struct DeploymentCreated {
    pub round_id: u64,
    pub authority: Pubkey,
    pub nonce: u64,
    pub total_lamports: u64,
}
#[event]
pub struct AutoPlanConfigured {
    pub authority: Pubkey,
    pub per_round_lamports: u64,
    pub balance_lamports: u64,
    pub active: bool,
}
#[event]
pub struct AutoPlanFunded {
    pub authority: Pubkey,
    pub lamports: u64,
    pub balance_lamports: u64,
}
#[event]
pub struct AutoPlanCancelled {
    pub authority: Pubkey,
    pub returned_lamports: u64,
}
#[event]
pub struct AutoPlanExecuted {
    pub authority: Pubkey,
    pub executor: Pubkey,
    pub round_id: u64,
    pub nonce: u64,
    pub total_lamports: u64,
    pub balance_lamports: u64,
}
#[event]
pub struct RoundSettled {
    pub round_id: u64,
    pub winning_tile: u8,
    pub solo_mode: bool,
    pub motherlode_hit: bool,
    pub prize_lamports: u64,
    pub motherlode_payout_lamports: u64,
}
#[event]
pub struct BuybackAllocation {
    pub round_id: u64,
    pub wallet: Pubkey,
    pub lamports: u64,
}
#[event]
pub struct ReceiptClaimed {
    pub round_id: u64,
    pub authority: Pubkey,
    pub nonce: u64,
    pub sol_lamports: u64,
    pub myne_base_units: u64,
    pub motherlode_base_units: u64,
}
#[event]
pub struct ReceiptRefunded {
    pub round_id: u64,
    pub authority: Pubkey,
    pub nonce: u64,
    pub lamports: u64,
}
#[event]
pub struct StakingRewardsFunded {
    pub funder: Pubkey,
    pub lamports: u64,
}
#[event]
pub struct StakeChanged {
    pub authority: Pubkey,
    pub standard_delta: i128,
    pub burn_delta: i128,
}
#[event]
pub struct UnstakeRequested {
    pub authority: Pubkey,
    pub amount: u64,
    pub unlock_at: i64,
}
#[event]
pub struct UnstakeWithdrawn {
    pub authority: Pubkey,
    pub amount: u64,
}
#[event]
pub struct StakingRewardsClaimed {
    pub authority: Pubkey,
    pub lamports: u64,
}
#[event]
pub struct MyneClaimed {
    pub authority: Pubkey,
    pub gross_base_units: u64,
    pub net_base_units: u64,
    pub fee_base_units: u64,
    pub referral_base_units: u64,
    pub admin_base_units: u64,
}
