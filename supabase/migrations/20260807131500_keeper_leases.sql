-- Atomic fencing for off-chain processes whose external side effects cannot be
-- made idempotent by a Solana PDA alone (notably the Meteora swap/burn keeper).

create table if not exists public.mine_keeper_leases (
  lease_name text primary key,
  holder text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.mine_keeper_leases enable row level security;
revoke all on public.mine_keeper_leases from anon, authenticated;

create or replace function public.acquire_mine_keeper_lease(
  p_lease_name text,
  p_holder text,
  p_ttl_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if length(trim(p_lease_name)) = 0 or length(trim(p_holder)) = 0 then
    raise exception 'lease name and holder are required';
  end if;
  if p_ttl_seconds < 120 or p_ttl_seconds > 3600 then
    raise exception 'lease ttl must be between 120 and 3600 seconds';
  end if;

  insert into public.mine_keeper_leases (lease_name, holder, expires_at, updated_at)
  values (p_lease_name, p_holder, now() + make_interval(secs => p_ttl_seconds), now())
  on conflict (lease_name) do update
    set holder = excluded.holder,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    where public.mine_keeper_leases.expires_at <= now()
       or public.mine_keeper_leases.holder = excluded.holder;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.acquire_mine_keeper_lease(text, text, integer) from public;
grant execute on function public.acquire_mine_keeper_lease(text, text, integer) to service_role;
