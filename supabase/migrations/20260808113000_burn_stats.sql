-- Constant-size public read model for the frontend's real-time MYNE burn total.
-- Stake + Burn principal remains authoritative in the on-chain StakePool;
-- this view exposes only keeper burns whose round has also reached the indexed
-- on-chain BuybackCompleted state.

create or replace view public.mine_burn_stats
with (security_invoker = true)
as
select
  coalesce(sum(execution.burned_base_units), 0)::numeric(78,0)
    as completed_buyback_burn_base_units,
  count(*)::bigint as completed_buyback_executions,
  max(execution.round_id)::bigint as latest_completed_buyback_round
from public.mine_buyback_executions execution
join public.mine_rounds round_state
  on round_state.round_id = execution.round_id
where round_state.resolved = true
  and round_state.buyback_completed = true;

comment on view public.mine_burn_stats is
  'Completed buyback MYNE burns; permanent staking burns remain in the Solana StakePool account.';

grant select on public.mine_burn_stats to anon, authenticated;
