-- Rebuildable referral projection v1. Solana remains authoritative for permanent attribution,
-- reward balances and claims; these rows are derived only from finalized program events.
-- Versioned relation names allow a future event/schema revision to rebuild alongside v1.

create table if not exists public.mine_referral_miners_v1 (
  registration_signature text not null,
  registration_event_index integer not null check (registration_event_index >= 0),
  authority text not null unique,
  referrer text,
  registration_slot bigint not null check (registration_slot >= 0),
  indexed_at timestamptz not null default now(),
  primary key (registration_signature, registration_event_index),
  constraint mine_referral_miners_v1_signature_format
    check (registration_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  constraint mine_referral_miners_v1_authority_format
    check (authority ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint mine_referral_miners_v1_referrer_format
    check (referrer is null or referrer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint mine_referral_miners_v1_no_self_referral
    check (referrer is null or referrer <> authority)
);

create index if not exists mine_referral_miners_v1_referrer_idx
  on public.mine_referral_miners_v1 (referrer, registration_slot, authority);

create table if not exists public.mine_referral_claims_v1 (
  claim_signature text not null,
  claim_event_index integer not null check (claim_event_index >= 0),
  routing_event_index integer check (routing_event_index >= 0),
  routing_audited boolean not null default false,
  claimant text not null,
  referral_wallet text,
  admin_fee_wallet text,
  gross_base_units numeric(20,0) not null check (gross_base_units >= 0),
  net_base_units numeric(20,0) not null check (net_base_units >= 0),
  fee_base_units numeric(20,0) not null check (fee_base_units >= 0),
  passive_base_units numeric(20,0) not null check (passive_base_units >= 0),
  referral_base_units numeric(20,0) not null check (referral_base_units >= 0),
  admin_base_units numeric(20,0) not null check (admin_base_units >= 0),
  claim_slot bigint not null check (claim_slot >= 0),
  indexed_at timestamptz not null default now(),
  primary key (claim_signature, claim_event_index),
  constraint mine_referral_claims_v1_signature_format
    check (claim_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  constraint mine_referral_claims_v1_claimant_format
    check (claimant ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint mine_referral_claims_v1_referral_wallet_format
    check (referral_wallet is null or referral_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint mine_referral_claims_v1_admin_wallet_format
    check (admin_fee_wallet is null or admin_fee_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint mine_referral_claims_v1_no_self_referral
    check (referral_wallet is null or referral_wallet <> claimant),
  constraint mine_referral_claims_v1_gross_conservation
    check (gross_base_units = net_base_units + fee_base_units),
  constraint mine_referral_claims_v1_fee_conservation
    check (fee_base_units = passive_base_units + referral_base_units + admin_base_units),
  constraint mine_referral_claims_v1_attributed_credit
    check (referral_base_units = 0 or referral_wallet is not null),
  constraint mine_referral_claims_v1_exclusive_direct_recipient
    check (referral_base_units = 0 or admin_base_units = 0),
  constraint mine_referral_claims_v1_versioned_route
    check (not routing_audited or routing_event_index is not null)
);

create index if not exists mine_referral_claims_v1_claimant_idx
  on public.mine_referral_claims_v1
  (claimant, referral_wallet, claim_slot, claim_event_index);
create index if not exists mine_referral_claims_v1_referrer_idx
  on public.mine_referral_claims_v1 (referral_wallet, claim_slot, claim_event_index)
  where referral_wallet is not null;

-- One bounded row per directly referred miner. "Active" means the miner has completed at least
-- one non-zero MYNE claim; it is intentionally not inferred from a global program-account scan.
create or replace view public.mine_referral_network_v1
with (security_invoker = true)
as
select
  miner.referrer as referrer_wallet,
  miner.authority as referred_wallet,
  miner.registration_slot,
  coalesce(bool_or(claim.gross_base_units > 0), false) as active,
  coalesce(sum(claim.referral_base_units), 0)::numeric as earned_base_units,
  max(claim.claim_slot) as last_claim_slot
from public.mine_referral_miners_v1 as miner
left join public.mine_referral_claims_v1 as claim
  on claim.claimant = miner.authority
 and claim.referral_wallet = miner.referrer
where miner.referrer is not null
group by miner.referrer, miner.authority, miner.registration_slot;

-- Aggregate used for exact wallet stats and the leaderboard. "earned" is lifetime referral
-- credit observed in claim events, not a separately claimable balance (none exists on-chain).
create or replace view public.mine_referral_stats_v1
with (security_invoker = true)
as
select
  referrer_wallet as wallet_address,
  count(*)::bigint as referrals,
  count(*) filter (where active)::bigint as active,
  coalesce(sum(earned_base_units), 0)::numeric as earned_base_units,
  max(last_claim_slot) as last_activity_slot
from public.mine_referral_network_v1
group by referrer_wallet;

alter table public.mine_referral_miners_v1 enable row level security;
alter table public.mine_referral_claims_v1 enable row level security;

drop policy if exists "referral miner projection is public" on public.mine_referral_miners_v1;
create policy "referral miner projection is public"
  on public.mine_referral_miners_v1 for select using (true);
drop policy if exists "referral claim projection is public" on public.mine_referral_claims_v1;
create policy "referral claim projection is public"
  on public.mine_referral_claims_v1 for select using (true);

revoke all on public.mine_referral_miners_v1, public.mine_referral_claims_v1
  from anon, authenticated;
grant select on public.mine_referral_miners_v1, public.mine_referral_claims_v1,
  public.mine_referral_network_v1, public.mine_referral_stats_v1
  to anon, authenticated;
grant select, insert, update on public.mine_referral_miners_v1,
  public.mine_referral_claims_v1 to service_role;
