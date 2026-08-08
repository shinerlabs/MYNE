-- Empty scheduled rounds remain public/verifiable results, but they are not
-- mining or Motherlode awards. Keep aggregate reward statistics scoped to
-- rounds with an actual deployment while the round ledger itself retains all
-- resolved zero-bid rows and their winning tiles.

create or replace view public.mine_round_stats as
select
  count(*) filter (where resolved and total_wager_wei > 0)::bigint as mined,
  coalesce(sum(total_wager_wei) filter (where resolved), 0)::numeric(78,0) as deployed_wei,
  coalesce(sum(bullion_for_winners_wei) filter (where resolved), 0)::numeric(78,0) as minted_wei,
  count(*) filter (
    where resolved and total_wager_wei > 0 and jackpot_hit
  )::bigint as jackpots
from public.mine_rounds;

comment on view public.mine_round_stats is
  'Protocol aggregates; zero-bid resolved rounds publish outcomes but never count as mining or Motherlode awards.';

grant select on public.mine_round_stats to anon, authenticated;
