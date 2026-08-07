-- Public, chain-derived fee allocation fields emitted by RoundFeesDistributed.
-- Historical rows remain nullable; every post-upgrade settled round is filled
-- by the production indexer before its canonical archive is attested.

alter table public.mine_rounds
  add column if not exists total_fee_lamports numeric(20,0),
  add column if not exists staking_gross_lamports numeric(20,0),
  add column if not exists staking_admin_lamports numeric(20,0),
  add column if not exists staking_net_lamports numeric(20,0),
  add column if not exists buyback_lamports numeric(20,0),
  add column if not exists motherlode_fee_lamports numeric(20,0),
  add column if not exists mining_admin_lamports numeric(20,0),
  add column if not exists admin_total_lamports numeric(20,0),
  add column if not exists admin_fee_wallet text;

alter table public.mine_rounds
  drop constraint if exists mine_round_fee_conservation,
  add constraint mine_round_fee_conservation check (
    total_fee_lamports is null
    or total_fee_lamports = staking_net_lamports
      + staking_admin_lamports
      + buyback_lamports
      + motherlode_fee_lamports
      + mining_admin_lamports
  ),
  drop constraint if exists mine_round_staking_fee_conservation,
  add constraint mine_round_staking_fee_conservation check (
    staking_gross_lamports is null
    or staking_gross_lamports = staking_net_lamports + staking_admin_lamports
  ),
  drop constraint if exists mine_round_admin_fee_conservation,
  add constraint mine_round_admin_fee_conservation check (
    admin_total_lamports is null
    or admin_total_lamports = mining_admin_lamports + staking_admin_lamports
  );
