import { connection } from './client.js';
import { getProtocolConfig } from './anchor-client.js';

const TTL_MS = 15_000;
let cache = { at: 0, data: null };
export async function readSupplyStats(force = false) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  const config = await getProtocolConfig();
  const supply = await connection.getTokenSupply(config.mint, 'confirmed');
  const current = BigInt(supply.value.amount);
  const burnedStaking = BigInt(config.virtualBurnBaseUnits?.toString?.() ?? 0);
  const max = BigInt(config.maxTokens.toString()) * 1_000_000_000n;
  const data = { max, current, burned: burnedStaking, burnedBuyback: 0n, burnedStaking, supplied: current + burnedStaking };
  cache = { at: Date.now(), data };
  return data;
}
