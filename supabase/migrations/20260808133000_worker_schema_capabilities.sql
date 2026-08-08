-- A production worker must not start against a partially migrated read model.
-- This marker is deliberately last in the server-randomness + claim-accrual
-- release, so its presence proves the provider proof, burn aggregate, accrued
-- receipt status, empty-round stats, lease privileges and realtime migrations
-- were applied in timestamp order.

create or replace view public.mine_worker_schema_capabilities
with (security_invoker = true)
as
select 'server-claims-v1'::text as release;

revoke all on public.mine_worker_schema_capabilities from public, anon, authenticated;
grant select on public.mine_worker_schema_capabilities to service_role;

comment on view public.mine_worker_schema_capabilities is
  'Service-role release marker used by the production worker host to reject a partially migrated index.';
