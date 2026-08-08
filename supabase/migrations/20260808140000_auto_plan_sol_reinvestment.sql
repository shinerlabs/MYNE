-- AutoPlan.reward_mode is a composite byte:
--   bit 0: MYNE reward mode (0 accumulate, 1 permanent burn stake)
--   bit 1: owner consent to reinvest all claimable SOL into Auto Mine
-- Bet receipt reward_mode remains strictly 0..1.
alter table public.mine_auto_plans
  drop constraint if exists mine_auto_plans_reward_mode_check;

alter table public.mine_auto_plans
  add constraint mine_auto_plans_reward_mode_check
  check (reward_mode between 0 and 3);

create index if not exists mine_auto_plans_active_reinvest_idx
  on public.mine_auto_plans (authority)
  where active and reward_mode >= 2;
