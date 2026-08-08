use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program_option::COption, system_instruction};
use anchor_spl::token::{self as legacy_token, SetAuthority};
use anchor_spl::token_interface::{
    self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
};
use solana_sha256_hasher::hashv;

mod economics;
mod round_schedule;
mod state;
use economics::*;
use round_schedule::*;
use state::*;

declare_id!("D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MINING_POOL_SEED: &[u8] = b"mining_pool";
pub const STAKE_POOL_SEED: &[u8] = b"stake_pool";
pub const LIQUIDITY_GATE_SEED: &[u8] = b"liquidity_gate";
pub const PRELAUNCH_MINT_MIGRATION_SEED: &[u8] = b"prelaunch_mint_migration";
pub const MINER_SEED: &[u8] = b"miner";
pub const STAKE_POSITION_SEED: &[u8] = b"stake_position";
pub const ROUND_SEED: &[u8] = b"round";
pub const BET_SEED: &[u8] = b"bet";
pub const CURRENT_VERSION: u8 = 6;
pub const MYNE_DECIMALS: u8 = 9;
pub const GENESIS_TOKENS: u64 = 100;
pub const MAX_TOKENS: u64 = 2_000_000;
pub const MINIMUM_ROUND_LAMPORTS: u64 = 50_000_000;
pub const ROUND_DURATION_SECONDS: u64 = 65;
pub const BETTING_DURATION_SECONDS: u64 = 60;
/// Maximum lead granted only to the configured randomness provider to create
/// and bind the next scheduled round. This changes preparation time, not the
/// user betting interval, which remains exactly 60 seconds from `opened_at`.
pub const PROVIDER_PREPARATION_LEAD_SECONDS: i64 = BETTING_DURATION_SECONDS as i64;
pub const RESOLUTION_COUNTDOWN_SECONDS: u64 = 0;
pub const WINNER_DISPLAY_SECONDS: u64 = 5;
pub const MOTHERLODE_ODDS: u64 = 650;
pub const REFUND_DELAY_SECONDS: i64 = 10 * 60;
pub const UNSTAKE_DELAY_SECONDS: u64 = 30 * 24 * 60 * 60;
pub const GENESIS_BASE_UNITS: u64 = GENESIS_TOKENS * 1_000_000_000;
pub const BASE_ROUND_EMISSION: u64 = 1_000_000_000;
pub const MOTHERLODE_ROUND_EMISSION: u64 = 200_000_000;
pub const BURN_WEIGHT_MULTIPLIER: u64 = 5;
pub const AUTO_REWARD_ACCUMULATE: u8 = 0;
pub const AUTO_REWARD_BURN: u8 = 1;
/// AutoPlan-only consent bit. When set, a permissionless keeper may move the
/// plan owner's canonical claimable SOL into that same AutoPlan immediately
/// before an execution. BetReceipt.reward_mode always stores only the low
/// reward-mode bit, so receipt and index layouts remain 0=accumulate/1=burn.
pub const AUTO_PLAN_REINVEST_SOL: u8 = 1 << 1;
const AUTO_PLAN_ALLOWED_MODE_MASK: u8 = AUTO_REWARD_BURN | AUTO_PLAN_REINVEST_SOL;
/// High-precision unclaimed-reward shares. The hard MYNE cap keeps aggregate
/// scaled shares comfortably below u128, while the custom wide mul/div below
/// avoids intermediate overflow.
pub const MINING_SHARE_SCALE: u128 = REWARD_SCALE;
#[cfg(feature = "production")]
pub const BUILD_MODE_MARKER: &str = "MYNE_PRODUCTION_ARTIFACT_V1";
#[cfg(not(feature = "production"))]
pub const BUILD_MODE_MARKER: &str = "MYNE_REHEARSAL_ARTIFACT_V1";

// Switchboard On-Demand randomness account identifiers. The account layout is
// intentionally parsed locally so the protocol does not depend on an Anchor
// version-specific SDK at build time. These IDs are pinned to Switchboard's
// published deployments; the configured ProtocolConfig value is still checked
// for every request and settlement.
pub const SWITCHBOARD_DEVNET_PROGRAM: Pubkey =
    pubkey!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
pub const SWITCHBOARD_MAINNET_PROGRAM: Pubkey =
    pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
/// Explicit marker for MYNE's temporary commit-reveal mode. No external
/// program is invoked: the server commits before betting, then a permissionless
/// settlement mixes the reveal with a future hash from Solana's SlotHashes
/// sysvar. Reusing this program ID avoids adding configuration account bytes.
pub const SERVER_RANDOMNESS_PROGRAM: Pubkey = crate::ID;
pub const SLOT_HASHES_SYSVAR: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");
/// `Round::randomness_commit_slot` is reused without resizing the account.
/// Legacy Switchboard slots always have the high bit clear. Server rounds set
/// it, with `u64::MAX` denoting a bound commitment whose future slot has not
/// yet been locked.
pub const SERVER_RANDOMNESS_SLOT_FLAG: u64 = 1u64 << 63;
pub const SERVER_RANDOMNESS_PENDING: u64 = u64::MAX;
/// One strictly-future slot keeps the entropy unknowable while betting is
/// open, but lets settlement complete inside the five-second winner phase.
/// A longer delay can push the confirmed winner into the next betting round.
pub const SERVER_ENTROPY_DELAY_SLOTS: u64 = 1;
const SERVER_RANDOMNESS_SLOT_MASK: u64 = !SERVER_RANDOMNESS_SLOT_FLAG;
const SLOT_HASHES_MAX_ENTRIES: usize = 512;
const SLOT_HASHES_HEADER_SIZE: usize = 8;
const SLOT_HASHES_ENTRY_SIZE: usize = 40;
const SERVER_COMMIT_DOMAIN: &[u8] = b"MYNE_SERVER_COMMIT_V1";
const SERVER_OUTPUT_DOMAIN: &[u8] = b"MYNE_SERVER_OUTPUT_V1";
/// The abandoned pre-launch mint is pinned in the production artifact so the
/// one-time migration cannot be reused to replace a live MYNE market later.
pub const LEGACY_PRELAUNCH_MINT: Pubkey = pubkey!("2NtsuCtsXCU1f5dwGcNPyBLnKx5tRHsCFfUt6py3dwWS");
/// Meteora's canonical DLMM program. Mainnet/devnet activation must use this
/// program; accepting an arbitrary owner would allow an unrelated account to
/// satisfy the liquidity gate.
pub const METEORA_DLMM_PROGRAM: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
/// Meteora's canonical DAMM v2 constant-product program. The gate supports
/// either this program or DLMM, while rejecting every caller-supplied owner.
pub const METEORA_DAMM_V2_PROGRAM: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// Anchor account discriminator for Meteora DLMM's `LbPair` account. Owner
/// validation alone is insufficient because the DLMM program owns several
/// unrelated account types.
const METEORA_LB_PAIR_DISCRIMINATOR: [u8; 8] = [33, 11, 49, 98, 181, 101, 177, 13];
const METEORA_LB_PAIR_SIZE: usize = 904;
const METEORA_LB_PAIR_STATUS_OFFSET: usize = 82;
const METEORA_LB_PAIR_ACTIVATION_TYPE_OFFSET: usize = 86;
const METEORA_LB_PAIR_TOKEN_X_MINT_OFFSET: usize = 88;
const METEORA_LB_PAIR_TOKEN_Y_MINT_OFFSET: usize = 120;
const METEORA_LB_PAIR_RESERVE_X_OFFSET: usize = 152;
const METEORA_LB_PAIR_RESERVE_Y_OFFSET: usize = 184;
const METEORA_LB_PAIR_ACTIVATION_POINT_OFFSET: usize = 816;
const METEORA_LB_PAIR_ENABLED: u8 = 0;
/// Anchor discriminator for DAMM v2's zero-copy `Pool` account. Layout pinned
/// to MeteoraAg/damm-v2 commit bdd8a1e355f484b3cff131578a662c560b97b72f.
const METEORA_DAMM_V2_POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
const METEORA_DAMM_V2_POOL_SIZE: usize = 1_112;
const METEORA_DAMM_TOKEN_A_MINT_OFFSET: usize = 168;
const METEORA_DAMM_TOKEN_B_MINT_OFFSET: usize = 200;
const METEORA_DAMM_TOKEN_A_VAULT_OFFSET: usize = 232;
const METEORA_DAMM_TOKEN_B_VAULT_OFFSET: usize = 264;
const METEORA_DAMM_ACTIVATION_POINT_OFFSET: usize = 472;
const METEORA_DAMM_ACTIVATION_TYPE_OFFSET: usize = 480;
const METEORA_DAMM_POOL_STATUS_OFFSET: usize = 481;
const METEORA_DAMM_POOL_TYPE_OFFSET: usize = 485;
const METEORA_DAMM_POOL_ENABLED: u8 = 0;
const METEORA_DAMM_PERMISSIONLESS_POOL: u8 = 0;
const METEORA_DAMM_CUSTOMIZABLE_POOL: u8 = 1;
const METEORA_DAMM_TOKEN_VAULT_SEED: &[u8] = b"token_vault";
pub const WRAPPED_SOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey =
    pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SWITCHBOARD_RANDOMNESS_DISCRIMINATOR: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];
// Smallest stable prefix used below: discriminator through the 32-byte value.
// Switchboard may append reserved fields without invalidating this parser.
const SWITCHBOARD_RANDOMNESS_ACCOUNT_PREFIX_SIZE: usize = 184;

#[program]
pub mod myne_protocol {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        args: InitializeArgs,
    ) -> Result<()> {
        // This reachable log keeps the feature-specific marker in the final
        // SBF binary, allowing offline preflight to reject a rehearsal build.
        msg!(BUILD_MODE_MARKER);
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
        // Keep the three funded operational roles independent on chain, not
        // merely by launch-script convention.
        assert_operational_roles_distinct(
            args.randomness_authority,
            args.buyback_wallet,
            args.admin_fee_wallet,
        )?;
        assert_randomness_program_allowed_for_build(args.randomness_program)?;
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token::ID,
            MyneError::InvalidTokenProgram
        );
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
        // Reserved configuration field retained for versioned account-layout
        // compatibility. Motherlode SOL remains in the config PDA and is paid
        // directly to eligible receipt owners; no fee is transferred here.
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
        config.total_emitted_base_units = GENESIS_BASE_UNITS;

        let mining_pool = &mut ctx.accounts.mining_pool;
        mining_pool.bump = ctx.bumps.mining_pool;
        mining_pool.total_unclaimed = 0;
        // v6 uses this existing u128 field as the aggregate unclaimed-reward
        // share supply. Keeping the account layout stable avoids needless rent
        // and migration risk while replacing the incorrect additive index.
        mining_pool.reward_per_unclaimed = 0;
        mining_pool.undistributed_base_units = 0;

        let stake_pool = &mut ctx.accounts.stake_pool;
        stake_pool.bump = ctx.bumps.stake_pool;
        stake_pool.active_stakers = 0;
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
        require!(
            ctx.accounts.config.paused,
            MyneError::MigrationRequiresPause
        );
        require!(pool != Pubkey::default(), MyneError::InvalidLiquidityPool);
        require!(
            pool_program != Pubkey::default(),
            MyneError::InvalidLiquidityPool
        );
        require!(min_sol_lamports > 0, MyneError::InvalidLiquidityPool);
        require!(min_myne_base_units > 0, MyneError::InvalidLiquidityPool);
        if ctx.accounts.config.randomness_program != Pubkey::default() {
            require!(
                is_supported_meteora_program(pool_program),
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
        if ctx.accounts.config.randomness_program != Pubkey::default() {
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
            assert_meteora_pool_accounts(
                pool_program,
                &ctx.accounts.pool.to_account_info(),
                ctx.accounts.config.mint,
                myne_vault.key(),
                sol_vault.key(),
            )?;
        }

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

    /// One-time recovery from the abandoned pre-launch mint. This instruction
    /// is intentionally stricter than a general mint-rotation facility: it
    /// requires an entirely unused, paused protocol, a fresh 100-MYNE legacy
    /// SPL mint already controlled by the config PDA, and the complete supply
    /// in the configured admin/liquidity wallet. The old mint authority is
    /// revoked atomically before the config starts accepting the new mint.
    pub fn migrate_prelaunch_mint(ctx: Context<MigratePrelaunchMint>) -> Result<()> {
        require!(
            ctx.accounts.config.paused,
            MyneError::MigrationRequiresPause
        );
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        #[cfg(feature = "production")]
        require_keys_eq!(
            ctx.accounts.previous_mint.key(),
            LEGACY_PRELAUNCH_MINT,
            MyneError::InvalidPrelaunchMintMigration
        );
        require_keys_eq!(
            ctx.accounts.config.mint,
            ctx.accounts.previous_mint.key(),
            MyneError::InvalidPrelaunchMintMigration
        );
        require_keys_neq!(
            ctx.accounts.previous_mint.key(),
            ctx.accounts.new_mint.key(),
            MyneError::InvalidPrelaunchMintMigration
        );
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token::ID,
            MyneError::InvalidTokenProgram
        );
        require!(
            ctx.accounts.previous_mint.decimals == MYNE_DECIMALS
                && ctx.accounts.new_mint.decimals == MYNE_DECIMALS,
            MyneError::InvalidMintDecimals
        );
        require!(
            ctx.accounts.previous_mint.mint_authority == COption::Some(ctx.accounts.config.key())
                && ctx.accounts.new_mint.mint_authority == COption::Some(ctx.accounts.config.key()),
            MyneError::InvalidMintAuthority
        );
        require!(
            ctx.accounts.previous_mint.freeze_authority == COption::None
                && ctx.accounts.new_mint.freeze_authority == COption::None,
            MyneError::InvalidFreezeAuthority
        );
        require!(
            ctx.accounts.previous_mint.supply > 0
                && ctx.accounts.previous_mint.supply <= GENESIS_BASE_UNITS
                && ctx.accounts.new_mint.supply == GENESIS_BASE_UNITS,
            MyneError::InvalidSupply
        );
        require!(
            ctx.accounts.config.total_emitted_base_units == GENESIS_BASE_UNITS
                && ctx.accounts.config.virtual_burn_base_units == 0
                && ctx.accounts.config.motherlode_base_units == 0
                && ctx.accounts.config.motherlode_lamports == 0,
            MyneError::PrelaunchStateNotEmpty
        );
        require!(
            ctx.accounts.mining_pool.total_unclaimed == 0
                && ctx.accounts.mining_pool.reward_per_unclaimed == 0
                && ctx.accounts.mining_pool.undistributed_base_units == 0,
            MyneError::PrelaunchStateNotEmpty
        );
        require!(
            ctx.accounts.stake_pool.active_stakers == 0
                && ctx.accounts.stake_pool.total_standard == 0
                && ctx.accounts.stake_pool.total_burn == 0
                && ctx.accounts.stake_pool.total_weight == 0
                && ctx.accounts.stake_pool.reward_per_weight == 0
                && ctx.accounts.stake_pool.undistributed_lamports == 0
                && ctx.accounts.stake_pool.total_funded_lamports == 0
                && ctx.accounts.stake_pool.total_claimed_lamports == 0,
            MyneError::PrelaunchStateNotEmpty
        );
        assert_canonical_token_account(
            ctx.accounts.liquidity_tokens.key(),
            ctx.accounts.config.admin_fee_wallet,
            ctx.accounts.new_mint.key(),
            ctx.accounts.token_program.key(),
            MyneError::InvalidFeeDestination,
        )?;
        require!(
            ctx.accounts.liquidity_tokens.amount == GENESIS_BASE_UNITS,
            MyneError::InvalidSupply
        );

        let previous_mint = ctx.accounts.previous_mint.key();
        let new_mint = ctx.accounts.new_mint.key();
        let config_seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        let signer_seeds = &[config_seeds];
        legacy_token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                SetAuthority {
                    current_authority: ctx.accounts.config.to_account_info(),
                    account_or_mint: ctx.accounts.previous_mint.to_account_info(),
                },
                signer_seeds,
            ),
            anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;
        ctx.accounts.previous_mint.reload()?;
        require!(
            ctx.accounts.previous_mint.mint_authority == COption::None,
            MyneError::InvalidMintAuthority
        );

        ctx.accounts.config.mint = new_mint;
        ctx.accounts.config.total_emitted_base_units = GENESIS_BASE_UNITS;
        let migration = &mut ctx.accounts.migration;
        migration.bump = ctx.bumps.migration;
        migration.previous_mint = previous_mint;
        migration.new_mint = new_mint;
        migration.migrated_at = Clock::get()?.unix_timestamp;

        emit!(PrelaunchMintMigrated {
            previous_mint,
            new_mint,
            liquidity_owner: ctx.accounts.config.admin_fee_wallet,
            liquidity_token_account: ctx.accounts.liquidity_tokens.key(),
            genesis_base_units: GENESIS_BASE_UNITS,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        if !paused {
            require_eq!(
                ctx.accounts.config.version,
                CURRENT_VERSION,
                MyneError::ProtocolUpgradeRequired
            );
            assert_randomness_program_allowed_for_build(ctx.accounts.config.randomness_program)?;
        }
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

    /// One-way semantic migration for already-initialized v5 deployments.
    /// The account layout is unchanged, but settlement remains fail-closed
    /// until an administrator acknowledges the new audited fee schedule while
    /// the protocol is paused.
    pub fn migrate_fee_schedule_v6(ctx: Context<MigrateFeeScheduleV6>) -> Result<()> {
        require!(
            ctx.accounts.config.paused,
            MyneError::MigrationRequiresPause
        );
        require_eq!(
            ctx.accounts.config.version,
            5,
            MyneError::ProtocolUpgradeRequired
        );
        // v5's additive passive-reward index cannot be converted globally
        // while balances exist because each miner may have checkpointed at a
        // different index. Fail closed instead of silently changing claims.
        require!(
            ctx.accounts.mining_pool.total_unclaimed == 0,
            MyneError::MiningPoolMigrationRequiresEmpty
        );
        ctx.accounts.mining_pool.reward_per_unclaimed = 0;
        let previous_version = ctx.accounts.config.version;
        ctx.accounts.config.version = CURRENT_VERSION;
        emit!(ProtocolVersionChanged {
            previous_version,
            current_version: CURRENT_VERSION,
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
        // Preserve the same separation enforced at initialization. Without
        // this check an administrator could alias the keeper to a funded fee
        // receiver after launch and bypass the intended role model.
        assert_operational_roles_distinct(
            randomness_authority,
            ctx.accounts.config.buyback_wallet,
            ctx.accounts.config.admin_fee_wallet,
        )?;
        ctx.accounts.config.randomness_authority = randomness_authority;
        emit!(RandomnessAuthorityChanged {
            randomness_authority
        });
        Ok(())
    }

    /// Atomically rotates the two funded fee-receiver roles while paused.
    /// Requiring the replacement admin fallback ATA up front prevents a key
    /// recovery from leaving MYNE claims permanently unable to route fees.
    pub fn rotate_operational_wallets(ctx: Context<RotateOperationalWallets>) -> Result<()> {
        require!(
            ctx.accounts.config.paused,
            MyneError::OperationalWalletsLocked
        );
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        let new_buyback_wallet = ctx.accounts.new_buyback_wallet.key();
        let new_admin_fee_wallet = ctx.accounts.new_admin_fee_wallet.key();
        assert_operational_roles_distinct(
            ctx.accounts.config.randomness_authority,
            new_buyback_wallet,
            new_admin_fee_wallet,
        )?;
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token::ID,
            MyneError::InvalidTokenProgram
        );
        assert_canonical_token_account(
            ctx.accounts.new_admin_fee_tokens.key(),
            new_admin_fee_wallet,
            ctx.accounts.mint.key(),
            ctx.accounts.token_program.key(),
            MyneError::InvalidFeeDestination,
        )?;

        let previous_buyback_wallet = ctx.accounts.config.buyback_wallet;
        let previous_admin_fee_wallet = ctx.accounts.config.admin_fee_wallet;
        ctx.accounts.config.buyback_wallet = new_buyback_wallet;
        ctx.accounts.config.admin_fee_wallet = new_admin_fee_wallet;
        emit!(OperationalWalletsRotated {
            previous_buyback_wallet,
            buyback_wallet: new_buyback_wallet,
            previous_admin_fee_wallet,
            admin_fee_wallet: new_admin_fee_wallet,
            admin_fee_token_account: ctx.accounts.new_admin_fee_tokens.key(),
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
        assert_randomness_program_allowed_for_build(randomness_program)?;
        // Production may move only between the two explicitly compiled and
        // pool-gated providers. Per-round mode is encoded in `Round`, so this
        // does not alter or strand already-open Switchboard/server rounds.
        ctx.accounts.config.randomness_program = randomness_program;
        emit!(RandomnessProgramChanged { randomness_program });
        Ok(())
    }

    pub fn register_miner(ctx: Context<RegisterMiner>, referrer: Pubkey) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
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
        miner.passive_reward_debt = 0;
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
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        assert_randomness_program_allowed_for_build(ctx.accounts.config.randomness_program)?;
        // Verified-randomness rounds must be opened by the configured keeper.
        // Otherwise an arbitrary payer could create the scheduled round first,
        // leave it unbound, and deny service for the full round window.
        if ctx.accounts.config.randomness_program != Pubkey::default() {
            require_keys_eq!(
                ctx.accounts.payer.key(),
                ctx.accounts.config.randomness_authority,
                MyneError::InvalidRandomnessAuthority
            );
        }
        require!(
            round_can_open_after_emission(
                ctx.accounts.config.total_emitted_base_units,
                ctx.accounts.config.motherlode_base_units,
                ctx.accounts.config.motherlode_lamports,
            )?,
            MyneError::EmissionComplete
        );
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
        assert_round_can_open_at(
            now,
            opened_at,
            betting_ends_at,
            ctx.accounts.config.randomness_program,
        )?;
        let round = &mut ctx.accounts.round;
        round.bump = ctx.bumps.round;
        round.id = round_id;
        round.rent_payer = ctx.accounts.payer.key();
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
        round.total_receipts = 0;
        round.processed_receipts = 0;
        round.closed_receipts = 0;
        round.buyback_completed = false;
        round.archive_hash = [0; 32];
        round.archived_at_slot = 0;
        emit!(RoundOpened {
            round_id,
            rent_payer: round.rent_payer,
            opened_at: round.opened_at,
            betting_ends_at: round.betting_ends_at,
            settles_at: round.settles_at,
            refund_at: round.refund_at,
        });
        Ok(())
    }

    /// Bind a fresh, uncommitted Switchboard randomness account before any
    /// deployment is accepted. The account identity is fixed while no outcome
    /// exists; committing it later is what irreversibly closes betting.
    pub fn bind_round_randomness(ctx: Context<BindRoundRandomness>, round_id: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        require!(
            is_switchboard_program(ctx.accounts.config.randomness_program),
            MyneError::RandomnessProviderRequired
        );
        require!(ctx.accounts.round.id == round_id, MyneError::InvalidRound);
        require!(
            !ctx.accounts.round.settled
                && Clock::get()?.unix_timestamp < ctx.accounts.round.betting_ends_at,
            MyneError::BettingClosed
        );
        let parsed = parse_switchboard_randomness(
            &ctx.accounts.randomness_account.to_account_info(),
            &ctx.accounts.config.randomness_program,
        )?;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.randomness_authority,
            MyneError::InvalidRandomnessAuthority
        );
        require_keys_eq!(
            parsed.authority,
            ctx.accounts.config.randomness_authority,
            MyneError::InvalidRandomnessAuthority
        );
        require!(
            switchboard_randomness_is_uncommitted(&parsed),
            MyneError::RandomnessAlreadyCommitted
        );
        require!(
            ctx.accounts.round.randomness_account == Pubkey::default(),
            MyneError::RandomnessNotBound
        );
        ctx.accounts.round.randomness_account = ctx.accounts.randomness_account.key();
        ctx.accounts.round.randomness_commit_slot = 0;
        emit!(RoundRandomnessBound {
            round_id,
            randomness_account: ctx.accounts.randomness_account.key(),
            randomness_commit_slot: 0,
        });
        Ok(())
    }

    /// Binds a server secret commitment before the first deployment. The
    /// commitment alone cannot determine an outcome because settlement also
    /// incorporates a future Solana slot hash selected only after betting
    /// closes. Its bytes occupy the legacy randomness-account field, so no
    /// mainnet account resize or migration is required.
    pub fn bind_round_server_commitment(
        ctx: Context<BindRoundServerCommitment>,
        round_id: u64,
        commitment: [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        require_keys_eq!(
            ctx.accounts.config.randomness_program,
            SERVER_RANDOMNESS_PROGRAM,
            MyneError::ServerRandomnessModeRequired
        );
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.randomness_authority,
            MyneError::InvalidRandomnessAuthority
        );
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require_eq!(round.id, round_id, MyneError::InvalidRound);
        require!(
            !round.settled && now < round.betting_ends_at,
            MyneError::BettingClosed
        );
        require!(
            round.total_receipts == 0 && round.gross_deployed_lamports == 0,
            MyneError::RandomnessAlreadyCommitted
        );
        require!(
            round.randomness_account == Pubkey::default() && round.randomness_commit_slot == 0,
            MyneError::RandomnessAlreadyCommitted
        );
        require!(
            commitment != [0; 32],
            MyneError::InvalidServerRandomnessCommitment
        );
        round.randomness_account = Pubkey::new_from_array(commitment);
        round.randomness_commit_slot = SERVER_RANDOMNESS_PENDING;
        emit!(RoundServerCommitmentBound {
            round_id,
            commitment,
        });
        Ok(())
    }

    /// Permissionlessly fixes the first eligible future entropy slot after
    /// betting closes. The delay ensures its block hash does not exist when
    /// this instruction executes and therefore cannot be selected to favour a
    /// known outcome.
    pub fn lock_round_server_entropy(
        ctx: Context<LockRoundServerEntropy>,
        round_id: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        let clock = Clock::get()?;
        let round = &mut ctx.accounts.round;
        require_eq!(round.id, round_id, MyneError::InvalidRound);
        require!(!round.settled, MyneError::RoundAlreadySettled);
        require!(
            clock.unix_timestamp >= round.betting_ends_at && clock.unix_timestamp < round.refund_at,
            MyneError::RoundNotReady
        );
        require!(
            round.randomness_commit_slot == SERVER_RANDOMNESS_PENDING
                && round.randomness_account != Pubkey::default(),
            MyneError::ServerRandomnessNotPending
        );
        let target_slot = clock
            .slot
            .checked_add(SERVER_ENTROPY_DELAY_SLOTS)
            .ok_or(MyneError::ArithmeticOverflow)?;
        round.randomness_commit_slot = encode_server_randomness_slot(target_slot)?;
        emit!(RoundServerEntropyLocked {
            round_id,
            target_slot,
            executor: ctx.accounts.executor.key(),
        });
        Ok(())
    }

    /// Record the Switchboard commitment only after betting has closed. This
    /// instruction must follow Switchboard's `randomness_commit` instruction in
    /// the same transaction and accepts only its strict fresh-slot state. Since
    /// every deploy instruction requires `seed_slot == 0`, no wager can be
    /// added after the outcome becomes available to the randomness authority.
    pub fn record_round_randomness_commit(
        ctx: Context<BindRoundRandomness>,
        round_id: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        require_keys_neq!(
            ctx.accounts.config.randomness_program,
            Pubkey::default(),
            MyneError::RandomnessProviderRequired
        );
        require!(ctx.accounts.round.id == round_id, MyneError::InvalidRound);
        require!(!ctx.accounts.round.settled, MyneError::RoundAlreadySettled);
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        require!(
            now >= ctx.accounts.round.betting_ends_at && now < ctx.accounts.round.refund_at,
            MyneError::RoundNotReady
        );
        require_keys_eq!(
            ctx.accounts.round.randomness_account,
            ctx.accounts.randomness_account.key(),
            MyneError::InvalidRandomnessAccount
        );
        require!(
            ctx.accounts.round.randomness_commit_slot == 0,
            MyneError::RandomnessAlreadyCommitted
        );
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.randomness_authority,
            MyneError::InvalidRandomnessAuthority
        );
        let parsed =
            parse_bound_switchboard_randomness(&ctx.accounts.randomness_account.to_account_info())?;
        require_keys_eq!(
            parsed.authority,
            ctx.accounts.config.randomness_authority,
            MyneError::InvalidRandomnessAuthority
        );
        require!(
            is_fresh_switchboard_commit(parsed.seed_slot, clock.slot),
            MyneError::RandomnessCommittedTooLate
        );
        require!(
            parsed.reveal_slot == 0,
            MyneError::RandomnessAlreadyRevealed
        );
        ctx.accounts.round.randomness_commit_slot = parsed.seed_slot;
        emit!(RoundRandomnessCommitted {
            round_id,
            randomness_account: ctx.accounts.randomness_account.key(),
            randomness_commit_slot: parsed.seed_slot,
        });
        Ok(())
    }

    pub fn deploy(
        ctx: Context<Deploy>,
        round_id: u64,
        nonce: u64,
        amounts: [u64; TILE_COUNT],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        assert_randomness_program_allowed_for_build(ctx.accounts.config.randomness_program)?;
        require!(ctx.accounts.round.id == round_id, MyneError::InvalidRound);
        assert_round_accepting_deployments_at(
            ctx.accounts.round.settled,
            Clock::get()?.unix_timestamp,
            ctx.accounts.round.opened_at,
            ctx.accounts.round.betting_ends_at,
        )?;
        assert_bound_randomness_accepting_bets(
            &ctx.accounts.config,
            &ctx.accounts.round,
            ctx.accounts.randomness_account.as_ref(),
        )?;
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
        receipt.reward_mode = AUTO_REWARD_ACCUMULATE;
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
        round.total_receipts = checked_add(round.total_receipts, 1)?;
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
            receipt: receipt.key(),
            nonce,
            total_lamports: total,
            reward_mode: AUTO_REWARD_ACCUMULATE,
            amounts,
            cumulative_starts: receipt.cumulative_starts,
        });
        Ok(())
    }

    pub fn create_auto_plan(
        ctx: Context<CreateAutoPlan>,
        amounts: [u64; TILE_COUNT],
        deposit_lamports: u64,
        reward_mode: u8,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        let per_round = checked_sum(&amounts)?;
        require!(
            per_round >= ctx.accounts.config.minimum_round_lamports,
            MyneError::DeploymentTooSmall
        );
        let plan = &mut ctx.accounts.auto_plan;
        assert_auto_plan_reward_mode(reward_mode)?;
        plan.bump = ctx.bumps.auto_plan;
        plan.authority = ctx.accounts.authority.key();
        plan.active = true;
        plan.reward_mode = reward_mode;
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
            reward_mode,
            active: true
        });
        Ok(())
    }

    pub fn configure_auto_plan(
        ctx: Context<ManageAutoPlan>,
        amounts: [u64; TILE_COUNT],
        active: bool,
        reward_mode: u8,
    ) -> Result<()> {
        let per_round = checked_sum(&amounts)?;
        require!(
            per_round >= ctx.accounts.config.minimum_round_lamports,
            MyneError::DeploymentTooSmall
        );
        assert_auto_plan_reward_mode(reward_mode)?;
        ctx.accounts.auto_plan.amounts = amounts;
        ctx.accounts.auto_plan.active = active;
        ctx.accounts.auto_plan.reward_mode = reward_mode;
        emit!(AutoPlanConfigured {
            authority: ctx.accounts.authority.key(),
            per_round_lamports: per_round,
            balance_lamports: ctx.accounts.auto_plan.balance_lamports,
            reward_mode,
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

    pub fn cancel_auto_plan(ctx: Context<CancelAutoPlan>) -> Result<()> {
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

    /// Permissionlessly reinvests this plan owner's claimable SOL into their
    /// canonical AutoPlan. Consent is stored in AutoPlan.reward_mode and can
    /// only be changed by the owner-signed create/configure instructions.
    ///
    /// Keepers place this immediately before execute_auto_plan in one atomic
    /// transaction. If execution later fails, Solana rolls this transfer back;
    /// if an owner claim races it, account locking ensures only one path can
    /// consume the pending balance.
    pub fn reinvest_auto_plan_rewards(ctx: Context<ReinvestAutoPlanRewards>) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        assert_auto_plan_reward_mode(ctx.accounts.auto_plan.reward_mode)?;
        require!(ctx.accounts.auto_plan.active, MyneError::AutoPlanInactive);
        require!(
            auto_plan_reinvests_sol(ctx.accounts.auto_plan.reward_mode),
            MyneError::InvalidRewardMode
        );

        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;
        let amount = ctx.accounts.stake_position.pending_sol;
        if amount > 0 {
            let next_balance = checked_add(ctx.accounts.auto_plan.balance_lamports, amount)?;
            let next_claimed = checked_add(ctx.accounts.stake_pool.total_claimed_lamports, amount)?;
            move_lamports(
                &ctx.accounts.stake_pool.to_account_info(),
                &ctx.accounts.auto_plan.to_account_info(),
                amount,
            )?;
            ctx.accounts.stake_position.pending_sol = 0;
            ctx.accounts.auto_plan.balance_lamports = next_balance;
            ctx.accounts.stake_pool.total_claimed_lamports = next_claimed;
        }
        emit!(AutoPlanRewardsReinvested {
            authority: ctx.accounts.auto_plan.authority,
            executor: ctx.accounts.executor.key(),
            lamports: amount,
            balance_lamports: ctx.accounts.auto_plan.balance_lamports,
        });
        Ok(())
    }

    pub fn execute_auto_plan(
        ctx: Context<ExecuteAutoPlan>,
        round_id: u64,
        nonce: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        assert_randomness_program_allowed_for_build(ctx.accounts.config.randomness_program)?;
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
        assert_round_accepting_deployments_at(
            ctx.accounts.round.settled,
            Clock::get()?.unix_timestamp,
            ctx.accounts.round.opened_at,
            ctx.accounts.round.betting_ends_at,
        )?;
        assert_bound_randomness_accepting_bets(
            &ctx.accounts.config,
            &ctx.accounts.round,
            ctx.accounts.randomness_account.as_ref(),
        )?;
        let amounts = ctx.accounts.auto_plan.amounts;
        let total = checked_sum(&amounts)?;
        let receipt_rent = Rent::get()?.minimum_balance(8 + BetReceipt::INIT_SPACE);
        let required_balance = checked_add(total, receipt_rent)?;
        require!(
            ctx.accounts.auto_plan.balance_lamports >= required_balance,
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
        // AutoPlan.reward_mode also stores the owner's SOL-reinvestment
        // consent bit. Receipts retain the stable public 0/1 reward mode.
        receipt.reward_mode = auto_plan_receipt_reward_mode(ctx.accounts.auto_plan.reward_mode)?;
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
        ctx.accounts.round.total_receipts = checked_add(ctx.accounts.round.total_receipts, 1)?;
        ctx.accounts.miner.lifetime_deployed_lamports =
            checked_add(ctx.accounts.miner.lifetime_deployed_lamports, total)?;
        move_lamports(
            &ctx.accounts.auto_plan.to_account_info(),
            &ctx.accounts.round.to_account_info(),
            total,
        )?;
        // Anchor's `init` charges the permissionless executor for the receipt.
        // Reimburse only the protocol-determined rent from the user's funded
        // plan so long-running automation does not drain the keeper wallet.
        move_lamports(
            &ctx.accounts.auto_plan.to_account_info(),
            &ctx.accounts.executor.to_account_info(),
            receipt_rent,
        )?;
        ctx.accounts.auto_plan.balance_lamports = ctx
            .accounts
            .auto_plan
            .balance_lamports
            .checked_sub(required_balance)
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
        emit!(DeploymentCreated {
            round_id,
            authority: ctx.accounts.auto_plan.authority,
            receipt: receipt.key(),
            nonce,
            total_lamports: total,
            reward_mode: receipt.reward_mode,
            amounts,
            cumulative_starts: receipt.cumulative_starts,
        });
        Ok(())
    }

    pub fn settle_round(ctx: Context<SettleRound>, randomness: [u8; 32]) -> Result<()> {
        // This path is retained solely for local/devnet rehearsal. Production
        // configurations set a Switchboard provider and therefore cannot use a
        // caller-supplied random byte array.
        assert_randomness_program_allowed_for_build(ctx.accounts.config.randomness_program)?;
        require_keys_eq!(
            ctx.accounts.config.randomness_program,
            Pubkey::default(),
            MyneError::RandomnessProviderRequired
        );
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
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
        require_keys_eq!(
            ctx.accounts.admin_fee_wallet.key(),
            ctx.accounts.config.admin_fee_wallet,
            MyneError::InvalidFeeDestination
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
            &ctx.accounts.admin_fee_wallet.to_account_info(),
            None,
            None,
            randomness,
        )
    }

    pub fn settle_round_verified(ctx: Context<SettleRoundVerified>) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        assert_randomness_program_allowed_for_build(ctx.accounts.config.randomness_program)?;
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
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
        require!(
            ctx.accounts.round.randomness_commit_slot > 0
                && !server_randomness_slot_is_encoded(ctx.accounts.round.randomness_commit_slot),
            MyneError::RandomnessNotCommitted
        );
        require_keys_eq!(
            ctx.accounts.buyback_wallet.key(),
            ctx.accounts.config.buyback_wallet,
            MyneError::InvalidFeeDestination
        );
        require_keys_eq!(
            ctx.accounts.admin_fee_wallet.key(),
            ctx.accounts.config.admin_fee_wallet,
            MyneError::InvalidFeeDestination
        );
        let clock = Clock::get()?;
        // Settlement is keyed by the mode stored on the round, not the
        // provider currently selected for future rounds. This keeps every
        // already-open Switchboard request settleable after a paused switch to
        // server commit-reveal mode.
        let randomness =
            parse_bound_switchboard_randomness(&ctx.accounts.randomness_account.to_account_info())?;
        require_keys_eq!(
            randomness.authority,
            ctx.accounts.config.randomness_authority,
            MyneError::InvalidRandomnessAuthority
        );
        require!(
            randomness.seed_slot == ctx.accounts.round.randomness_commit_slot,
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
            &ctx.accounts.admin_fee_wallet.to_account_info(),
            ctx.accounts.myne_vault.as_ref(),
            ctx.accounts.sol_vault.as_ref(),
            randomness.value,
        )
    }

    /// Permissionless server commit-reveal settlement. The reveal must match
    /// the pre-betting commitment, while the selected SlotHashes entry was
    /// necessarily unknown until after betting closed. Both inputs are
    /// domain-separated into the exact bytes consumed by round economics.
    pub fn settle_round_server(ctx: Context<SettleRoundServer>, reveal: [u8; 32]) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        assert_randomness_program_allowed_for_build(ctx.accounts.config.randomness_program)?;
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        let clock = Clock::get()?;
        let round = &mut ctx.accounts.round;
        require!(!round.settled, MyneError::RoundAlreadySettled);
        require!(
            clock.unix_timestamp >= round.settles_at && clock.unix_timestamp < round.refund_at,
            MyneError::RoundNotReady
        );
        let encoded_slot = round.randomness_commit_slot;
        require!(
            encoded_slot != SERVER_RANDOMNESS_PENDING
                && server_randomness_slot_is_encoded(encoded_slot),
            MyneError::ServerEntropyNotLocked
        );
        let target_slot = decode_server_randomness_slot(encoded_slot)?;
        require!(
            clock.slot > target_slot,
            MyneError::ServerEntropySlotNotReached
        );
        let commitment = server_randomness_commitment(ctx.accounts.config.mint, round.id, &reveal);
        require!(
            round.randomness_account.to_bytes() == commitment,
            MyneError::InvalidServerRandomnessCommitment
        );
        require_keys_eq!(
            ctx.accounts.slot_hashes.key(),
            SLOT_HASHES_SYSVAR,
            MyneError::InvalidSlotHashesSysvar
        );
        let slot_hashes_data = ctx
            .accounts
            .slot_hashes
            .try_borrow_data()
            .map_err(|_| error!(MyneError::InvalidSlotHashesSysvar))?;
        let (entropy_slot, slot_hash) =
            select_slot_hash_at_or_after(&slot_hashes_data, target_slot)?;
        let randomness = server_randomness_output(
            ctx.accounts.config.mint,
            round.id,
            &reveal,
            entropy_slot,
            &slot_hash,
        );
        // Preserve the server-mode flag while replacing the target with the
        // exact produced slot. This makes the proof self-contained in the
        // round and prevents the legacy Switchboard settlement path from ever
        // accepting it.
        round.randomness_commit_slot = encode_server_randomness_slot(entropy_slot)?;
        emit!(RoundServerEntropyRevealed {
            round_id: round.id,
            commitment,
            reveal,
            target_slot,
            entropy_slot,
            slot_hash,
            randomness,
            executor: ctx.accounts.executor.key(),
        });
        let liquidity_pool = ctx
            .accounts
            .liquidity_pool
            .as_ref()
            .map(|pool| pool.to_account_info());
        drop(slot_hashes_data);
        settle_round_core(
            round,
            &mut ctx.accounts.config,
            &mut ctx.accounts.stake_pool,
            ctx.accounts.liquidity_gate.as_ref(),
            liquidity_pool.as_ref(),
            &ctx.accounts.buyback_wallet.to_account_info(),
            &ctx.accounts.admin_fee_wallet.to_account_info(),
            ctx.accounts.myne_vault.as_ref(),
            ctx.accounts.sol_vault.as_ref(),
            randomness,
        )
    }

    pub fn claim_receipt(ctx: Context<ClaimReceipt>) -> Result<()> {
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
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
        validate_miner_shares(&mut ctx.accounts.miner, &ctx.accounts.mining_pool)?;
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;

        let rewards = receipt_rewards(&ctx.accounts.round, &ctx.accounts.receipt)?;
        let sol_reward = rewards.sol_lamports;
        let myne_reward = rewards.myne_base_units;
        let motherlode_reward = rewards.motherlode_base_units;
        accrue_receipt_sol(
            &mut ctx.accounts.round,
            &mut ctx.accounts.stake_pool,
            &mut ctx.accounts.stake_position,
            &mut ctx.accounts.miner,
            sol_reward,
        )?;
        if myne_reward > 0 && ctx.accounts.receipt.reward_mode == AUTO_REWARD_ACCUMULATE {
            credit_mining_rewards(
                &mut ctx.accounts.miner,
                &mut ctx.accounts.mining_pool,
                myne_reward,
            )?;
        }
        let burn_reward = if ctx.accounts.receipt.reward_mode == AUTO_REWARD_BURN {
            checked_add(myne_reward, motherlode_reward)?
        } else {
            motherlode_reward
        };
        add_virtual_burn(
            &mut ctx.accounts.config,
            &mut ctx.accounts.stake_pool,
            &mut ctx.accounts.stake_position,
            burn_reward,
        )?;
        if ctx.accounts.receipt.reward_mode == AUTO_REWARD_BURN {
            ctx.accounts.miner.lifetime_myne_claimed =
                checked_add(ctx.accounts.miner.lifetime_myne_claimed, myne_reward)?;
        }
        ctx.accounts.receipt.claimed = true;
        ctx.accounts.round.processed_receipts =
            checked_add(ctx.accounts.round.processed_receipts, 1)?;
        emit!(ReceiptRewardAccruedV1 {
            round_id: ctx.accounts.round.id,
            authority: ctx.accounts.authority.key(),
            nonce: ctx.accounts.receipt.nonce,
            sol_lamports: sol_reward,
            myne_base_units: myne_reward,
            motherlode_base_units: motherlode_reward,
            claim_vault: ctx.accounts.stake_pool.key(),
            pending_sol_after: ctx.accounts.stake_position.pending_sol,
        });
        Ok(())
    }

    /// Permissionless completion for receipts created by an Auto-burn plan.
    /// The reward mode is committed into the receipt before the outcome is
    /// known. Any keeper may execute this instruction, but SOL can only accrue
    /// in the receipt owner's canonical claim balance and MYNE can only become
    /// that owner's non-withdrawable 5x virtual burn stake.
    pub fn claim_auto_burn_receipt(ctx: Context<ClaimAutoBurnReceipt>) -> Result<()> {
        require!(!ctx.accounts.config.paused, MyneError::ProtocolPaused);
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        require!(ctx.accounts.round.settled, MyneError::RoundNotReady);
        require!(
            !ctx.accounts.receipt.claimed && !ctx.accounts.receipt.refunded,
            MyneError::ReceiptAlreadyProcessed
        );
        require!(
            ctx.accounts.receipt.reward_mode == AUTO_REWARD_BURN,
            MyneError::InvalidRewardMode
        );
        require_keys_eq!(
            ctx.accounts.receipt.authority,
            ctx.accounts.beneficiary.key(),
            MyneError::InvalidReceiptAuthority
        );
        require!(
            ctx.accounts.receipt.round_id == ctx.accounts.round.id,
            MyneError::InvalidRound
        );
        validate_miner_shares(&mut ctx.accounts.miner, &ctx.accounts.mining_pool)?;
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;
        let rewards = receipt_rewards(&ctx.accounts.round, &ctx.accounts.receipt)?;
        accrue_receipt_sol(
            &mut ctx.accounts.round,
            &mut ctx.accounts.stake_pool,
            &mut ctx.accounts.stake_position,
            &mut ctx.accounts.miner,
            rewards.sol_lamports,
        )?;
        let burned = checked_add(rewards.myne_base_units, rewards.motherlode_base_units)?;
        add_virtual_burn(
            &mut ctx.accounts.config,
            &mut ctx.accounts.stake_pool,
            &mut ctx.accounts.stake_position,
            burned,
        )?;
        ctx.accounts.miner.lifetime_myne_claimed = checked_add(
            ctx.accounts.miner.lifetime_myne_claimed,
            rewards.myne_base_units,
        )?;
        ctx.accounts.receipt.claimed = true;
        ctx.accounts.round.processed_receipts =
            checked_add(ctx.accounts.round.processed_receipts, 1)?;
        emit!(ReceiptRewardAccruedV1 {
            round_id: ctx.accounts.round.id,
            authority: ctx.accounts.beneficiary.key(),
            nonce: ctx.accounts.receipt.nonce,
            sol_lamports: rewards.sol_lamports,
            myne_base_units: rewards.myne_base_units,
            motherlode_base_units: rewards.motherlode_base_units,
            claim_vault: ctx.accounts.stake_pool.key(),
            pending_sol_after: ctx.accounts.stake_position.pending_sol,
        });
        Ok(())
    }

    /// Permissionless settlement for either reward mode. The beneficiary,
    /// miner and staking position are all constrained to the immutable receipt
    /// authority, so the executor can neither redirect the claim balance nor
    /// take MYNE. No reward SOL reaches a wallet until its owner later signs a
    /// claim-staking-rewards instruction.
    pub fn settle_receipt(ctx: Context<SettleReceipt>) -> Result<()> {
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        require!(ctx.accounts.round.settled, MyneError::RoundNotReady);
        require!(
            !ctx.accounts.receipt.claimed && !ctx.accounts.receipt.refunded,
            MyneError::ReceiptAlreadyProcessed
        );
        require!(
            ctx.accounts.receipt.round_id == ctx.accounts.round.id,
            MyneError::InvalidRound
        );
        validate_miner_shares(&mut ctx.accounts.miner, &ctx.accounts.mining_pool)?;
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;
        let rewards = receipt_rewards(&ctx.accounts.round, &ctx.accounts.receipt)?;
        accrue_receipt_sol(
            &mut ctx.accounts.round,
            &mut ctx.accounts.stake_pool,
            &mut ctx.accounts.stake_position,
            &mut ctx.accounts.miner,
            rewards.sol_lamports,
        )?;
        if ctx.accounts.receipt.reward_mode == AUTO_REWARD_ACCUMULATE {
            if rewards.myne_base_units > 0 {
                credit_mining_rewards(
                    &mut ctx.accounts.miner,
                    &mut ctx.accounts.mining_pool,
                    rewards.myne_base_units,
                )?;
            }
            add_virtual_burn(
                &mut ctx.accounts.config,
                &mut ctx.accounts.stake_pool,
                &mut ctx.accounts.stake_position,
                rewards.motherlode_base_units,
            )?;
        } else {
            require!(
                ctx.accounts.receipt.reward_mode == AUTO_REWARD_BURN,
                MyneError::InvalidRewardMode
            );
            let burned = checked_add(rewards.myne_base_units, rewards.motherlode_base_units)?;
            add_virtual_burn(
                &mut ctx.accounts.config,
                &mut ctx.accounts.stake_pool,
                &mut ctx.accounts.stake_position,
                burned,
            )?;
            ctx.accounts.miner.lifetime_myne_claimed = checked_add(
                ctx.accounts.miner.lifetime_myne_claimed,
                rewards.myne_base_units,
            )?;
        }
        ctx.accounts.receipt.claimed = true;
        ctx.accounts.round.processed_receipts =
            checked_add(ctx.accounts.round.processed_receipts, 1)?;
        emit!(ReceiptRewardAccruedV1 {
            round_id: ctx.accounts.round.id,
            authority: ctx.accounts.beneficiary.key(),
            nonce: ctx.accounts.receipt.nonce,
            sol_lamports: rewards.sol_lamports,
            myne_base_units: rewards.myne_base_units,
            motherlode_base_units: rewards.motherlode_base_units,
            claim_vault: ctx.accounts.stake_pool.key(),
            pending_sol_after: ctx.accounts.stake_position.pending_sol,
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
        ctx.accounts.round.processed_receipts =
            checked_add(ctx.accounts.round.processed_receipts, 1)?;
        emit!(ReceiptRefunded {
            round_id: ctx.accounts.round.id,
            authority: ctx.accounts.authority.key(),
            nonce: ctx.accounts.receipt.nonce,
            lamports: ctx.accounts.receipt.total_lamports
        });
        Ok(())
    }

    /// Permissionless refund for a round that missed its settlement deadline.
    /// SOL and eventual receipt rent remain constrained to the receipt owner.
    pub fn refund_receipt_permissionless(ctx: Context<RefundReceiptPermissionless>) -> Result<()> {
        require!(
            !ctx.accounts.round.settled
                && Clock::get()?.unix_timestamp >= ctx.accounts.round.refund_at,
            MyneError::RoundNotReady
        );
        require!(
            !ctx.accounts.receipt.claimed && !ctx.accounts.receipt.refunded,
            MyneError::ReceiptAlreadyProcessed
        );
        move_lamports(
            &ctx.accounts.round.to_account_info(),
            &ctx.accounts.beneficiary.to_account_info(),
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
        ctx.accounts.round.processed_receipts =
            checked_add(ctx.accounts.round.processed_receipts, 1)?;
        emit!(ReceiptRefunded {
            round_id: ctx.accounts.round.id,
            authority: ctx.accounts.beneficiary.key(),
            nonce: ctx.accounts.receipt.nonce,
            lamports: ctx.accounts.receipt.total_lamports,
        });
        Ok(())
    }

    /// The dedicated buyback signer records completion only after the swap and
    /// burn have been confirmed. This prevents a settled round from closing
    /// while its 1% allocation is still operationally outstanding.
    pub fn mark_buyback_completed(ctx: Context<MarkBuybackCompleted>) -> Result<()> {
        require!(ctx.accounts.round.settled, MyneError::RoundNotReady);
        require!(
            !ctx.accounts.round.buyback_completed,
            MyneError::BuybackAlreadyCompleted
        );
        ctx.accounts.round.buyback_completed = true;
        emit!(BuybackCompleted {
            round_id: ctx.accounts.round.id,
            authority: ctx.accounts.buyback_authority.key(),
        });
        Ok(())
    }

    /// Commit the canonical off-chain archive snapshot before any receipt can
    /// be closed. The randomness authority is already the round lifecycle
    /// authority and may attest only a non-zero content hash.
    pub fn archive_round(ctx: Context<ArchiveRound>, archive_hash: [u8; 32]) -> Result<()> {
        require!(archive_hash != [0; 32], MyneError::InvalidArchiveHash);
        require!(
            ctx.accounts.round.settled
                || Clock::get()?.unix_timestamp >= ctx.accounts.round.refund_at,
            MyneError::RoundNotReady
        );
        if ctx.accounts.round.settled {
            // A settled-round archive is the immutable audit snapshot used
            // before account cleanup. Do not permit it to be committed while
            // the round's buyback allocation is still outstanding.
            require!(
                ctx.accounts.round.buyback_completed,
                MyneError::BuybackNotCompleted
            );
        }
        require!(
            ctx.accounts.round.archived_at_slot == 0,
            MyneError::RoundAlreadyArchived
        );
        require!(
            ctx.accounts.round.processed_receipts == ctx.accounts.round.total_receipts,
            MyneError::RoundCleanupIncomplete
        );
        ctx.accounts.round.archive_hash = archive_hash;
        ctx.accounts.round.archived_at_slot = Clock::get()?.slot;
        emit!(RoundArchived {
            round_id: ctx.accounts.round.id,
            archive_hash,
            slot: ctx.accounts.round.archived_at_slot,
        });
        Ok(())
    }

    /// Close one already-processed receipt after the round snapshot has been
    /// archived. Anyone may pay for cleanup, but Anchor always returns rent to
    /// the immutable receipt beneficiary. For auto-round receipts the user's
    /// plan reimburses the executor at creation, so the user is the economic
    /// rent payer.
    pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
        require!(
            ctx.accounts.round.archived_at_slot > 0,
            MyneError::RoundNotArchived
        );
        require!(
            ctx.accounts.receipt.claimed || ctx.accounts.receipt.refunded,
            MyneError::ReceiptNotProcessed
        );
        ctx.accounts.round.closed_receipts = checked_add(ctx.accounts.round.closed_receipts, 1)?;
        emit!(ReceiptClosed {
            round_id: ctx.accounts.round.id,
            authority: ctx.accounts.beneficiary.key(),
            nonce: ctx.accounts.receipt.nonce,
        });
        Ok(())
    }

    /// Close a fully-drained and archived round. The instruction is
    /// permissionless, while the rent destination is constrained to the payer
    /// recorded when the PDA was created.
    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        require!(
            ctx.accounts.round.archived_at_slot > 0,
            MyneError::RoundNotArchived
        );
        require!(
            ctx.accounts.round.processed_receipts == ctx.accounts.round.total_receipts
                && ctx.accounts.round.closed_receipts == ctx.accounts.round.total_receipts,
            MyneError::RoundCleanupIncomplete
        );
        if ctx.accounts.round.settled {
            require!(
                ctx.accounts.round.buyback_completed,
                MyneError::BuybackNotCompleted
            );
            // The round account must contain rent only when it closes. This
            // explicit economic invariant prevents a future reward-math or
            // keeper regression from returning unclaimed player SOL to the
            // round creator as though it were account rent.
            let total_player_payout = checked_add(
                ctx.accounts.round.prize_lamports,
                ctx.accounts.round.motherlode_payout_lamports,
            )?;
            require!(
                ctx.accounts.round.claimed_lamports == total_player_payout,
                MyneError::RoundPayoutIncomplete
            );
        } else {
            require!(
                Clock::get()?.unix_timestamp >= ctx.accounts.round.refund_at,
                MyneError::RoundNotReady
            );
        }
        emit!(RoundClosed {
            round_id: ctx.accounts.round.id,
            rent_payer: ctx.accounts.rent_payer.key(),
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
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        require!(amount > 0, MyneError::InsufficientBalance);
        assert_canonical_stake_vault(
            ctx.accounts.vault_tokens.key(),
            ctx.accounts.stake_pool.key(),
            ctx.accounts.mint.key(),
            ctx.accounts.token_program.key(),
        )?;
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;
        let was_inactive = ctx.accounts.stake_position.reward_weight == 0;
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
        if was_inactive {
            ctx.accounts.stake_pool.active_stakers =
                checked_add(ctx.accounts.stake_pool.active_stakers, 1)?;
        }
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
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        require!(amount > 0, MyneError::InsufficientBalance);
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;
        let was_inactive = ctx.accounts.stake_position.reward_weight == 0;
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
        if was_inactive {
            ctx.accounts.stake_pool.active_stakers =
                checked_add(ctx.accounts.stake_pool.active_stakers, 1)?;
        }
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
        if ctx.accounts.stake_position.reward_weight == 0 {
            ctx.accounts.stake_pool.active_stakers = ctx
                .accounts
                .stake_pool
                .active_stakers
                .checked_sub(1)
                .ok_or(MyneError::ArithmeticOverflow)?;
        }
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
        assert_canonical_stake_vault(
            ctx.accounts.vault_tokens.key(),
            ctx.accounts.stake_pool.key(),
            ctx.accounts.mint.key(),
            ctx.accounts.token_program.key(),
        )?;
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

    /// Converts every accumulated mining reward into permanent 5x burn-stake weight.
    ///
    /// The MYNE represented by the miner's outstanding reward shares has not been minted yet, so
    /// this path records the same permanent virtual burn used by Auto-burn instead of minting
    /// tokens only to burn them in a second instruction. No claim fee is taken: no liquid MYNE
    /// leaves the protocol, and the authority can only increase its own canonical stake position.
    /// This is an earned-reward exit, so an emergency mining pause must not trap it.
    pub fn burn_unclaimed_myne(ctx: Context<BurnUnclaimedMyne>) -> Result<()> {
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        checkpoint_stake(&mut ctx.accounts.stake_position, &ctx.accounts.stake_pool)?;

        let amount =
            debit_all_mining_rewards(&mut ctx.accounts.miner, &mut ctx.accounts.mining_pool)?;
        add_virtual_burn(
            &mut ctx.accounts.config,
            &mut ctx.accounts.stake_pool,
            &mut ctx.accounts.stake_position,
            amount,
        )?;
        ctx.accounts.miner.lifetime_myne_claimed =
            checked_add(ctx.accounts.miner.lifetime_myne_claimed, amount)?;

        emit!(StakeChanged {
            authority: ctx.accounts.authority.key(),
            standard_delta: 0,
            burn_delta: amount as i128,
        });
        emit!(UnclaimedMyneBurned {
            authority: ctx.accounts.authority.key(),
            amount,
            reward_weight_added: amount
                .checked_mul(BURN_WEIGHT_MULTIPLIER)
                .ok_or(MyneError::ArithmeticOverflow)?,
        });
        Ok(())
    }

    /// Withdraws already-earned mining MYNE. The pause switch blocks new protocol exposure, not
    /// owner-authorized reward exits; all canonical PDA, mint, token-account and fee constraints
    /// remain enforced by `ClaimMyne` and this handler.
    pub fn claim_myne(ctx: Context<ClaimMyne>) -> Result<()> {
        require_eq!(
            ctx.accounts.config.version,
            CURRENT_VERSION,
            MyneError::ProtocolUpgradeRequired
        );
        let gross =
            debit_all_mining_rewards(&mut ctx.accounts.miner, &mut ctx.accounts.mining_pool)?;
        let total_fee = checked_bps(gross, CLAIM_FEE_BPS)?;
        let passive_fee = checked_bps(gross, CLAIM_PASSIVE_BPS)?;
        let referral_share = total_fee
            .checked_sub(passive_fee)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let has_referrer = ctx.accounts.miner.referrer != Pubkey::default();
        let referral_fee = if has_referrer { referral_share } else { 0 };
        let admin_fee = if has_referrer { 0 } else { referral_share };
        if admin_fee > 0 {
            let admin_fee_tokens = ctx
                .accounts
                .admin_fee_tokens
                .as_ref()
                .ok_or(MyneError::InvalidFeeDestination)?;
            assert_canonical_token_account(
                admin_fee_tokens.key(),
                ctx.accounts.config.admin_fee_wallet,
                ctx.accounts.mint.key(),
                ctx.accounts.token_program.key(),
                MyneError::InvalidFeeDestination,
            )?;
        }
        // Allocate the 9% passive fee before creating the new 1% referral
        // credit. Existing referrer shares still participate, but the reward
        // created by this claim cannot retroactively earn the same claim's fee.
        distribute_mining_rewards(&mut ctx.accounts.mining_pool, passive_fee)?;
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
            credit_mining_rewards(referrer, &mut ctx.accounts.mining_pool, referral_fee)?;
        }
        // Keep the passive holder pool at exactly 9%. If no referrer was recorded, the remaining
        // 1% is paid to the configured admin fee wallet instead of silently joining that pool.
        let net = gross
            .checked_sub(total_fee)
            .ok_or(MyneError::ArithmeticOverflow)?;
        // The fallback path mints the 1% admin allocation separately when no
        // referrer exists, so both mint legs must fit under the hard cap.
        let total_mint = checked_add(net, admin_fee)?;
        let max_supply = max_supply_base_units()?;
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
            let admin_fee_tokens = ctx
                .accounts
                .admin_fee_tokens
                .as_ref()
                .ok_or(MyneError::InvalidFeeDestination)?;
            token_interface::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    MintTo {
                        mint: ctx.accounts.mint.to_account_info(),
                        to: admin_fee_tokens.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer,
                ),
                admin_fee,
            )?;
        }
        ctx.accounts.miner.lifetime_myne_claimed =
            checked_add(ctx.accounts.miner.lifetime_myne_claimed, net)?;
        emit!(MyneClaimed {
            authority: ctx.accounts.authority.key(),
            gross_base_units: gross,
            net_base_units: net,
            fee_base_units: total_fee,
            referral_base_units: referral_fee,
            admin_base_units: admin_fee,
        });
        emit!(ClaimFeeRoutedV2 {
            claimant: ctx.accounts.authority.key(),
            passive_base_units: passive_fee,
            referral_wallet: if has_referrer {
                ctx.accounts.miner.referrer
            } else {
                Pubkey::default()
            },
            referral_base_units: referral_fee,
            admin_fee_wallet: ctx.accounts.config.admin_fee_wallet,
            admin_base_units: admin_fee,
        });
        Ok(())
    }
}

fn checked_add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(MyneError::ArithmeticOverflow))
}

fn assert_operational_roles_distinct(
    randomness_authority: Pubkey,
    buyback_wallet: Pubkey,
    admin_fee_wallet: Pubkey,
) -> Result<()> {
    require_keys_neq!(
        randomness_authority,
        buyback_wallet,
        MyneError::InvalidAuthority
    );
    require_keys_neq!(
        randomness_authority,
        admin_fee_wallet,
        MyneError::InvalidAuthority
    );
    require_keys_neq!(
        buyback_wallet,
        admin_fee_wallet,
        MyneError::InvalidAuthority
    );
    Ok(())
}
fn checked_sum(values: &[u64; TILE_COUNT]) -> Result<u64> {
    values
        .iter()
        .try_fold(0u64, |sum, value| checked_add(sum, *value))
}
fn max_supply_base_units() -> Result<u64> {
    GENESIS_BASE_UNITS
        .checked_mul(MAX_TOKENS / GENESIS_TOKENS)
        .ok_or_else(|| error!(MyneError::ArithmeticOverflow))
}

/// Normal emissions stop at the hard cap, but already accumulated Motherlode
/// SOL/MYNE must remain payable. Payout-only rounds may therefore continue
/// until a funded Motherlode hits; the following round then fails closed.
fn round_can_open_after_emission(
    total_emitted_base_units: u64,
    motherlode_base_units: u64,
    motherlode_lamports: u64,
) -> Result<bool> {
    let maximum = max_supply_base_units()?;
    require!(
        total_emitted_base_units <= maximum,
        MyneError::InvalidSupply
    );
    Ok(total_emitted_base_units < maximum || motherlode_base_units > 0 || motherlode_lamports > 0)
}

/// Compile-time release policy. A `production` SBF artifact cannot initialize,
/// unpause or operate with caller-supplied/devnet randomness, even if it is
/// installed over a configuration created by an older rehearsal build. Both
/// production modes remain Meteora-gated by `liquidity_gate_required`.
fn assert_randomness_program_allowed_for_build(randomness_program: Pubkey) -> Result<()> {
    #[cfg(feature = "production")]
    require!(
        randomness_program == SWITCHBOARD_MAINNET_PROGRAM
            || randomness_program == SERVER_RANDOMNESS_PROGRAM,
        MyneError::ProductionRandomnessRequired
    );

    #[cfg(not(feature = "production"))]
    require!(
        randomness_program == Pubkey::default()
            || randomness_program == SWITCHBOARD_DEVNET_PROGRAM
            || randomness_program == SWITCHBOARD_MAINNET_PROGRAM
            || randomness_program == SERVER_RANDOMNESS_PROGRAM,
        MyneError::InvalidRandomnessAccount
    );
    Ok(())
}

fn is_switchboard_program(randomness_program: Pubkey) -> bool {
    randomness_program == SWITCHBOARD_DEVNET_PROGRAM
        || randomness_program == SWITCHBOARD_MAINNET_PROGRAM
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

/// Allocate a receipt's exact slice of an integer pool using cumulative
/// boundaries. Adjacent receipts telescope, so the final receipt receives any
/// rounding remainder and the whole pool is accounted for.
fn proportional_interval_share(
    pool: u64,
    cumulative_start: u64,
    amount: u64,
    denominator: u64,
) -> Result<u64> {
    require!(denominator > 0, MyneError::ArithmeticOverflow);
    let cumulative_end = checked_add(cumulative_start, amount)?;
    require!(cumulative_end <= denominator, MyneError::ArithmeticOverflow);
    mul_div(pool, cumulative_end, denominator)?
        .checked_sub(mul_div(pool, cumulative_start, denominator)?)
        .ok_or_else(|| error!(MyneError::ArithmeticOverflow))
}

/// Shares a Motherlode hit across every receipt in proportion to that receipt's
/// total round deployment. The SOL and MYNE legs use the same denominator, so
/// each claimant receives both awards atomically during `claim_receipt`.
struct ReceiptRewards {
    sol_lamports: u64,
    myne_base_units: u64,
    motherlode_base_units: u64,
}

fn receipt_rewards(round: &Round, receipt: &BetReceipt) -> Result<ReceiptRewards> {
    let tile = round.winning_tile as usize;
    require!(tile < TILE_COUNT, MyneError::InvalidRound);
    let amount = receipt.amounts[tile];
    let winning_total = round.tile_lamports[tile];
    let mut sol_lamports = 0;
    let mut myne_base_units = 0;
    let mut motherlode_base_units = 0;
    if amount > 0 && winning_total > 0 {
        let tile_start = receipt.cumulative_starts[tile];
        sol_lamports =
            proportional_interval_share(round.prize_lamports, tile_start, amount, winning_total)?;
        if round.solo_mode {
            let start = tile_start;
            let end = checked_add(start, amount)?;
            if round.solo_sample >= start && round.solo_sample < end {
                myne_base_units = round.base_emission;
            }
        } else {
            myne_base_units = proportional_interval_share(
                round.base_emission,
                tile_start,
                amount,
                winning_total,
            )?;
        }
    }
    // Motherlode SOL and staking-bonus MYNE are round-wide and always shared
    // by total deployment, independent of the normal winning tile.
    let round_start = receipt
        .cumulative_starts
        .iter()
        .try_fold(0u64, |sum, value| checked_add(sum, *value))?;
    let shared_sol = if round.gross_deployed_lamports > 0 {
        proportional_interval_share(
            round.motherlode_payout_lamports,
            round_start,
            receipt.total_lamports,
            round.gross_deployed_lamports,
        )?
    } else {
        0
    };
    let shared_myne = if round.gross_deployed_lamports > 0 {
        proportional_interval_share(
            round.motherlode_emission,
            round_start,
            receipt.total_lamports,
            round.gross_deployed_lamports,
        )?
    } else {
        0
    };
    sol_lamports = checked_add(sol_lamports, shared_sol)?;
    motherlode_base_units = checked_add(motherlode_base_units, shared_myne)?;
    Ok(ReceiptRewards {
        sol_lamports,
        myne_base_units,
        motherlode_base_units,
    })
}

fn add_virtual_burn(
    config: &mut Account<ProtocolConfig>,
    stake_pool: &mut Account<StakePool>,
    stake_position: &mut Account<StakePosition>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let was_inactive = stake_position.reward_weight == 0;
    let weight = amount
        .checked_mul(BURN_WEIGHT_MULTIPLIER)
        .ok_or(MyneError::ArithmeticOverflow)?;
    stake_position.burn_principal = checked_add(stake_position.burn_principal, amount)?;
    stake_position.reward_weight = checked_add(stake_position.reward_weight, weight)?;
    stake_pool.total_burn = checked_add(stake_pool.total_burn, amount)?;
    stake_pool.total_weight = checked_add(stake_pool.total_weight, weight)?;
    if was_inactive {
        stake_pool.active_stakers = checked_add(stake_pool.active_stakers, 1)?;
    }
    config.virtual_burn_base_units = checked_add(config.virtual_burn_base_units, amount)?;
    fund_stake_rewards(stake_pool, 0)
}

fn motherlode_hit(sample: u64) -> bool {
    sample.is_multiple_of(MOTHERLODE_ODDS)
}

fn motherlode_pays_round(hit: bool, gross_deployed_lamports: u64) -> bool {
    hit && gross_deployed_lamports > 0
}

/// Reserve MYNE only for rounds that actually accepted a deployment. Empty
/// scheduled rounds still settle and publish their verifiable winning tile,
/// but they must not advance issued-supply accounting or create a reward that
/// a future participant can capture.
fn round_emissions(
    remaining_emission: u64,
    gross_deployed_lamports: u64,
    winning_total_lamports: u64,
) -> Result<(u64, u64)> {
    if gross_deployed_lamports == 0 {
        return Ok((0, 0));
    }
    let motherlode_emission = remaining_emission.min(MOTHERLODE_ROUND_EMISSION);
    let remaining_after_motherlode = remaining_emission
        .checked_sub(motherlode_emission)
        .ok_or(MyneError::ArithmeticOverflow)?;
    let base_emission = if winning_total_lamports > 0 {
        remaining_after_motherlode.min(BASE_ROUND_EMISSION)
    } else {
        0
    };
    Ok((motherlode_emission, base_emission))
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
        require!(
            is_supported_meteora_program(gate.pool_program),
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
        assert_meteora_pool_accounts(
            gate.pool_program,
            pool,
            config.mint,
            base_vault.key(),
            quote_vault.key(),
        )?;
        require!(
            base_vault.amount >= gate.min_myne_base_units
                && quote_vault.amount >= gate.min_sol_lamports,
            MyneError::InvalidLiquidityPool
        );
    }
    Ok(())
}

fn is_supported_meteora_program(program: Pubkey) -> bool {
    program == METEORA_DLMM_PROGRAM || program == METEORA_DAMM_V2_PROGRAM
}

fn assert_meteora_pool_accounts(
    pool_program: Pubkey,
    pool: &AccountInfo<'_>,
    myne_mint: Pubkey,
    myne_vault: Pubkey,
    sol_vault: Pubkey,
) -> Result<()> {
    require_keys_eq!(*pool.owner, pool_program, MyneError::InvalidLiquidityPool);
    if pool_program == METEORA_DLMM_PROGRAM {
        let data = pool
            .try_borrow_data()
            .map_err(|_| error!(MyneError::InvalidLiquidityPool))?;
        let state = parse_meteora_lb_pair(&data)?;
        require!(
            (state.token_x_mint == myne_mint && state.token_y_mint == WRAPPED_SOL_MINT)
                || (state.token_y_mint == myne_mint && state.token_x_mint == WRAPPED_SOL_MINT),
            MyneError::InvalidLiquidityPool
        );
        let expected_myne_vault = if state.token_x_mint == myne_mint {
            state.reserve_x
        } else {
            state.reserve_y
        };
        let expected_sol_vault = if state.token_x_mint == WRAPPED_SOL_MINT {
            state.reserve_x
        } else {
            state.reserve_y
        };
        require_keys_eq!(
            myne_vault,
            expected_myne_vault,
            MyneError::InvalidLiquidityPool
        );
        require_keys_eq!(
            sol_vault,
            expected_sol_vault,
            MyneError::InvalidLiquidityPool
        );
        require!(
            state.status == METEORA_LB_PAIR_ENABLED,
            MyneError::InvalidLiquidityPool
        );
        if state.activation_point > 0 {
            let clock = Clock::get()?;
            let current_point = match state.activation_type {
                0 => clock.slot,
                1 => u64::try_from(clock.unix_timestamp)
                    .map_err(|_| error!(MyneError::InvalidLiquidityPool))?,
                _ => return err!(MyneError::InvalidLiquidityPool),
            };
            require!(
                current_point >= state.activation_point,
                MyneError::InvalidLiquidityPool
            );
        }
        assert_meteora_reserve(pool_program, pool.key(), myne_vault, myne_mint)?;
        assert_meteora_reserve(pool_program, pool.key(), sol_vault, WRAPPED_SOL_MINT)?;
        return Ok(());
    }
    require_keys_eq!(
        pool_program,
        METEORA_DAMM_V2_PROGRAM,
        MyneError::InvalidLiquidityPool
    );
    let data = pool
        .try_borrow_data()
        .map_err(|_| error!(MyneError::InvalidLiquidityPool))?;
    let state = parse_meteora_damm_v2_pool(&data)?;
    require!(
        (state.token_a_mint == myne_mint && state.token_b_mint == WRAPPED_SOL_MINT)
            || (state.token_b_mint == myne_mint && state.token_a_mint == WRAPPED_SOL_MINT),
        MyneError::InvalidLiquidityPool
    );
    let expected_myne_vault = if state.token_a_mint == myne_mint {
        state.token_a_vault
    } else {
        state.token_b_vault
    };
    let expected_sol_vault = if state.token_a_mint == WRAPPED_SOL_MINT {
        state.token_a_vault
    } else {
        state.token_b_vault
    };
    require_keys_eq!(
        myne_vault,
        expected_myne_vault,
        MyneError::InvalidLiquidityPool
    );
    require_keys_eq!(
        sol_vault,
        expected_sol_vault,
        MyneError::InvalidLiquidityPool
    );
    assert_meteora_reserve(pool_program, pool.key(), myne_vault, myne_mint)?;
    assert_meteora_reserve(pool_program, pool.key(), sol_vault, WRAPPED_SOL_MINT)?;
    require!(
        state.pool_status == METEORA_DAMM_POOL_ENABLED,
        MyneError::InvalidLiquidityPool
    );
    require!(
        state.pool_type == METEORA_DAMM_PERMISSIONLESS_POOL
            || state.pool_type == METEORA_DAMM_CUSTOMIZABLE_POOL,
        MyneError::InvalidLiquidityPool
    );
    let clock = Clock::get()?;
    let current_point = match state.activation_type {
        0 => clock.slot,
        1 => u64::try_from(clock.unix_timestamp)
            .map_err(|_| error!(MyneError::InvalidLiquidityPool))?,
        _ => return err!(MyneError::InvalidLiquidityPool),
    };
    require!(
        current_point >= state.activation_point,
        MyneError::InvalidLiquidityPool
    );
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MeteoraDammV2PoolState {
    token_a_mint: Pubkey,
    token_b_mint: Pubkey,
    token_a_vault: Pubkey,
    token_b_vault: Pubkey,
    activation_point: u64,
    activation_type: u8,
    pool_status: u8,
    pool_type: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MeteoraLbPairState {
    token_x_mint: Pubkey,
    token_y_mint: Pubkey,
    reserve_x: Pubkey,
    reserve_y: Pubkey,
    status: u8,
    activation_type: u8,
    activation_point: u64,
}

fn parse_meteora_lb_pair(data: &[u8]) -> Result<MeteoraLbPairState> {
    require!(
        data.len() == METEORA_LB_PAIR_SIZE
            && data[..METEORA_LB_PAIR_DISCRIMINATOR.len()] == METEORA_LB_PAIR_DISCRIMINATOR,
        MyneError::InvalidLiquidityPool
    );
    Ok(MeteoraLbPairState {
        token_x_mint: read_pubkey(data, METEORA_LB_PAIR_TOKEN_X_MINT_OFFSET)?,
        token_y_mint: read_pubkey(data, METEORA_LB_PAIR_TOKEN_Y_MINT_OFFSET)?,
        reserve_x: read_pubkey(data, METEORA_LB_PAIR_RESERVE_X_OFFSET)?,
        reserve_y: read_pubkey(data, METEORA_LB_PAIR_RESERVE_Y_OFFSET)?,
        status: *data
            .get(METEORA_LB_PAIR_STATUS_OFFSET)
            .ok_or(MyneError::InvalidLiquidityPool)?,
        activation_type: *data
            .get(METEORA_LB_PAIR_ACTIVATION_TYPE_OFFSET)
            .ok_or(MyneError::InvalidLiquidityPool)?,
        activation_point: read_u64(data, METEORA_LB_PAIR_ACTIVATION_POINT_OFFSET)?,
    })
}

fn parse_meteora_damm_v2_pool(data: &[u8]) -> Result<MeteoraDammV2PoolState> {
    require!(
        data.len() == METEORA_DAMM_V2_POOL_SIZE
            && data[..METEORA_DAMM_V2_POOL_DISCRIMINATOR.len()]
                == METEORA_DAMM_V2_POOL_DISCRIMINATOR,
        MyneError::InvalidLiquidityPool
    );
    Ok(MeteoraDammV2PoolState {
        token_a_mint: read_pubkey(data, METEORA_DAMM_TOKEN_A_MINT_OFFSET)?,
        token_b_mint: read_pubkey(data, METEORA_DAMM_TOKEN_B_MINT_OFFSET)?,
        token_a_vault: read_pubkey(data, METEORA_DAMM_TOKEN_A_VAULT_OFFSET)?,
        token_b_vault: read_pubkey(data, METEORA_DAMM_TOKEN_B_VAULT_OFFSET)?,
        activation_point: read_u64(data, METEORA_DAMM_ACTIVATION_POINT_OFFSET)?,
        activation_type: *data
            .get(METEORA_DAMM_ACTIVATION_TYPE_OFFSET)
            .ok_or(MyneError::InvalidLiquidityPool)?,
        pool_status: *data
            .get(METEORA_DAMM_POOL_STATUS_OFFSET)
            .ok_or(MyneError::InvalidLiquidityPool)?,
        pool_type: *data
            .get(METEORA_DAMM_POOL_TYPE_OFFSET)
            .ok_or(MyneError::InvalidLiquidityPool)?,
    })
}

fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes: [u8; 32] = data
        .get(offset..offset + 32)
        .ok_or(MyneError::InvalidLiquidityPool)?
        .try_into()
        .map_err(|_| error!(MyneError::InvalidLiquidityPool))?;
    Ok(Pubkey::new_from_array(bytes))
}

fn read_u64(data: &[u8], offset: usize) -> Result<u64> {
    let bytes: [u8; 8] = data
        .get(offset..offset + 8)
        .ok_or(MyneError::InvalidLiquidityPool)?
        .try_into()
        .map_err(|_| error!(MyneError::InvalidLiquidityPool))?;
    Ok(u64::from_le_bytes(bytes))
}

/// Meteora DLMM reserve accounts are PDAs with seeds `[lb_pair, token_mint]`.
/// Binding both reserve addresses prevents an unrelated funded token account
/// from being paired with a genuine Meteora-owned pool account.
fn assert_meteora_reserve(
    pool_program: Pubkey,
    pool: Pubkey,
    reserve: Pubkey,
    mint: Pubkey,
) -> Result<()> {
    let seeds: &[&[u8]] = if pool_program == METEORA_DAMM_V2_PROGRAM {
        &[METEORA_DAMM_TOKEN_VAULT_SEED, mint.as_ref(), pool.as_ref()]
    } else {
        &[pool.as_ref(), mint.as_ref()]
    };
    let (expected, _) = Pubkey::find_program_address(seeds, &pool_program);
    require_keys_eq!(reserve, expected, MyneError::InvalidLiquidityPool);
    Ok(())
}

fn assert_canonical_stake_vault(
    vault: Pubkey,
    stake_pool: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
) -> Result<()> {
    assert_canonical_token_account(
        vault,
        stake_pool,
        mint,
        token_program,
        MyneError::InvalidStakeVault,
    )
}

fn assert_canonical_token_account(
    account: Pubkey,
    authority: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
    error_code: MyneError,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[authority.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM,
    );
    require_keys_eq!(account, expected, error_code);
    Ok(())
}

#[cfg(test)]
mod motherlode_tests {
    use super::{
        assert_auto_plan_reward_mode, assert_operational_roles_distinct,
        assert_randomness_program_allowed_for_build, auto_plan_receipt_reward_mode,
        auto_plan_reinvests_sol, checked_bps, distribute_mining_rewards,
        is_supported_meteora_program, liquidity_gate_required, max_supply_base_units,
        mining_basis_after_credit, mining_share_value, mining_shares_for_credit, motherlode_hit,
        motherlode_pays_round, mul_div, mul_div_u64_u128, parse_meteora_damm_v2_pool,
        parse_meteora_lb_pair, proportional_interval_share, round_can_open_after_emission,
        round_emissions, select_slot_hash_at_or_after, server_randomness_commitment,
        server_randomness_output, stake_reward_increment_and_remainder,
        switchboard_randomness_is_uncommitted, AUTO_PLAN_REINVEST_SOL, AUTO_REWARD_ACCUMULATE,
        AUTO_REWARD_BURN, BASE_ROUND_EMISSION, BURN_WEIGHT_MULTIPLIER,
        METEORA_DAMM_ACTIVATION_POINT_OFFSET, METEORA_DAMM_ACTIVATION_TYPE_OFFSET,
        METEORA_DAMM_POOL_STATUS_OFFSET, METEORA_DAMM_POOL_TYPE_OFFSET,
        METEORA_DAMM_TOKEN_A_MINT_OFFSET, METEORA_DAMM_TOKEN_A_VAULT_OFFSET,
        METEORA_DAMM_TOKEN_B_MINT_OFFSET, METEORA_DAMM_TOKEN_B_VAULT_OFFSET,
        METEORA_DAMM_V2_POOL_DISCRIMINATOR, METEORA_DAMM_V2_POOL_SIZE, METEORA_DAMM_V2_PROGRAM,
        METEORA_DLMM_PROGRAM, METEORA_LB_PAIR_ACTIVATION_POINT_OFFSET,
        METEORA_LB_PAIR_ACTIVATION_TYPE_OFFSET, METEORA_LB_PAIR_DISCRIMINATOR,
        METEORA_LB_PAIR_RESERVE_X_OFFSET, METEORA_LB_PAIR_RESERVE_Y_OFFSET, METEORA_LB_PAIR_SIZE,
        METEORA_LB_PAIR_STATUS_OFFSET, METEORA_LB_PAIR_TOKEN_X_MINT_OFFSET,
        METEORA_LB_PAIR_TOKEN_Y_MINT_OFFSET, MINING_PROTOCOL_FEE_BPS, MINING_SHARE_SCALE,
        MOTHERLODE_ODDS, REWARD_SCALE, SERVER_ENTROPY_DELAY_SLOTS, SERVER_RANDOMNESS_PENDING,
        SERVER_RANDOMNESS_PROGRAM, SERVER_RANDOMNESS_SLOT_MASK, SWITCHBOARD_DEVNET_PROGRAM,
        SWITCHBOARD_MAINNET_PROGRAM,
    };
    use super::{
        decode_server_randomness_slot, encode_server_randomness_slot, is_fresh_switchboard_commit,
        server_randomness_slot_is_encoded, SwitchboardRandomness,
    };
    use crate::state::MiningPool;
    use anchor_lang::prelude::Pubkey;

    #[test]
    fn auto_plan_composite_mode_preserves_receipt_mode_and_explicit_consent() {
        assert!(assert_auto_plan_reward_mode(AUTO_REWARD_ACCUMULATE).is_ok());
        assert!(assert_auto_plan_reward_mode(AUTO_REWARD_BURN).is_ok());
        assert!(assert_auto_plan_reward_mode(AUTO_PLAN_REINVEST_SOL).is_ok());
        assert!(assert_auto_plan_reward_mode(AUTO_PLAN_REINVEST_SOL | AUTO_REWARD_BURN).is_ok());
        assert!(assert_auto_plan_reward_mode(1 << 2).is_err());
        assert_eq!(
            auto_plan_receipt_reward_mode(AUTO_PLAN_REINVEST_SOL).unwrap(),
            AUTO_REWARD_ACCUMULATE,
        );
        assert_eq!(
            auto_plan_receipt_reward_mode(AUTO_PLAN_REINVEST_SOL | AUTO_REWARD_BURN).unwrap(),
            AUTO_REWARD_BURN,
        );
        assert!(!auto_plan_reinvests_sol(AUTO_REWARD_BURN));
        assert!(auto_plan_reinvests_sol(AUTO_PLAN_REINVEST_SOL));
    }

    #[test]
    fn meteora_gate_accepts_only_the_lb_pair_account_discriminator() {
        let token_x_mint = Pubkey::new_unique();
        let token_y_mint = Pubkey::new_unique();
        let reserve_x = Pubkey::new_unique();
        let reserve_y = Pubkey::new_unique();
        let mut valid = vec![0u8; METEORA_LB_PAIR_SIZE];
        valid[..8].copy_from_slice(&METEORA_LB_PAIR_DISCRIMINATOR);
        valid[METEORA_LB_PAIR_TOKEN_X_MINT_OFFSET..METEORA_LB_PAIR_TOKEN_X_MINT_OFFSET + 32]
            .copy_from_slice(token_x_mint.as_ref());
        valid[METEORA_LB_PAIR_TOKEN_Y_MINT_OFFSET..METEORA_LB_PAIR_TOKEN_Y_MINT_OFFSET + 32]
            .copy_from_slice(token_y_mint.as_ref());
        valid[METEORA_LB_PAIR_RESERVE_X_OFFSET..METEORA_LB_PAIR_RESERVE_X_OFFSET + 32]
            .copy_from_slice(reserve_x.as_ref());
        valid[METEORA_LB_PAIR_RESERVE_Y_OFFSET..METEORA_LB_PAIR_RESERVE_Y_OFFSET + 32]
            .copy_from_slice(reserve_y.as_ref());
        valid[METEORA_LB_PAIR_STATUS_OFFSET] = 0;
        valid[METEORA_LB_PAIR_ACTIVATION_TYPE_OFFSET] = 1;
        valid[METEORA_LB_PAIR_ACTIVATION_POINT_OFFSET..METEORA_LB_PAIR_ACTIVATION_POINT_OFFSET + 8]
            .copy_from_slice(&456u64.to_le_bytes());
        let parsed = parse_meteora_lb_pair(&valid).unwrap();
        assert_eq!(parsed.token_x_mint, token_x_mint);
        assert_eq!(parsed.token_y_mint, token_y_mint);
        assert_eq!(parsed.reserve_x, reserve_x);
        assert_eq!(parsed.reserve_y, reserve_y);
        assert_eq!(parsed.status, 0);
        assert_eq!(parsed.activation_type, 1);
        assert_eq!(parsed.activation_point, 456);
        assert!(parse_meteora_lb_pair(&valid[..7]).is_err());
        assert!(parse_meteora_lb_pair(&valid[..valid.len() - 1]).is_err());

        valid[0] ^= 1;
        assert!(parse_meteora_lb_pair(&valid).is_err());
    }

    #[test]
    fn meteora_gate_parses_only_the_pinned_damm_v2_pool_layout() {
        let token_a_mint = Pubkey::new_unique();
        let token_b_mint = Pubkey::new_unique();
        let token_a_vault = Pubkey::new_unique();
        let token_b_vault = Pubkey::new_unique();
        let mut data = vec![0u8; METEORA_DAMM_V2_POOL_SIZE];
        data[..8].copy_from_slice(&METEORA_DAMM_V2_POOL_DISCRIMINATOR);
        data[METEORA_DAMM_TOKEN_A_MINT_OFFSET..METEORA_DAMM_TOKEN_A_MINT_OFFSET + 32]
            .copy_from_slice(token_a_mint.as_ref());
        data[METEORA_DAMM_TOKEN_B_MINT_OFFSET..METEORA_DAMM_TOKEN_B_MINT_OFFSET + 32]
            .copy_from_slice(token_b_mint.as_ref());
        data[METEORA_DAMM_TOKEN_A_VAULT_OFFSET..METEORA_DAMM_TOKEN_A_VAULT_OFFSET + 32]
            .copy_from_slice(token_a_vault.as_ref());
        data[METEORA_DAMM_TOKEN_B_VAULT_OFFSET..METEORA_DAMM_TOKEN_B_VAULT_OFFSET + 32]
            .copy_from_slice(token_b_vault.as_ref());
        data[METEORA_DAMM_ACTIVATION_POINT_OFFSET..METEORA_DAMM_ACTIVATION_POINT_OFFSET + 8]
            .copy_from_slice(&123u64.to_le_bytes());
        data[METEORA_DAMM_ACTIVATION_TYPE_OFFSET] = 1;
        data[METEORA_DAMM_POOL_STATUS_OFFSET] = 0;
        data[METEORA_DAMM_POOL_TYPE_OFFSET] = 1;

        let parsed = parse_meteora_damm_v2_pool(&data).unwrap();
        assert_eq!(parsed.token_a_mint, token_a_mint);
        assert_eq!(parsed.token_b_mint, token_b_mint);
        assert_eq!(parsed.token_a_vault, token_a_vault);
        assert_eq!(parsed.token_b_vault, token_b_vault);
        assert_eq!(parsed.activation_point, 123);
        assert_eq!(parsed.activation_type, 1);
        assert_eq!(parsed.pool_status, 0);
        assert_eq!(parsed.pool_type, 1);

        data[0] ^= 1;
        assert!(parse_meteora_damm_v2_pool(&data).is_err());
        assert!(parse_meteora_damm_v2_pool(&data[..data.len() - 1]).is_err());
        assert!(is_supported_meteora_program(METEORA_DLMM_PROGRAM));
        assert!(is_supported_meteora_program(METEORA_DAMM_V2_PROGRAM));
        assert!(!is_supported_meteora_program(Pubkey::new_unique()));
    }

    #[test]
    fn funded_operational_roles_remain_pairwise_distinct() {
        let randomness = Pubkey::new_unique();
        let buyback = Pubkey::new_unique();
        let admin = Pubkey::new_unique();
        assert!(assert_operational_roles_distinct(randomness, buyback, admin).is_ok());
        assert!(assert_operational_roles_distinct(randomness, randomness, admin).is_err());
        assert!(assert_operational_roles_distinct(randomness, buyback, randomness).is_err());
        assert!(assert_operational_roles_distinct(randomness, buyback, buyback).is_err());
    }

    #[test]
    fn betting_accepts_only_a_bound_but_uncommitted_randomness_request() {
        let mut randomness = SwitchboardRandomness {
            authority: Pubkey::new_unique(),
            seed_slot: 0,
            reveal_slot: 0,
            value: [0; 32],
        };
        assert!(switchboard_randomness_is_uncommitted(&randomness));
        randomness.seed_slot = 41;
        assert!(!switchboard_randomness_is_uncommitted(&randomness));
        randomness.seed_slot = 0;
        randomness.reveal_slot = 42;
        assert!(!switchboard_randomness_is_uncommitted(&randomness));
        randomness.reveal_slot = 0;
        randomness.value[0] = 1;
        assert!(!switchboard_randomness_is_uncommitted(&randomness));
    }

    #[test]
    fn post_betting_commit_must_be_from_the_immediately_previous_slot() {
        assert!(is_fresh_switchboard_commit(41, 42));
        assert!(!is_fresh_switchboard_commit(0, 1));
        assert!(!is_fresh_switchboard_commit(40, 42));
        assert!(!is_fresh_switchboard_commit(42, 42));
        assert!(!is_fresh_switchboard_commit(u64::MAX, 0));
    }

    #[test]
    fn passive_claim_fee_compounds_all_existing_unclaimed_holders() {
        // Two holders own 100 shares / 100 MYNE each. An 18 MYNE passive fee
        // increases assets without shares, so both are worth exactly 109.
        let total_assets = 218;
        let total_shares = 200 * MINING_SHARE_SCALE;
        let holder_shares = 100 * MINING_SHARE_SCALE;
        let first = mining_share_value(total_assets, total_shares, holder_shares).unwrap();
        assert_eq!(first, 109);

        // After the first holder exits, the final holder receives the exact
        // remainder. No phantom liability or stranded passive fee remains.
        let remaining_assets = total_assets - first;
        let remaining_shares = total_shares - holder_shares;
        let second = mining_share_value(remaining_assets, remaining_shares, holder_shares).unwrap();
        assert_eq!(second, 109);
        assert_eq!(first + second, total_assets);
    }

    #[test]
    fn claim_fee_only_increases_remaining_unclaimed_shares() {
        // The claimant's 100 shares and 100 assets have already been removed.
        // Only the other miner remains eligible when the claimant's 9 MYNE
        // passive fee is applied.
        let mut pool = MiningPool {
            bump: 1,
            total_unclaimed: 100,
            reward_per_unclaimed: 100 * MINING_SHARE_SCALE,
            undistributed_base_units: 0,
        };
        let remaining_shares = pool.reward_per_unclaimed;
        distribute_mining_rewards(&mut pool, 9).unwrap();
        assert_eq!(pool.reward_per_unclaimed, remaining_shares);
        assert_eq!(pool.total_unclaimed, 109);
        assert_eq!(
            mining_share_value(
                pool.total_unclaimed,
                pool.reward_per_unclaimed,
                remaining_shares,
            )
            .unwrap(),
            109,
        );
        assert_eq!(
            mining_share_value(pool.total_unclaimed, pool.reward_per_unclaimed, 0,).unwrap(),
            0,
            "the wallet that already claimed owns no shares in its own fee",
        );
    }

    #[test]
    fn later_reward_credit_preserves_the_holders_passive_component() {
        // One holder has a 100 MYNE reward basis and owns every share. Another
        // miner's claim adds 9 passive MYNE, taking its share value to 109.
        let assets_before_credit = 109u64;
        let shares_before_credit = 100 * MINING_SHARE_SCALE;
        let holder_shares_before = shares_before_credit;
        let value_before = mining_share_value(
            assets_before_credit,
            shares_before_credit,
            holder_shares_before,
        )
        .unwrap();
        assert_eq!(value_before, 109);

        // Earning another 10 MYNE must increase the basis by 10 without
        // reclassifying the existing 9 passive MYNE as mined rewards.
        let issued =
            mining_shares_for_credit(assets_before_credit, shares_before_credit, 10).unwrap();
        let assets_after_credit = assets_before_credit + 10;
        let shares_after_credit = shares_before_credit + issued;
        let holder_shares_after = holder_shares_before + issued;
        let value_after = mining_share_value(
            assets_after_credit,
            shares_after_credit,
            holder_shares_after,
        )
        .unwrap();
        let basis_after = mining_basis_after_credit(100, value_before, value_after).unwrap();
        assert_eq!(value_after, 119);
        assert_eq!(basis_after, 110);
        assert_eq!(value_after - basis_after, 9);
    }

    #[test]
    fn later_mining_rewards_do_not_capture_earlier_passive_fees() {
        // Existing holders: 200 assets / 200 shares, then 28 passive MYNE.
        let mut assets = 228u64;
        let holder_shares = 100 * MINING_SHARE_SCALE;
        let mut shares = 2 * holder_shares;
        let newcomer_shares = mining_shares_for_credit(assets, shares, 100).unwrap();
        assert_eq!(newcomer_shares, 87_719_298_245_614_035_087);
        assets += 100;
        shares += newcomer_shares;

        // Sequential full exits conserve all 328 base units. Rounding remains
        // in the pool and is paid to the final holder rather than stranded.
        let first = mining_share_value(assets, shares, holder_shares).unwrap();
        assets -= first;
        shares -= holder_shares;
        let second = mining_share_value(assets, shares, holder_shares).unwrap();
        assets -= second;
        shares -= holder_shares;
        let newcomer = mining_share_value(assets, shares, newcomer_shares).unwrap();
        assert_eq!(first + second + newcomer, 328);
        assert_eq!(newcomer, 100);
    }

    #[test]
    fn passive_fee_precedes_the_new_referral_credit() {
        // The remaining pre-existing holders own 100 assets/shares. A large
        // claim routes 900 passive units and 100 referral units. Applying the
        // passive fee first gives every one of those 900 units exclusively to
        // the pre-claim share set; the newly-created referral credit remains
        // worth exactly 100.
        let existing_shares = 100 * MINING_SHARE_SCALE;
        let assets_after_passive = 100 + 900;
        let referral_shares =
            mining_shares_for_credit(assets_after_passive, existing_shares, 100).unwrap();
        let final_assets = assets_after_passive + 100;
        let final_shares = existing_shares + referral_shares;
        assert_eq!(
            mining_share_value(final_assets, final_shares, existing_shares).unwrap(),
            1_000
        );
        assert_eq!(
            mining_share_value(final_assets, final_shares, referral_shares).unwrap(),
            100
        );
    }

    #[test]
    fn tiny_credits_preserve_share_and_asset_invariants() {
        // One base unit initially owns 1e18 shares, then receives nearly the
        // entire hard-cap amount as passive fees. A later one-unit mining
        // credit still receives an exact, redeemable 500 shares; no `max(1)`
        // dilution shortcut is used.
        let assets = max_supply_base_units().unwrap();
        let issued = mining_shares_for_credit(assets, MINING_SHARE_SCALE, 1).unwrap();
        assert_eq!(issued, 500);
        assert_eq!(
            mining_share_value(assets + 1, MINING_SHARE_SCALE + issued, issued).unwrap(),
            1
        );
    }

    #[test]
    fn wide_mul_div_matches_native_math_when_native_product_fits() {
        for (value, numerator, denominator) in [
            (0, 7, 3),
            (1, 7, 3),
            (100, 200 * MINING_SHARE_SCALE, 228),
            (u64::MAX, 9, 10),
        ] {
            let expected = (value as u128) * numerator / denominator;
            assert_eq!(
                mul_div_u64_u128(value, numerator, denominator).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn no_holder_passive_fee_is_never_assigned_to_a_future_miner() {
        let mut pool = MiningPool {
            bump: 1,
            total_unclaimed: 0,
            reward_per_unclaimed: 0,
            undistributed_base_units: 0,
        };
        distribute_mining_rewards(&mut pool, 9).unwrap();
        assert_eq!(pool.total_unclaimed, 0);
        assert_eq!(pool.reward_per_unclaimed, 0);
        assert_eq!(pool.undistributed_base_units, 9);

        // A later miner's first credit starts 1:1 at the scaled share price;
        // the tracked nine unissued units never enter assets or share value.
        let future_assets = 100u64;
        let future_shares = mining_shares_for_credit(0, 0, future_assets).unwrap();
        assert_eq!(future_shares, future_assets as u128 * MINING_SHARE_SCALE);
        assert_eq!(
            mining_share_value(future_assets, future_shares, future_shares).unwrap(),
            future_assets
        );
        assert_eq!(pool.undistributed_base_units, 9);
    }

    #[test]
    fn staking_pool_carries_whole_lamport_division_remainders() {
        let (first_increment, first_remainder) =
            stake_reward_increment_and_remainder(1, 3).unwrap();
        assert_eq!(first_increment, REWARD_SCALE / 3);
        assert_eq!(first_remainder, 1);

        let (second_increment, second_remainder) =
            stake_reward_increment_and_remainder(1 + first_remainder, 3).unwrap();
        let second_allocated = ((second_increment * 3) / REWARD_SCALE) as u64;
        assert_eq!(second_allocated, 1);
        assert_eq!(second_remainder, 1);

        let (third_increment, third_remainder) =
            stake_reward_increment_and_remainder(2 + second_remainder, 3).unwrap();
        let third_allocated = ((third_increment * 3) / REWARD_SCALE) as u64;
        assert_eq!(third_allocated, 3);
        assert_eq!(third_remainder, 0);
        assert_eq!(second_allocated + third_allocated, 4);
    }

    #[test]
    fn repeated_staking_checkpoints_never_overpay_multiple_stakers() {
        let weights = [1u64, 2u64];
        let mut index = 0u128;
        let mut debts = [0u128; 2];
        let mut pending = [0u64; 2];
        let mut remainder = 0u64;
        let funding = [1u64, 1, 2, 7, 19];

        for amount in funding {
            let total = amount + remainder;
            let (increment, next_remainder) =
                stake_reward_increment_and_remainder(total, 3).unwrap();
            index += increment;
            remainder = next_remainder;
            // Adversarially checkpoint both positions after every funding.
            for position in 0..weights.len() {
                let accrued =
                    (weights[position] as u128) * (index - debts[position]) / REWARD_SCALE;
                pending[position] += accrued as u64;
                debts[position] = index;
            }
        }

        let funded = funding.into_iter().sum::<u64>();
        let payable = pending.into_iter().sum::<u64>();
        assert!(payable + remainder <= funded);
        // With two positions, each checkpoint can discard less than one
        // lamport of position-level precision; it can never create value.
        assert!(funded - payable - remainder < 2 * 5);
    }

    #[test]
    fn terminal_rounds_continue_only_to_empty_a_funded_motherlode() {
        let maximum = max_supply_base_units().unwrap();
        assert!(round_can_open_after_emission(maximum - 1, 0, 0).unwrap());
        assert!(!round_can_open_after_emission(maximum, 0, 0).unwrap());
        assert!(round_can_open_after_emission(maximum, 1, 0).unwrap());
        assert!(round_can_open_after_emission(maximum, 0, 1).unwrap());
        assert!(round_can_open_after_emission(maximum + 1, 1, 1).is_err());
    }

    #[cfg(not(feature = "production"))]
    #[test]
    fn devnet_provider_does_not_require_a_pool() {
        assert!(!liquidity_gate_required(SWITCHBOARD_DEVNET_PROGRAM));
        assert!(assert_randomness_program_allowed_for_build(Pubkey::default()).is_ok());
        assert!(assert_randomness_program_allowed_for_build(SWITCHBOARD_DEVNET_PROGRAM).is_ok());
    }

    #[test]
    fn mainnet_provider_remains_pool_gated() {
        assert!(liquidity_gate_required(SWITCHBOARD_MAINNET_PROGRAM));
        assert!(assert_randomness_program_allowed_for_build(SWITCHBOARD_MAINNET_PROGRAM).is_ok());
        assert!(liquidity_gate_required(SERVER_RANDOMNESS_PROGRAM));
        assert!(assert_randomness_program_allowed_for_build(SERVER_RANDOMNESS_PROGRAM).is_ok());
        assert!(assert_randomness_program_allowed_for_build(Pubkey::new_unique()).is_err());
    }

    #[cfg(feature = "production")]
    #[test]
    fn production_artifact_rejects_every_non_mainnet_randomness_mode() {
        assert!(liquidity_gate_required(Pubkey::default()));
        assert!(liquidity_gate_required(SWITCHBOARD_DEVNET_PROGRAM));
        assert!(assert_randomness_program_allowed_for_build(Pubkey::default()).is_err());
        assert!(assert_randomness_program_allowed_for_build(SWITCHBOARD_DEVNET_PROGRAM).is_err());
    }

    #[test]
    fn server_mode_tag_cannot_be_confused_with_legacy_switchboard_slots() {
        let encoded = encode_server_randomness_slot(42).unwrap();
        assert!(server_randomness_slot_is_encoded(encoded));
        assert_eq!(decode_server_randomness_slot(encoded).unwrap(), 42);
        assert!(!server_randomness_slot_is_encoded(42));
        assert!(decode_server_randomness_slot(42).is_err());
        assert!(decode_server_randomness_slot(SERVER_RANDOMNESS_PENDING).is_err());
        assert!(encode_server_randomness_slot(0).is_err());
        assert!(encode_server_randomness_slot(SERVER_RANDOMNESS_SLOT_MASK).is_err());
    }

    #[test]
    fn server_entropy_targets_the_next_slot_for_the_five_second_result_phase() {
        // The lock instruction is accepted only after betting closes. A
        // one-slot delay therefore remains future/unavailable at lock time,
        // while avoiding the old sixteen-slot delay that outlived the entire
        // five-second result phase.
        assert_eq!(SERVER_ENTROPY_DELAY_SLOTS, 1);
    }

    #[test]
    fn server_commitment_and_output_are_domain_separated_and_deterministic() {
        let mint = Pubkey::new_unique();
        let reveal = [7u8; 32];
        let commitment = server_randomness_commitment(mint, 41, &reveal);
        assert_eq!(commitment, server_randomness_commitment(mint, 41, &reveal));
        assert_ne!(commitment, server_randomness_commitment(mint, 42, &reveal));
        assert_ne!(commitment, server_randomness_commitment(mint, 41, &[8; 32]));

        let slot_hash = [9u8; 32];
        let output = server_randomness_output(mint, 41, &reveal, 100, &slot_hash);
        assert_eq!(
            output,
            server_randomness_output(mint, 41, &reveal, 100, &slot_hash)
        );
        assert_ne!(commitment, output);
        assert_ne!(
            output,
            server_randomness_output(mint, 41, &reveal, 101, &slot_hash)
        );
        assert_ne!(
            output,
            server_randomness_output(mint, 41, &reveal, 100, &[10; 32])
        );
    }

    #[test]
    fn slot_hash_selection_uses_first_produced_slot_at_or_after_target() {
        let mut data = Vec::new();
        data.extend_from_slice(&3u64.to_le_bytes());
        for (slot, byte) in [(105u64, 5u8), (103, 3), (100, 1)] {
            data.extend_from_slice(&slot.to_le_bytes());
            data.extend_from_slice(&[byte; 32]);
        }
        assert_eq!(
            select_slot_hash_at_or_after(&data, 101).unwrap(),
            (103, [3; 32])
        );
        assert_eq!(
            select_slot_hash_at_or_after(&data, 105).unwrap(),
            (105, [5; 32])
        );
        assert!(select_slot_hash_at_or_after(&data, 99).is_err());
        assert!(select_slot_hash_at_or_after(&data, 106).is_err());
    }

    #[test]
    fn slot_hash_parser_rejects_malformed_or_oversized_data() {
        assert!(select_slot_hash_at_or_after(&[], 1).is_err());
        let mut truncated = Vec::new();
        truncated.extend_from_slice(&1u64.to_le_bytes());
        truncated.extend_from_slice(&1u64.to_le_bytes());
        assert!(select_slot_hash_at_or_after(&truncated, 1).is_err());
        let oversized = 513u64.to_le_bytes();
        assert!(select_slot_hash_at_or_after(&oversized, 1).is_err());
    }

    #[test]
    fn motherlode_is_one_in_650_per_round() {
        assert!(motherlode_hit(0));
        assert!(motherlode_hit(MOTHERLODE_ODDS));
        assert!(!motherlode_hit(1));
        assert!(!motherlode_hit(MOTHERLODE_ODDS - 1));
    }

    #[test]
    fn motherlode_hit_pays_any_nonempty_round_even_when_the_normal_tile_is_empty() {
        assert!(motherlode_pays_round(true, 1));
        assert!(motherlode_pays_round(true, 2_000_000_000));
        assert!(!motherlode_pays_round(false, 2_000_000_000));
        assert!(!motherlode_pays_round(true, 0));
    }

    #[test]
    fn empty_scheduled_round_issues_exactly_zero_myne() {
        let remaining = BASE_ROUND_EMISSION + super::MOTHERLODE_ROUND_EMISSION;
        assert_eq!(round_emissions(remaining, 0, 0).unwrap(), (0, 0));
        assert_eq!(round_emissions(remaining, 0, 1).unwrap(), (0, 0));
    }

    #[test]
    fn played_round_preserves_motherlode_and_winning_tile_emissions() {
        let remaining = BASE_ROUND_EMISSION + super::MOTHERLODE_ROUND_EMISSION;
        assert_eq!(
            round_emissions(remaining, 1, 1).unwrap(),
            (super::MOTHERLODE_ROUND_EMISSION, BASE_ROUND_EMISSION)
        );
        assert_eq!(
            round_emissions(remaining, 1, 0).unwrap(),
            (super::MOTHERLODE_ROUND_EMISSION, 0)
        );
    }

    #[test]
    fn motherlode_shares_sol_and_myne_by_total_deployment() {
        let sol = proportional_interval_share(13_000, 0, 25, 100).unwrap();
        let myne = proportional_interval_share(200, 0, 25, 100).unwrap();
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
    fn five_miners_two_winners_split_the_entire_post_fee_prize_exactly() {
        // Five miners deploy 2 SOL. Two miners are on the winning tile with
        // 90% and 10% of that tile respectively; the other three lose. The
        // two winners split all 1.76 SOL remaining after the 12% round fee.
        let gross: u64 = 2_000_000_000;
        let fee = checked_bps(gross, MINING_PROTOCOL_FEE_BPS).unwrap();
        let prize = gross.checked_sub(fee).unwrap();
        let winning_total = 100_000_000;
        let first = proportional_interval_share(prize, 0, 90_000_000, winning_total).unwrap();
        let second =
            proportional_interval_share(prize, 90_000_000, 10_000_000, winning_total).unwrap();

        assert_eq!(first, 1_584_000_000);
        assert_eq!(second, 176_000_000);
        assert_eq!(first + second, prize);
    }

    #[test]
    fn five_equal_winning_tile_contributions_receive_equal_sol_rewards() {
        // This is the user-visible fairness invariant: tile count, losing-tile
        // deployment and wallet identity cannot affect a winning receipt's share.
        let prize: u64 = 1_100_000_000;
        let stake: u64 = 15_000_000;
        let winning_total = stake.checked_mul(5).unwrap();
        let rewards = (0..5)
            .map(|index| {
                proportional_interval_share(
                    prize,
                    stake.checked_mul(index).unwrap(),
                    stake,
                    winning_total,
                )
                .unwrap()
            })
            .collect::<Vec<_>>();

        assert_eq!(rewards, vec![220_000_000; 5]);
        assert_eq!(rewards.iter().sum::<u64>(), prize);
    }

    #[test]
    fn cumulative_allocation_distributes_every_integer_unit() {
        let first = proportional_interval_share(11, 0, 1, 3).unwrap();
        let second = proportional_interval_share(11, 1, 1, 3).unwrap();
        let third = proportional_interval_share(11, 2, 1, 3).unwrap();
        assert_eq!((first, second, third), (3, 4, 4));
        assert_eq!(first + second + third, 11);
    }

    #[test]
    fn empty_motherlode_share_is_zero_and_burn_weight_is_five_x() {
        assert_eq!(proportional_interval_share(13_000, 0, 0, 100).unwrap(), 0);
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
    admin_fee_wallet: &AccountInfo<'_>,
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

    let fees = mining_fee_allocation(round.gross_deployed_lamports)?;
    round.prize_lamports = round
        .gross_deployed_lamports
        .checked_sub(fees.total)
        .ok_or(MyneError::ArithmeticOverflow)?;
    move_lamports(
        &round.to_account_info(),
        &stake_pool.to_account_info(),
        fees.staking_net,
    )?;
    fund_stake_rewards(stake_pool, fees.staking_net)?;
    move_lamports(&round.to_account_info(), buyback_wallet, fees.buyback)?;
    move_lamports(&round.to_account_info(), admin_fee_wallet, fees.admin_total)?;
    // Devnet intentionally exercises the protocol without a liquidity
    // pool. Mainnet remains blocked until the buyback signer confirms the
    // actual swap and burn for this allocation.
    round.buyback_completed =
        fees.buyback == 0 || !liquidity_gate_required(config.randomness_program);
    emit!(BuybackAllocation {
        round_id: round.id,
        wallet: *buyback_wallet.key,
        lamports: fees.buyback,
    });
    emit!(RoundFeesDistributed {
        round_id: round.id,
        gross_deployed_lamports: round.gross_deployed_lamports,
        total_fee_lamports: fees.total,
        staking_gross_lamports: fees.staking_gross,
        staking_admin_lamports: fees.staking_admin,
        staking_net_lamports: fees.staking_net,
        buyback_lamports: fees.buyback,
        motherlode_lamports: fees.motherlode,
        mining_admin_lamports: fees.mining_admin,
        admin_total_lamports: fees.admin_total,
        admin_fee_wallet: *admin_fee_wallet.key,
    });
    move_lamports(
        &round.to_account_info(),
        &config.to_account_info(),
        fees.motherlode,
    )?;
    config.motherlode_lamports = checked_add(config.motherlode_lamports, fees.motherlode)?;
    let remaining_emission = max_supply_base_units()?
        .checked_sub(config.total_emitted_base_units)
        .ok_or(MyneError::ArithmeticOverflow)?;
    let (motherlode_emission, base_emission) = round_emissions(
        remaining_emission,
        round.gross_deployed_lamports,
        winning_total,
    )?;
    round.base_emission = base_emission;
    config.motherlode_base_units = checked_add(config.motherlode_base_units, motherlode_emission)?;
    config.total_emitted_base_units = checked_add(
        config.total_emitted_base_units,
        checked_add(motherlode_emission, round.base_emission)?,
    )?;
    if winning_total == 0 {
        let rollover = round.prize_lamports;
        move_lamports(
            &round.to_account_info(),
            &config.to_account_info(),
            rollover,
        )?;
        config.motherlode_lamports = checked_add(config.motherlode_lamports, rollover)?;
        round.prize_lamports = 0;
    }
    // Motherlode is a round-wide award. It remains payable when the randomly
    // selected normal tile is empty, provided the round has actual miners.
    if motherlode_pays_round(round.motherlode_hit, round.gross_deployed_lamports) {
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
        gross_deployed_lamports: round.gross_deployed_lamports,
        prize_lamports: round.prize_lamports,
        motherlode_payout_lamports: round.motherlode_payout_lamports,
        base_emission: round.base_emission,
        motherlode_emission: round.motherlode_emission,
        total_receipts: round.total_receipts,
        solo_sample: round.solo_sample,
        randomness_account: round.randomness_account,
        randomness_commit_slot: round.randomness_commit_slot,
        randomness: round.randomness,
    });
    Ok(())
}

/// Mainnet settlement is pool-gated. Devnet deliberately runs without a
/// Meteora dependency so the full mining/staking flow can be exercised before
/// production liquidity exists. Unknown providers fail closed and remain
/// pool-gated.
fn liquidity_gate_required(randomness_program: Pubkey) -> bool {
    #[cfg(feature = "production")]
    {
        let _ = randomness_program;
        true
    }
    #[cfg(not(feature = "production"))]
    {
        randomness_program != SWITCHBOARD_DEVNET_PROGRAM && randomness_program != Pubkey::default()
    }
}

struct SwitchboardRandomness {
    authority: Pubkey,
    seed_slot: u64,
    reveal_slot: u64,
    value: [u8; 32],
}

fn assert_bound_randomness_accepting_bets(
    config: &ProtocolConfig,
    round: &Round,
    randomness_account: Option<&UncheckedAccount<'_>>,
) -> Result<()> {
    if round.randomness_commit_slot == SERVER_RANDOMNESS_PENDING {
        require!(
            round.randomness_account != Pubkey::default(),
            MyneError::RandomnessNotBound
        );
        require!(
            randomness_account.is_none(),
            MyneError::InvalidRandomnessAccount
        );
        return Ok(());
    }
    require!(
        !server_randomness_slot_is_encoded(round.randomness_commit_slot),
        MyneError::RandomnessAlreadyCommitted
    );
    if config.randomness_program == Pubkey::default() {
        require!(
            round.randomness_account == Pubkey::default()
                && round.randomness_commit_slot == 0
                && randomness_account.is_none(),
            MyneError::InvalidRandomnessAccount
        );
        return Ok(());
    }
    let randomness_account = randomness_account.ok_or(MyneError::RandomnessNotBound)?;
    require_keys_eq!(
        randomness_account.key(),
        round.randomness_account,
        MyneError::InvalidRandomnessAccount
    );
    let parsed = parse_bound_switchboard_randomness(&randomness_account.to_account_info())?;
    require_keys_eq!(
        parsed.authority,
        config.randomness_authority,
        MyneError::InvalidRandomnessAuthority
    );
    require!(
        round.randomness_commit_slot == 0 && switchboard_randomness_is_uncommitted(&parsed),
        MyneError::RandomnessAlreadyCommitted
    );
    Ok(())
}

fn server_randomness_slot_is_encoded(slot: u64) -> bool {
    slot & SERVER_RANDOMNESS_SLOT_FLAG != 0
}

fn encode_server_randomness_slot(slot: u64) -> Result<u64> {
    require!(
        slot > 0 && slot < SERVER_RANDOMNESS_SLOT_MASK,
        MyneError::ArithmeticOverflow
    );
    Ok(SERVER_RANDOMNESS_SLOT_FLAG | slot)
}

fn decode_server_randomness_slot(encoded: u64) -> Result<u64> {
    require!(
        encoded != SERVER_RANDOMNESS_PENDING && server_randomness_slot_is_encoded(encoded),
        MyneError::ServerEntropyNotLocked
    );
    let slot = encoded & SERVER_RANDOMNESS_SLOT_MASK;
    require!(slot > 0, MyneError::ServerEntropyNotLocked);
    Ok(slot)
}

fn server_randomness_commitment(mint: Pubkey, round_id: u64, reveal: &[u8; 32]) -> [u8; 32] {
    hashv(&[
        SERVER_COMMIT_DOMAIN,
        crate::ID.as_ref(),
        mint.as_ref(),
        &round_id.to_le_bytes(),
        reveal,
    ])
    .to_bytes()
}

fn server_randomness_output(
    mint: Pubkey,
    round_id: u64,
    reveal: &[u8; 32],
    entropy_slot: u64,
    slot_hash: &[u8; 32],
) -> [u8; 32] {
    hashv(&[
        SERVER_OUTPUT_DOMAIN,
        crate::ID.as_ref(),
        mint.as_ref(),
        &round_id.to_le_bytes(),
        reveal,
        &entropy_slot.to_le_bytes(),
        slot_hash,
    ])
    .to_bytes()
}

/// Decode the compact bincode layout of the SlotHashes sysvar without heap
/// allocation. Entries are newest-first on chain; choosing the numerically
/// smallest produced slot at or after the target makes skipped slots
/// deterministic and independent of when settlement is submitted.
fn select_slot_hash_at_or_after(data: &[u8], target_slot: u64) -> Result<(u64, [u8; 32])> {
    require!(
        data.len() >= SLOT_HASHES_HEADER_SIZE,
        MyneError::InvalidSlotHashesSysvar
    );
    let count = u64::from_le_bytes(
        data[..SLOT_HASHES_HEADER_SIZE]
            .try_into()
            .map_err(|_| error!(MyneError::InvalidSlotHashesSysvar))?,
    );
    let count = usize::try_from(count).map_err(|_| error!(MyneError::InvalidSlotHashesSysvar))?;
    require!(
        count <= SLOT_HASHES_MAX_ENTRIES,
        MyneError::InvalidSlotHashesSysvar
    );
    let required_len = SLOT_HASHES_HEADER_SIZE
        .checked_add(
            count
                .checked_mul(SLOT_HASHES_ENTRY_SIZE)
                .ok_or(MyneError::ArithmeticOverflow)?,
        )
        .ok_or(MyneError::ArithmeticOverflow)?;
    require!(
        data.len() >= required_len,
        MyneError::InvalidSlotHashesSysvar
    );

    let mut selected: Option<(u64, [u8; 32])> = None;
    let mut oldest_slot: Option<u64> = None;
    for index in 0..count {
        let offset = SLOT_HASHES_HEADER_SIZE
            .checked_add(
                index
                    .checked_mul(SLOT_HASHES_ENTRY_SIZE)
                    .ok_or(MyneError::ArithmeticOverflow)?,
            )
            .ok_or(MyneError::ArithmeticOverflow)?;
        let slot_end = offset.checked_add(8).ok_or(MyneError::ArithmeticOverflow)?;
        let hash_end = slot_end
            .checked_add(32)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let slot = u64::from_le_bytes(
            data[offset..slot_end]
                .try_into()
                .map_err(|_| error!(MyneError::InvalidSlotHashesSysvar))?,
        );
        oldest_slot = Some(oldest_slot.map_or(slot, |oldest| oldest.min(slot)));
        if slot < target_slot || selected.is_some_and(|(selected_slot, _)| slot >= selected_slot) {
            continue;
        }
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&data[slot_end..hash_end]);
        selected = Some((slot, hash));
    }
    // If the target predates the oldest retained entry, the program can no
    // longer distinguish an aged-out produced slot from a skipped slot. Fail
    // closed instead of silently substituting newer, chooser-influenced
    // entropy; the normal round refund path remains available.
    let oldest_slot = oldest_slot.ok_or_else(|| error!(MyneError::ServerEntropyUnavailable))?;
    require!(
        target_slot >= oldest_slot,
        MyneError::ServerEntropyUnavailable
    );
    selected.ok_or_else(|| error!(MyneError::ServerEntropyUnavailable))
}

fn switchboard_randomness_is_uncommitted(randomness: &SwitchboardRandomness) -> bool {
    randomness.seed_slot == 0 && randomness.reveal_slot == 0 && randomness.value == [0; 32]
}

/// Switchboard's commit instruction records the immediately preceding slot.
/// Requiring the application callback in the same transaction prevents a
/// keeper from presenting a stale commitment selected after betting closed.
fn is_fresh_switchboard_commit(seed_slot: u64, current_slot: u64) -> bool {
    seed_slot > 0 && current_slot.checked_sub(1) == Some(seed_slot)
}

/// Parse a Switchboard account according to its own pinned owner rather than
/// the provider selected for future rounds. This is intentionally used only
/// after a round has already bound the account, preserving old commitments
/// across a paused provider migration.
fn parse_bound_switchboard_randomness(account: &AccountInfo<'_>) -> Result<SwitchboardRandomness> {
    #[cfg(feature = "production")]
    {
        parse_switchboard_randomness(account, &SWITCHBOARD_MAINNET_PROGRAM)
    }
    #[cfg(not(feature = "production"))]
    {
        require!(
            is_switchboard_program(*account.owner),
            MyneError::InvalidRandomnessAccount
        );
        parse_switchboard_randomness(account, account.owner)
    }
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
        data.len() >= SWITCHBOARD_RANDOMNESS_ACCOUNT_PREFIX_SIZE,
        MyneError::InvalidRandomnessAccount
    );
    require!(
        data[..8] == SWITCHBOARD_RANDOMNESS_DISCRIMINATOR,
        MyneError::InvalidRandomnessAccount
    );
    let authority =
        Pubkey::try_from(&data[8..40]).map_err(|_| error!(MyneError::InvalidRandomnessAccount))?;
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
        authority,
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

fn assert_auto_plan_reward_mode(reward_mode: u8) -> Result<()> {
    require!(
        reward_mode & !AUTO_PLAN_ALLOWED_MODE_MASK == 0,
        MyneError::InvalidRewardMode
    );
    Ok(())
}

fn auto_plan_receipt_reward_mode(reward_mode: u8) -> Result<u8> {
    assert_auto_plan_reward_mode(reward_mode)?;
    Ok(reward_mode & AUTO_REWARD_BURN)
}

fn auto_plan_reinvests_sol(reward_mode: u8) -> bool {
    reward_mode & AUTO_PLAN_REINVEST_SOL != 0
}

/// Moves a settled receipt's SOL reward out of the temporary Round PDA and
/// records it in the owner's durable claim balance. The StakePool is already
/// the canonical SOL claim vault for every registered miner, so this preserves
/// the deployed account layout and lets the lifecycle keeper close receipts
/// and rounds without paying a wallet behind its owner's back.
///
/// This deliberately does not call `fund_stake_rewards`: receipt SOL belongs
/// only to this receipt owner and must never enter the pro-rata staking index.
fn accrue_receipt_sol(
    round: &mut Account<Round>,
    stake_pool: &mut Account<StakePool>,
    stake_position: &mut Account<StakePosition>,
    miner: &mut Account<Miner>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let next_pending = checked_add(stake_position.pending_sol, amount)?;
    let next_funded = checked_add(stake_pool.total_funded_lamports, amount)?;
    let next_round_claimed = checked_add(round.claimed_lamports, amount)?;
    let next_lifetime_earned = checked_add(miner.lifetime_sol_claimed, amount)?;

    move_lamports(
        &round.to_account_info(),
        &stake_pool.to_account_info(),
        amount,
    )?;
    stake_position.pending_sol = next_pending;
    stake_pool.total_funded_lamports = next_funded;
    round.claimed_lamports = next_round_claimed;
    // The stable-layout field name is historical; after receipt accrual it is
    // the miner's lifetime SOL earned, regardless of withdrawal timing.
    miner.lifetime_sol_claimed = next_lifetime_earned;
    Ok(())
}

/// Value a miner's unclaimed-reward shares against the pool's exact MYNE
/// liability. Removing every share in sequence conserves every base unit: any
/// division remainder remains in the pool and is received by the final holder.
fn mining_share_value(total_assets: u64, total_shares: u128, shares: u128) -> Result<u64> {
    if shares == 0 {
        return Ok(0);
    }
    require!(
        total_assets > 0 && total_shares > 0 && shares <= total_shares,
        MyneError::InvalidMiningPoolAccounting
    );
    let value = mul_div_u64_u128(total_assets, shares, total_shares)?;
    u64::try_from(value).map_err(|_| error!(MyneError::ArithmeticOverflow))
}

/// Issue shares for newly mined/referral MYNE without giving the new reward a
/// claim on passive fees earned before it arrived. Initial credits receive
/// high-precision shares; subsequent credits use an exact overflow-safe floor.
fn mining_shares_for_credit(total_assets: u64, total_shares: u128, amount: u64) -> Result<u128> {
    if amount == 0 {
        return Ok(0);
    }
    if total_assets == 0 || total_shares == 0 {
        require!(
            total_assets == 0 && total_shares == 0,
            MyneError::InvalidMiningPoolAccounting
        );
        return (amount as u128)
            .checked_mul(MINING_SHARE_SCALE)
            .ok_or_else(|| error!(MyneError::ArithmeticOverflow));
    }
    let shares = mul_div_u64_u128(amount, total_shares, total_assets as u128)?;
    require!(shares > 0, MyneError::MiningRewardBelowSharePrecision);
    Ok(shares)
}

/// Exact floor(value * numerator / denominator) where `value` is u64 and the
/// ratio is u128. Processing the u64 multiplier one bit at a time never forms
/// the potentially overflowing 192-bit product. Invariants per iteration:
/// `prefix * numerator = quotient * denominator + remainder` and
/// `remainder < denominator`.
fn mul_div_u64_u128(value: u64, numerator: u128, denominator: u128) -> Result<u128> {
    require!(denominator > 0, MyneError::ArithmeticOverflow);
    let mut quotient = 0u128;
    let mut remainder = 0u128;
    for bit in (0..64).rev() {
        quotient = quotient
            .checked_mul(2)
            .ok_or(MyneError::ArithmeticOverflow)?;
        let mut step = remainder
            .checked_mul(2)
            .ok_or(MyneError::ArithmeticOverflow)?;
        if ((value >> bit) & 1) == 1 {
            step = step
                .checked_add(numerator)
                .ok_or(MyneError::ArithmeticOverflow)?;
        }
        quotient = quotient
            .checked_add(step / denominator)
            .ok_or(MyneError::ArithmeticOverflow)?;
        remainder = step % denominator;
    }
    Ok(quotient)
}

fn validate_miner_shares(miner: &mut Account<Miner>, pool: &MiningPool) -> Result<u64> {
    // An empty v6 pool is the only safe signal for clearing stale v5
    // additive-index debt. The non-passive basis cannot be used for this test:
    // a valid miner can have no principal while its outstanding shares retain
    // a passive/referral value.
    if pool.reward_per_unclaimed == 0 {
        require!(
            pool.total_unclaimed == 0,
            MyneError::InvalidMiningPoolAccounting
        );
        miner.unclaimed_myne = 0;
        miner.passive_reward_debt = 0;
        return Ok(0);
    }
    require!(
        pool.total_unclaimed > 0,
        MyneError::InvalidMiningPoolAccounting
    );
    if miner.passive_reward_debt == 0 {
        miner.unclaimed_myne = 0;
        return Ok(0);
    }
    mining_share_value(
        pool.total_unclaimed,
        pool.reward_per_unclaimed,
        miner.passive_reward_debt,
    )
}

fn mining_basis_after_credit(
    current_basis: u64,
    value_before: u64,
    value_after: u64,
) -> Result<u64> {
    let credited_basis = value_after
        .checked_sub(value_before)
        .ok_or(MyneError::InvalidMiningPoolAccounting)?;
    checked_add(current_basis, credited_basis)
}

fn credit_mining_rewards(
    miner: &mut Account<Miner>,
    pool: &mut Account<MiningPool>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let value_before = validate_miner_shares(miner, pool)?;
    let shares = mining_shares_for_credit(pool.total_unclaimed, pool.reward_per_unclaimed, amount)?;
    pool.total_unclaimed = checked_add(pool.total_unclaimed, amount)?;
    pool.reward_per_unclaimed = pool
        .reward_per_unclaimed
        .checked_add(shares)
        .ok_or(MyneError::ArithmeticOverflow)?;
    miner.passive_reward_debt = miner
        .passive_reward_debt
        .checked_add(shares)
        .ok_or(MyneError::ArithmeticOverflow)?;
    let value_after = validate_miner_shares(miner, pool)?;
    // Share issuance can floor by at most base-unit precision. Record the
    // exact increase represented by the new shares, rather than the requested
    // amount, so `claimable = basis + passive` remains conservative and exact.
    miner.unclaimed_myne =
        mining_basis_after_credit(miner.unclaimed_myne, value_before, value_after)?;
    Ok(())
}

fn debit_all_mining_rewards(
    miner: &mut Account<Miner>,
    pool: &mut Account<MiningPool>,
) -> Result<u64> {
    let amount = validate_miner_shares(miner, pool)?;
    let shares = miner.passive_reward_debt;
    require!(amount > 0 && shares > 0, MyneError::InsufficientBalance);
    pool.total_unclaimed = pool
        .total_unclaimed
        .checked_sub(amount)
        .ok_or(MyneError::InvalidMiningPoolAccounting)?;
    pool.reward_per_unclaimed = pool
        .reward_per_unclaimed
        .checked_sub(shares)
        .ok_or(MyneError::InvalidMiningPoolAccounting)?;
    miner.unclaimed_myne = 0;
    miner.passive_reward_debt = 0;
    require!(
        (pool.reward_per_unclaimed == 0) == (pool.total_unclaimed == 0),
        MyneError::InvalidMiningPoolAccounting
    );
    Ok(amount)
}

fn distribute_mining_rewards(pool: &mut MiningPool, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if pool.reward_per_unclaimed == 0 {
        require!(
            pool.total_unclaimed == 0,
            MyneError::InvalidMiningPoolAccounting
        );
        // No eligible unclaimed holder exists. The withheld fee remains
        // unissued forever and is tracked explicitly; a future miner must not
        // inherit a fee assessed before their balance existed.
        pool.undistributed_base_units = checked_add(pool.undistributed_base_units, amount)?;
        return Ok(());
    }
    require!(
        pool.total_unclaimed > 0,
        MyneError::InvalidMiningPoolAccounting
    );
    // Passive fees increase asset value without issuing shares. This is the
    // compounding step that the old additive index could not model safely.
    pool.total_unclaimed = checked_add(pool.total_unclaimed, amount)?;
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

fn stake_reward_increment_and_remainder(total: u64, total_weight: u64) -> Result<(u128, u64)> {
    require!(total_weight > 0, MyneError::InvalidStakeAuthority);
    let increment = (total as u128)
        .checked_mul(REWARD_SCALE)
        .ok_or(MyneError::ArithmeticOverflow)?
        .checked_div(total_weight as u128)
        .ok_or(MyneError::ArithmeticOverflow)?;
    let allocated = increment
        .checked_mul(total_weight as u128)
        .ok_or(MyneError::ArithmeticOverflow)?
        .checked_div(REWARD_SCALE)
        .ok_or(MyneError::ArithmeticOverflow)?;
    let allocated = u64::try_from(allocated).map_err(|_| error!(MyneError::ArithmeticOverflow))?;
    let remainder = total
        .checked_sub(allocated)
        .ok_or(MyneError::ArithmeticOverflow)?;
    Ok((increment, remainder))
}

fn fund_stake_rewards(pool: &mut Account<StakePool>, amount: u64) -> Result<()> {
    pool.total_funded_lamports = checked_add(pool.total_funded_lamports, amount)?;
    let total = checked_add(amount, pool.undistributed_lamports)?;
    if pool.total_weight == 0 {
        pool.undistributed_lamports = total;
        return Ok(());
    }
    let (increment, remainder) = stake_reward_increment_and_remainder(total, pool.total_weight)?;
    pool.reward_per_weight = pool
        .reward_per_weight
        .checked_add(increment)
        .ok_or(MyneError::ArithmeticOverflow)?;
    // Carry exact whole-lamport division dust into the next funding event.
    // Individual position checkpoints can still leave <1 lamport of index
    // precision dust, but this prevents whole lamports from disappearing at
    // the pool-allocation boundary.
    pool.undistributed_lamports = remainder;
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
    /// Reserved for account-layout compatibility. Protocol funds are never
    /// transferred to this address.
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
    /// Genesis plus every mining emission ever created, including virtual
    /// burn rewards. Burns never reopen the hard issuance ceiling.
    pub total_emitted_base_units: u64,
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

#[account]
#[derive(InitSpace)]
pub struct PrelaunchMintMigration {
    pub bump: u8,
    pub previous_mint: Pubkey,
    pub new_mint: Pubkey,
    pub migrated_at: i64,
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
pub struct MigrateFeeScheduleV6<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump, has_one=admin)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Account<'info, MiningPool>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MigratePrelaunchMint<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump, has_one=admin)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Account<'info, MiningPool>,
    #[account(seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(
        init,
        payer=admin,
        space=PrelaunchMintMigration::DISCRIMINATOR.len()+PrelaunchMintMigration::INIT_SPACE,
        seeds=[PRELAUNCH_MINT_MIGRATION_SEED],
        bump
    )]
    pub migration: Account<'info, PrelaunchMintMigration>,
    #[account(mut)]
    pub previous_mint: InterfaceAccount<'info, Mint>,
    pub new_mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint=new_mint, token::authority=config.admin_fee_wallet)]
    pub liquidity_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RotateOperationalWallets<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump, has_one=admin, has_one=mint)]
    pub config: Account<'info, ProtocolConfig>,
    /// Existing, system-owned receiver required so settlement cannot route to
    /// an undeployed or program-owned address.
    pub new_buyback_wallet: SystemAccount<'info>,
    /// Existing, system-owned receiver for all direct admin fee flows.
    pub new_admin_fee_wallet: SystemAccount<'info>,
    #[account(
        token::mint=mint,
        token::authority=new_admin_fee_wallet,
    )]
    pub new_admin_fee_tokens: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub admin: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
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
#[instruction(referrer: Pubkey)]
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
    #[account(
        seeds=[MINER_SEED, referrer.as_ref()],
        bump=referrer_miner.bump,
        constraint=referrer_miner.authority == referrer @ MyneError::InvalidReferrer
    )]
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
#[instruction(round_id: u64)]
pub struct BindRoundServerCommitment<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[ROUND_SEED, &round_id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(address=config.randomness_authority @ MyneError::InvalidRandomnessAuthority)]
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct LockRoundServerEntropy<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[ROUND_SEED, &round_id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// Any signer may promptly lock the future slot after betting closes.
    pub executor: Signer<'info>,
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
    /// CHECK: For Switchboard rounds, the handler verifies this is the bound,
    /// provider-owned request and that it has not been revealed. Optional only
    /// for the explicit local legacy mode.
    pub randomness_account: Option<UncheckedAccount<'info>>,
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
pub struct CancelAutoPlan<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        close=authority,
        seeds=[b"auto_plan", authority.key().as_ref()],
        bump=auto_plan.bump,
        has_one=authority
    )]
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
pub struct ReinvestAutoPlanRewards<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds=[b"auto_plan", auto_plan.authority.as_ref()],
        bump=auto_plan.bump
    )]
    pub auto_plan: Account<'info, AutoPlan>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(
        mut,
        seeds=[STAKE_POSITION_SEED, auto_plan.authority.as_ref()],
        bump=stake_position.bump,
        constraint=stake_position.authority == auto_plan.authority @ MyneError::InvalidReceiptAuthority
    )]
    pub stake_position: Account<'info, StakePosition>,
    /// Any signer may relay the owner-authorized reinvestment. No funds can be
    /// directed to this account.
    pub executor: Signer<'info>,
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
    /// CHECK: Same bound-and-unrevealed validation as manual deployment.
    pub randomness_account: Option<UncheckedAccount<'info>>,
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
    /// Direct SOL destination controlled by the buyback keeper.
    #[account(mut, address=config.buyback_wallet @ MyneError::InvalidFeeDestination)]
    pub buyback_wallet: SystemAccount<'info>,
    /// Direct SOL destination for the 1% mining allocation and the 10% share
    /// of gross staking rewards. It never accumulates inside a claim vault.
    #[account(mut, address=config.admin_fee_wallet @ MyneError::InvalidFeeDestination)]
    pub admin_fee_wallet: SystemAccount<'info>,
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
    /// Direct SOL destination controlled by the buyback keeper.
    #[account(mut, address=config.buyback_wallet @ MyneError::InvalidFeeDestination)]
    pub buyback_wallet: SystemAccount<'info>,
    /// Direct SOL destination for every administrator round allocation.
    #[account(mut, address=config.admin_fee_wallet @ MyneError::InvalidFeeDestination)]
    pub admin_fee_wallet: SystemAccount<'info>,
}
#[derive(Accounts)]
pub struct SettleRoundServer<'info> {
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
    /// CHECK: exact sysvar address and serialized bounds are checked in the
    /// handler before any bytes are used as entropy.
    #[account(address=SLOT_HASHES_SYSVAR @ MyneError::InvalidSlotHashesSysvar)]
    pub slot_hashes: UncheckedAccount<'info>,
    /// Direct SOL destination controlled by the buyback keeper.
    #[account(mut, address=config.buyback_wallet @ MyneError::InvalidFeeDestination)]
    pub buyback_wallet: SystemAccount<'info>,
    /// Direct SOL destination for every administrator round allocation.
    #[account(mut, address=config.admin_fee_wallet @ MyneError::InvalidFeeDestination)]
    pub admin_fee_wallet: SystemAccount<'info>,
    /// Any signer may reveal a valid preimage and finish settlement.
    pub executor: Signer<'info>,
}
#[derive(Accounts)]
pub struct ClaimReceipt<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Box<Account<'info, MiningPool>>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Box<Account<'info, StakePool>>,
    #[account(mut, seeds=[MINER_SEED, authority.key().as_ref()], bump=miner.bump, has_one=authority)]
    pub miner: Box<Account<'info, Miner>>,
    #[account(mut, seeds=[STAKE_POSITION_SEED, authority.key().as_ref()], bump=stake_position.bump, has_one=authority)]
    pub stake_position: Box<Account<'info, StakePosition>>,
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds=[BET_SEED, &round.id.to_le_bytes(), authority.key().as_ref(), &receipt.nonce.to_le_bytes()], bump=receipt.bump)]
    pub receipt: Box<Account<'info, BetReceipt>>,
    #[account(mut)]
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct ClaimAutoBurnReceipt<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Box<Account<'info, MiningPool>>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Box<Account<'info, StakePool>>,
    #[account(mut, seeds=[MINER_SEED, receipt.authority.as_ref()], bump=miner.bump, constraint=miner.authority == receipt.authority @ MyneError::InvalidReceiptAuthority)]
    pub miner: Box<Account<'info, Miner>>,
    #[account(mut, seeds=[STAKE_POSITION_SEED, receipt.authority.as_ref()], bump=stake_position.bump, constraint=stake_position.authority == receipt.authority @ MyneError::InvalidReceiptAuthority)]
    pub stake_position: Box<Account<'info, StakePosition>>,
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds=[BET_SEED, &round.id.to_le_bytes(), receipt.authority.as_ref(), &receipt.nonce.to_le_bytes()], bump=receipt.bump)]
    pub receipt: Box<Account<'info, BetReceipt>>,
    /// CHECK: Must be the immutable receipt owner. Retained in the stable
    /// instruction account list; reward SOL accrues to `stake_position`.
    #[account(mut, constraint=beneficiary.key() == receipt.authority @ MyneError::InvalidReceiptAuthority)]
    pub beneficiary: UncheckedAccount<'info>,
    pub executor: Signer<'info>,
}
#[derive(Accounts)]
pub struct SettleReceipt<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Box<Account<'info, MiningPool>>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Box<Account<'info, StakePool>>,
    #[account(mut, seeds=[MINER_SEED, receipt.authority.as_ref()], bump=miner.bump, constraint=miner.authority == receipt.authority @ MyneError::InvalidReceiptAuthority)]
    pub miner: Box<Account<'info, Miner>>,
    #[account(mut, seeds=[STAKE_POSITION_SEED, receipt.authority.as_ref()], bump=stake_position.bump, constraint=stake_position.authority == receipt.authority @ MyneError::InvalidReceiptAuthority)]
    pub stake_position: Box<Account<'info, StakePosition>>,
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds=[BET_SEED, &round.id.to_le_bytes(), receipt.authority.as_ref(), &receipt.nonce.to_le_bytes()], bump=receipt.bump)]
    pub receipt: Box<Account<'info, BetReceipt>>,
    /// CHECK: Immutable receipt owner retained as an explicit authority
    /// constraint; reward SOL accrues to `stake_position`, never this account.
    #[account(mut, constraint=beneficiary.key() == receipt.authority @ MyneError::InvalidReceiptAuthority)]
    pub beneficiary: UncheckedAccount<'info>,
    pub executor: Signer<'info>,
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
pub struct RefundReceiptPermissionless<'info> {
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds=[BET_SEED, &round.id.to_le_bytes(), receipt.authority.as_ref(), &receipt.nonce.to_le_bytes()], bump=receipt.bump)]
    pub receipt: Box<Account<'info, BetReceipt>>,
    /// CHECK: Immutable receipt owner; the only refund destination.
    #[account(mut, constraint=beneficiary.key() == receipt.authority @ MyneError::InvalidReceiptAuthority)]
    pub beneficiary: UncheckedAccount<'info>,
    pub executor: Signer<'info>,
}
#[derive(Accounts)]
pub struct MarkBuybackCompleted<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(address=config.buyback_wallet @ MyneError::InvalidFeeDestination)]
    pub buyback_authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct ArchiveRound<'info> {
    #[account(seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(address=config.randomness_authority @ MyneError::InvalidRandomnessAuthority)]
    pub randomness_authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    #[account(mut, seeds=[ROUND_SEED, &round.id.to_le_bytes()], bump=round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(
        mut,
        close=beneficiary,
        seeds=[BET_SEED, &round.id.to_le_bytes(), receipt.authority.as_ref(), &receipt.nonce.to_le_bytes()],
        bump=receipt.bump
    )]
    pub receipt: Box<Account<'info, BetReceipt>>,
    /// CHECK: Constrained to the immutable receipt owner and receives rent only.
    #[account(mut, constraint=beneficiary.key() == receipt.authority @ MyneError::InvalidReceiptAuthority)]
    pub beneficiary: UncheckedAccount<'info>,
    pub executor: Signer<'info>,
}
#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(
        mut,
        close=rent_payer,
        seeds=[ROUND_SEED, &round.id.to_le_bytes()],
        bump=round.bump
    )]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: Constrained to the payer recorded at round creation; receives rent only.
    #[account(mut, constraint=rent_payer.key() == round.rent_payer @ MyneError::InvalidFeeDestination)]
    pub rent_payer: UncheckedAccount<'info>,
    pub executor: Signer<'info>,
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
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Box<Account<'info, MiningPool>>,
    #[account(mut, seeds=[MINER_SEED, authority.key().as_ref()], bump=miner.bump, has_one=authority)]
    pub miner: Box<Account<'info, Miner>>,
    #[account(
        mut,
        seeds=[MINER_SEED, miner.referrer.as_ref()],
        bump=referrer_miner.bump,
        constraint=referrer_miner.authority == miner.referrer @ MyneError::InvalidReferrer
    )]
    pub referrer_miner: Option<Box<Account<'info, Miner>>>,
    #[account(mut, token::mint=mint, token::authority=authority)]
    pub destination_tokens: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Optional for referred claims, which route no MYNE to the admin. The
    /// handler requires and canonicalizes this ATA only on fallback claims.
    #[account(mut, token::mint=mint, token::authority=config.admin_fee_wallet)]
    pub admin_fee_tokens: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct BurnUnclaimedMyne<'info> {
    #[account(mut, seeds=[CONFIG_SEED], bump=config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds=[MINING_POOL_SEED], bump=mining_pool.bump)]
    pub mining_pool: Account<'info, MiningPool>,
    #[account(mut, seeds=[STAKE_POOL_SEED], bump=stake_pool.bump)]
    pub stake_pool: Account<'info, StakePool>,
    #[account(mut, seeds=[MINER_SEED, authority.key().as_ref()], bump=miner.bump, has_one=authority)]
    pub miner: Account<'info, Miner>,
    #[account(mut, seeds=[STAKE_POSITION_SEED, authority.key().as_ref()], bump=stake_position.bump, has_one=authority)]
    pub stake_position: Account<'info, StakePosition>,
    pub authority: Signer<'info>,
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
pub struct ProtocolVersionChanged {
    pub previous_version: u8,
    pub current_version: u8,
}
#[event]
pub struct RandomnessAuthorityChanged {
    pub randomness_authority: Pubkey,
}
#[event]
pub struct OperationalWalletsRotated {
    pub previous_buyback_wallet: Pubkey,
    pub buyback_wallet: Pubkey,
    pub previous_admin_fee_wallet: Pubkey,
    pub admin_fee_wallet: Pubkey,
    pub admin_fee_token_account: Pubkey,
}
#[event]
pub struct PrelaunchMintMigrated {
    pub previous_mint: Pubkey,
    pub new_mint: Pubkey,
    pub liquidity_owner: Pubkey,
    pub liquidity_token_account: Pubkey,
    pub genesis_base_units: u64,
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
    pub rent_payer: Pubkey,
    pub opened_at: i64,
    pub betting_ends_at: i64,
    pub settles_at: i64,
    pub refund_at: i64,
}
#[event]
pub struct RoundRandomnessBound {
    pub round_id: u64,
    pub randomness_account: Pubkey,
    pub randomness_commit_slot: u64,
}
#[event]
pub struct RoundRandomnessCommitted {
    pub round_id: u64,
    pub randomness_account: Pubkey,
    pub randomness_commit_slot: u64,
}
#[event]
pub struct RoundServerCommitmentBound {
    pub round_id: u64,
    pub commitment: [u8; 32],
}
#[event]
pub struct RoundServerEntropyLocked {
    pub round_id: u64,
    pub target_slot: u64,
    pub executor: Pubkey,
}
#[event]
pub struct RoundServerEntropyRevealed {
    pub round_id: u64,
    pub commitment: [u8; 32],
    pub reveal: [u8; 32],
    pub target_slot: u64,
    pub entropy_slot: u64,
    pub slot_hash: [u8; 32],
    pub randomness: [u8; 32],
    pub executor: Pubkey,
}
#[event]
pub struct DeploymentCreated {
    pub round_id: u64,
    pub authority: Pubkey,
    pub receipt: Pubkey,
    pub nonce: u64,
    pub total_lamports: u64,
    pub reward_mode: u8,
    pub amounts: [u64; TILE_COUNT],
    pub cumulative_starts: [u64; TILE_COUNT],
}
#[event]
pub struct AutoPlanConfigured {
    pub authority: Pubkey,
    pub per_round_lamports: u64,
    pub balance_lamports: u64,
    pub reward_mode: u8,
    pub active: bool,
}
#[event]
pub struct AutoPlanFunded {
    pub authority: Pubkey,
    pub lamports: u64,
    pub balance_lamports: u64,
}
#[event]
pub struct AutoPlanRewardsReinvested {
    pub authority: Pubkey,
    pub executor: Pubkey,
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
    pub gross_deployed_lamports: u64,
    pub prize_lamports: u64,
    pub motherlode_payout_lamports: u64,
    pub base_emission: u64,
    pub motherlode_emission: u64,
    pub total_receipts: u64,
    pub solo_sample: u64,
    pub randomness_account: Pubkey,
    pub randomness_commit_slot: u64,
    pub randomness: [u8; 32],
}
#[event]
pub struct BuybackAllocation {
    pub round_id: u64,
    pub wallet: Pubkey,
    pub lamports: u64,
}
#[event]
pub struct RoundFeesDistributed {
    pub round_id: u64,
    pub gross_deployed_lamports: u64,
    pub total_fee_lamports: u64,
    pub staking_gross_lamports: u64,
    pub staking_admin_lamports: u64,
    pub staking_net_lamports: u64,
    pub buyback_lamports: u64,
    pub motherlode_lamports: u64,
    pub mining_admin_lamports: u64,
    pub admin_total_lamports: u64,
    pub admin_fee_wallet: Pubkey,
}
#[event]
/// Historical v6 event emitted when receipt settlement also paid SOL directly
/// to the wallet. It remains in the IDL so the production indexer can replay
/// pre-upgrade transactions without losing their original meaning.
pub struct ReceiptClaimed {
    pub round_id: u64,
    pub authority: Pubkey,
    pub nonce: u64,
    pub sol_lamports: u64,
    pub myne_base_units: u64,
    pub motherlode_base_units: u64,
}
#[event]
pub struct ReceiptRewardAccruedV1 {
    pub round_id: u64,
    pub authority: Pubkey,
    pub nonce: u64,
    pub sol_lamports: u64,
    pub myne_base_units: u64,
    pub motherlode_base_units: u64,
    pub claim_vault: Pubkey,
    pub pending_sol_after: u64,
}
#[event]
pub struct ReceiptRefunded {
    pub round_id: u64,
    pub authority: Pubkey,
    pub nonce: u64,
    pub lamports: u64,
}
#[event]
pub struct BuybackCompleted {
    pub round_id: u64,
    pub authority: Pubkey,
}
#[event]
pub struct RoundArchived {
    pub round_id: u64,
    pub archive_hash: [u8; 32],
    pub slot: u64,
}
#[event]
pub struct ReceiptClosed {
    pub round_id: u64,
    pub authority: Pubkey,
    pub nonce: u64,
}
#[event]
pub struct RoundClosed {
    pub round_id: u64,
    pub rent_payer: Pubkey,
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
/// Versioned companion event: preserve the historical `MyneClaimed` layout
/// while making every fee recipient directly indexable and auditable.
#[event]
pub struct ClaimFeeRoutedV2 {
    pub claimant: Pubkey,
    pub passive_base_units: u64,
    pub referral_wallet: Pubkey,
    pub referral_base_units: u64,
    pub admin_fee_wallet: Pubkey,
    pub admin_base_units: u64,
}
#[event]
pub struct UnclaimedMyneBurned {
    pub authority: Pubkey,
    pub amount: u64,
    pub reward_weight_added: u64,
}
