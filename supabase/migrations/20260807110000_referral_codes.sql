-- Compact public referral URLs resolve through this deterministic, read-only index. The complete
-- Solana address still enters the on-chain register_miner instruction; the short code never does.
create table if not exists public.mine_referral_codes (
  code text primary key,
  wallet_address text not null unique,
  created_at timestamptz not null default now(),
  constraint mine_referral_codes_code_format
    check (code ~ '^[1-9A-HJ-NP-Za-km-z]{10}$'),
  constraint mine_referral_codes_wallet_format
    check (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint mine_referral_codes_deterministic
    check (code = right(wallet_address, 10))
);

-- Backfill every indexed miner. A fantastically unlikely suffix collision is omitted rather than
-- assigning an ambiguous code; the unique constraint also makes every later collision fail shut.
with candidates as (
  select distinct bettor as wallet_address
  from public.mine_round_bets
  where bettor ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
), unique_codes as (
  select right(wallet_address, 10) as code, min(wallet_address) as wallet_address
  from candidates
  group by right(wallet_address, 10)
  having count(*) = 1
)
insert into public.mine_referral_codes (code, wallet_address)
select code, wallet_address from unique_codes
on conflict do nothing;

alter table public.mine_referral_codes enable row level security;
drop policy if exists "referral codes are public" on public.mine_referral_codes;
create policy "referral codes are public"
  on public.mine_referral_codes for select using (true);

grant select on public.mine_referral_codes to anon, authenticated;
revoke insert, update, delete on public.mine_referral_codes from anon, authenticated;
