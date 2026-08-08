import { connection } from './client.js';
import {
  fetchProtocolAccount, getProtocolConfig, protocolPdas,
} from './anchor-client.js';
import { assembleSupplySnapshot } from './burn-accounting.js';
import { loadCompletedBuybackBurnBaseUnits } from './burn-index.js';

const TTL_MS = 5_000;
let cache = { at: 0, data: null };
let request = null;
export async function readSupplyStats(force = false) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  if (request) return request;
  request = (async () => {
    const config = await getProtocolConfig({ force });
    const [supplyResult, stakePoolResult, completedBuybackResult] = await Promise.allSettled([
      connection.getTokenSupply(config.mint, 'confirmed'),
      fetchProtocolAccount('StakePool', protocolPdas.stakePool),
      loadCompletedBuybackBurnBaseUnits({ force }),
    ]);
    const supply = supplyResult.status === 'fulfilled' ? supplyResult.value : null;
    const stakePool = stakePoolResult.status === 'fulfilled' ? stakePoolResult.value : null;
    const completedBuybackBurn = completedBuybackResult.status === 'fulfilled'
      ? completedBuybackResult.value
      : null;
    const snapshot = assembleSupplySnapshot({
      maxTokenUnits: config.maxTokens.toString(),
      currentSupplyBaseUnits: supply?.value?.amount ?? null,
      stakingBurnBaseUnits: stakePool?.totalBurn?.toString?.() ?? stakePool?.totalBurn ?? null,
      completedBuybackBurnBaseUnits: completedBuybackBurn,
    });
    if (!snapshot) throw new Error('Supply accounting contains an invalid maximum');
    return snapshot;
  })().finally(() => { request = null; });
  const data = await request;
  cache = { at: Date.now(), data };
  return data;
}
