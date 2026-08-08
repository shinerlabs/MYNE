-- Publish the AutoPlan reinvest schema capability in a follow-up migration.
-- Keeping this separate from the already-pushed 140000 migration makes the
-- rollout safe even if that migration was applied before the worker gate was
-- introduced. Older workers still find round-projection-v2; new workers
-- require both rows before indexing composite AutoPlan reward modes.
create or replace view public.mine_worker_schema_capabilities
with (security_invoker = true)
as
select release
from (values
  ('round-projection-v2'::text),
  ('auto-reinvest-v1'::text)
) as capabilities(release);

revoke all on public.mine_worker_schema_capabilities from public, anon, authenticated;
grant select on public.mine_worker_schema_capabilities to service_role;
