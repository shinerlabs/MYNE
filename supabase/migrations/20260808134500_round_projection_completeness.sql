-- Rebuildable participant-projection health. The Solana Round PDA remains the
-- source of truth; these fields only describe whether the public read model
-- exactly matches its immutable receipt aggregates.

alter table public.mine_rounds
  add column if not exists projection_complete boolean not null default false,
  add column if not exists projection_version smallint not null default 2,
  add column if not exists source_slot bigint;

alter table public.mine_rounds
  drop constraint if exists mine_rounds_projection_version_check;
alter table public.mine_rounds
  add constraint mine_rounds_projection_version_check
  check (projection_version >= 1);

alter table public.mine_rounds
  drop constraint if exists mine_rounds_source_slot_check;
alter table public.mine_rounds
  add constraint mine_rounds_source_slot_check
  check (source_slot is null or source_slot >= 0);

comment on column public.mine_rounds.projection_complete is
  'True only when receipt lifecycle counters and all 25 indexed amount/count buckets equal the finalized Round PDA.';
comment on column public.mine_rounds.projection_version is
  'Version of the rebuildable round participant projection.';
comment on column public.mine_rounds.source_slot is
  'Newest finalized Solana transaction slot applied by the forward event cursor.';

-- A delayed event from an older RPC response must never roll a newer public
-- projection backwards. Canonical repair omits source_slot and is unaffected;
-- forward writes carry the finalized event slot and fail closed when stale.
create or replace function public.enforce_mine_round_source_slot_monotonic()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.source_slot is not null
     and (new.source_slot is null or new.source_slot < old.source_slot) then
    raise exception 'stale mine_rounds source_slot: % < %', new.source_slot, old.source_slot
      using errcode = '40001';
  end if;
  return new;
end;
$$;

drop trigger if exists mine_rounds_source_slot_monotonic on public.mine_rounds;
create trigger mine_rounds_source_slot_monotonic
before update of source_slot on public.mine_rounds
for each row execute function public.enforce_mine_round_source_slot_monotonic();

-- Aggregate inside Postgres so reconciliation never depends on PostgREST's
-- row cap. The worker bounds the round-id array, and the existing round/square
-- index supplies the access path.
create or replace function public.mine_round_projection_digest(p_round_ids bigint[])
returns table (
  round_id bigint,
  indexed_total_receipts bigint,
  indexed_processed_receipts bigint,
  indexed_closed_receipts bigint,
  indexed_tile_lamports jsonb,
  indexed_tile_receipts jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with requested as (
    select distinct value as round_id
    from unnest(coalesce(p_round_ids, array[]::bigint[])) as requested_value(value)
    where value >= 0
  ),
  per_tile as (
    select
      b.round_id,
      b.square,
      coalesce(sum(b.amount_wei), 0)::numeric(78,0) as lamports,
      count(distinct b.receipt)::bigint as receipts
    from public.mine_round_bets b
    join requested r using (round_id)
    group by b.round_id, b.square
  ),
  receipt_totals as (
    select b.round_id, count(distinct b.receipt)::bigint as receipts
    from public.mine_round_bets b
    join requested r using (round_id)
    group by b.round_id
  ),
  settlement_totals as (
    select
      s.round_id,
      count(distinct s.receipt) filter (
        where s.status in ('claimed', 'accrued', 'refunded')
      )::bigint as processed,
      count(distinct s.receipt) filter (where s.status = 'closed')::bigint as closed
    from public.mine_receipt_settlements s
    join requested r using (round_id)
    group by s.round_id
  )
  select
    r.round_id,
    coalesce(rt.receipts, 0)::bigint,
    coalesce(st.processed, 0)::bigint,
    coalesce(st.closed, 0)::bigint,
    jsonb_agg(to_jsonb(coalesce(pt.lamports, 0)::text) order by square.value),
    jsonb_agg(to_jsonb(coalesce(pt.receipts, 0)::bigint) order by square.value)
  from requested r
  cross join generate_series(0, 24) as square(value)
  left join per_tile pt on pt.round_id = r.round_id and pt.square = square.value
  left join receipt_totals rt on rt.round_id = r.round_id
  left join settlement_totals st on st.round_id = r.round_id
  group by r.round_id, rt.receipts, st.processed, st.closed
  order by r.round_id;
$$;

revoke all on function public.mine_round_projection_digest(bigint[]) from public, anon, authenticated;
grant execute on function public.mine_round_projection_digest(bigint[]) to service_role;

-- This marker is replaced last so a new worker refuses a partially migrated
-- schema instead of writing fields the database does not yet have.
create or replace view public.mine_worker_schema_capabilities
with (security_invoker = true)
as
select 'round-projection-v2'::text as release;

revoke all on public.mine_worker_schema_capabilities from public, anon, authenticated;
grant select on public.mine_worker_schema_capabilities to service_role;
