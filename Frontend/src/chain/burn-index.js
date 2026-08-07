import { supabase } from '../social/config.js';
import { completedBuybackBurnFromStatsRow } from './burn-accounting.js';
import { indexAvailable } from './rounds-index.js';

const CACHE_MS = 5_000;
let cache = null;
let request = null;

/**
 * Total MYNE destroyed by completed buyback executions.
 *
 * The aggregate read model joins evidence to `mine_rounds`, so a keeper journal
 * entry is not counted until the round's on-chain `BuybackCompleted` event has
 * reached the production index. Aggregating in Postgres keeps the browser read
 * constant-size as the number of completed rounds grows.
 */
export async function loadCompletedBuybackBurnBaseUnits({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (request) return request;
  request = (async () => {
    if (!(await indexAvailable()) || !supabase) return null;
    const { data, error } = await supabase
      .from('mine_burn_stats')
      .select('completed_buyback_burn_base_units_text,completed_buyback_executions,latest_completed_buyback_round')
      .single();
    if (error) return null;
    return completedBuybackBurnFromStatsRow(data);
  })().catch(() => null).finally(() => { request = null; });
  const value = await request;
  if (value !== null) cache = { at: Date.now(), value };
  return value;
}
