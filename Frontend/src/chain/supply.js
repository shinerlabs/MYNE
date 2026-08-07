import { connection } from './client.js';
import {
  fetchProtocolAccount, getProtocolConfig, protocolPdas,
} from './anchor-client.js';
import { reconcileBurnTotals } from './burn-accounting.js';
import { loadCompletedBuybackBurnBaseUnits } from './burn-index.js';

const TTL_MS = 5_000;
let cache = { at: 0, data: null };
let request = null;
export async function readSupplyStats(force = false) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  if (request) return request;
  request = (async () => {
    const config = await getProtocolConfig({ force });
    const [supply, stakePool, completedBuybackBurn] = await Promise.all([
      connection.getTokenSupply(config.mint, 'confirmed'),
      fetchProtocolAccount('StakePool', protocolPdas.stakePool),
      loadCompletedBuybackBurnBaseUnits({ force }),
    ]);
    if (!stakePool || completedBuybackBurn === null) {
      throw new Error('Verified burn accounting is unavailable');
    }
    const totals = reconcileBurnTotals({
      totalEmittedBaseUnits: config.totalEmittedBaseUnits,
      currentSupplyBaseUnits: supply.value.amount,
      stakingBurnBaseUnits: stakePool.totalBurn,
      completedBuybackBurnBaseUnits: completedBuybackBurn,
    });
    if (!totals) throw new Error('Indexed burns do not reconcile with the on-chain mint supply');
    const max = BigInt(config.maxTokens.toString()) * 1_000_000_000n;
    return { max, ...totals };
  })().finally(() => { request = null; });
  const data = await request;
  cache = { at: Date.now(), data };
  return data;
}
