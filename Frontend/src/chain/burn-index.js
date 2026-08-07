import { supabase } from '../social/config.js';
import { sumCompletedBuybackBurnRows } from './burn-accounting.js';
import { indexAvailable } from './rounds-index.js';

const PAGE_SIZE = 1_000;
const CACHE_MS = 5_000;
let cache = null;
let request = null;

/**
 * Total MYNE destroyed by completed buyback executions.
 *
 * Evidence is joined to `mine_rounds` so a keeper journal entry is not counted
 * until the round's on-chain `BuybackCompleted` event has also reached the
 * production index. The bounded pages avoid PostgREST's silent 1,000-row cap.
 */
export async function loadCompletedBuybackBurnBaseUnits({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (request) return request;
  request = (async () => {
    if (!(await indexAvailable()) || !supabase) return null;
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('mine_buyback_executions')
        .select('round_id,sequence,burned_base_units::text,burn_signature,mine_rounds!inner(resolved,buyback_completed)')
        .eq('mine_rounds.resolved', true)
        .eq('mine_rounds.buyback_completed', true)
        .order('round_id', { ascending: true })
        .order('sequence', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error || !Array.isArray(data)) return null;
      rows.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    return sumCompletedBuybackBurnRows(rows);
  })().catch(() => null).finally(() => { request = null; });
  const value = await request;
  if (value !== null) cache = { at: Date.now(), value };
  return value;
}
