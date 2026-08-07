-- Read-only, rebuildable Solana history index. The chain remains authoritative
-- for balances, claims and protocol configuration; this schema preserves
-- settled history before temporary PDAs are closed and their rent is returned.

create table if not exists public.mine_rounds (
  round_id bigint primary key,
  rent_payer text,
  opened_at bigint,
  betting_ends_at bigint,
  settles_at bigint,
  refund_at bigint,
  resolved boolean not null default false,
  winning_square smallint,
  jackpot_hit boolean not null default false,
  single_miner_round boolean not null default false,
  winner text,
  total_wager_wei numeric(20,0) not null default 0,
  winner_total_wei numeric(20,0) not null default 0,
  pot_for_winners_wei numeric(20,0) not null default 0,
  bullion_for_winners_wei numeric(20,0) not null default 0,
  payout_mul_wad numeric(39,0) not null default 0,
  randomness_id text,
  randomness_value numeric(78,0),
  randomness_hex text,
  randomness_commit_slot bigint,
  randomness_closed_signature text,
  randomness_closed_at timestamptz,
  solo_sample numeric(20,0) not null default 0,
  total_receipts bigint not null default 0,
  processed_receipts bigint not null default 0,
  closed_receipts bigint not null default 0,
  buyback_completed boolean not null default false,
  settlement_signature text,
  settlement_slot bigint,
  archive_hash text,
  archive_slot bigint,
  archived_at timestamptz,
  closed_signature text,
  closed_slot bigint,
  drand_round bigint,
  drand_url text,
  updated_at timestamptz not null default now()
);

create table if not exists public.mine_round_bets (
  round_id bigint not null references public.mine_rounds(round_id) on delete cascade,
  receipt text not null,
  bettor text not null,
  nonce numeric(20,0) not null,
  square smallint not null check (square between 0 and 24),
  amount_wei numeric(20,0) not null check (amount_wei > 0),
  cumulative_start_wei numeric(20,0) not null,
  reward_mode smallint not null check (reward_mode between 0 and 1),
  deployment_signature text not null,
  deployment_slot bigint not null,
  created_at timestamptz not null default now(),
  primary key (round_id, receipt, square)
);

create index if not exists mine_round_bets_bettor_round_idx
  on public.mine_round_bets (bettor, round_id desc);
create index if not exists mine_round_bets_round_idx
  on public.mine_round_bets (round_id, square);

create table if not exists public.mine_receipt_settlements (
  round_id bigint not null,
  receipt text not null,
  authority text not null,
  nonce numeric(20,0) not null,
  status text not null check (status in ('claimed', 'refunded', 'closed')),
  sol_lamports numeric(20,0) not null default 0,
  myne_base_units numeric(20,0) not null default 0,
  motherlode_base_units numeric(20,0) not null default 0,
  signature text not null,
  slot bigint not null,
  updated_at timestamptz not null default now(),
  primary key (round_id, receipt, status)
);

create table if not exists public.mine_round_proofs (
  round_id bigint primary key references public.mine_rounds(round_id) on delete cascade,
  archive_hash text not null,
  canonical_snapshot jsonb not null,
  randomness_account text,
  randomness_commit_slot bigint,
  randomness_hex text,
  settlement_signature text,
  archived_signature text,
  created_at timestamptz not null default now()
);

-- Durable, public evidence for each partial or complete 2% buyback allocation.
-- A round may require several capped swaps; every row links the SOL spend to
-- the corresponding MYNE burn transaction before the archive is attested.
create table if not exists public.mine_buyback_executions (
  round_id bigint not null references public.mine_rounds(round_id) on delete cascade,
  sequence integer not null check (sequence >= 0),
  spend_lamports numeric(20,0) not null check (spend_lamports > 0),
  expected_output_base_units numeric(20,0) not null check (expected_output_base_units > 0),
  burned_base_units numeric(20,0) not null check (burned_base_units > 0),
  swap_signature text not null,
  burn_signature text not null,
  created_at timestamptz not null default now(),
  primary key (round_id, sequence),
  unique (swap_signature),
  unique (burn_signature)
);

create table if not exists public.mine_indexer_state (
  id text primary key,
  newest_signature text,
  newest_slot bigint,
  updated_at timestamptz not null default now()
);

-- Operational index used by the keeper to fetch exact AutoPlan PDAs instead
-- of scanning every account owned by the program each round.
create table if not exists public.mine_auto_plans (
  authority text primary key,
  active boolean not null default false,
  reward_mode smallint not null default 0 check (reward_mode between 0 and 1),
  per_round_lamports numeric(20,0) not null default 0,
  balance_lamports numeric(20,0) not null default 0,
  last_round bigint,
  next_nonce numeric(20,0) not null default 0,
  updated_slot bigint not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists mine_auto_plans_active_idx
  on public.mine_auto_plans (active, updated_slot desc);

create or replace view public.mine_round_stats as
select
  count(*) filter (where resolved and total_wager_wei > 0)::bigint as mined,
  coalesce(sum(total_wager_wei) filter (where resolved), 0)::numeric(78,0) as deployed_wei,
  coalesce(sum(bullion_for_winners_wei) filter (where resolved), 0)::numeric(78,0) as minted_wei,
  count(*) filter (where resolved and jackpot_hit)::bigint as jackpots
from public.mine_rounds;

alter table public.mine_rounds enable row level security;
alter table public.mine_round_bets enable row level security;
alter table public.mine_receipt_settlements enable row level security;
alter table public.mine_round_proofs enable row level security;
alter table public.mine_buyback_executions enable row level security;
alter table public.mine_indexer_state enable row level security;
alter table public.mine_auto_plans enable row level security;

drop policy if exists "round history is public" on public.mine_rounds;
create policy "round history is public" on public.mine_rounds for select using (true);
drop policy if exists "round bets are public" on public.mine_round_bets;
create policy "round bets are public" on public.mine_round_bets for select using (true);
drop policy if exists "round proofs are public" on public.mine_round_proofs;
create policy "round proofs are public" on public.mine_round_proofs for select using (true);
drop policy if exists "buyback evidence is public" on public.mine_buyback_executions;
create policy "buyback evidence is public" on public.mine_buyback_executions for select using (true);

grant select on public.mine_rounds, public.mine_round_bets, public.mine_round_proofs,
  public.mine_buyback_executions,
  public.mine_round_stats to anon, authenticated;
revoke all on public.mine_receipt_settlements, public.mine_indexer_state,
  public.mine_auto_plans from anon, authenticated;
