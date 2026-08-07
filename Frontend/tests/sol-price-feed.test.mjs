import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchSolPrice, parseSolPrice } from '../src/chain/sol-price-feed.js';

test('normalizes validated SOL/USD provider responses', () => {
  assert.deepEqual(parseSolPrice('coingecko', {
    solana: { usd: 74.3, last_updated_at: 1_785_960_360 },
    'usd-coin': { usd: 0.998 },
  }), {
    usd: 74.3,
    usdc: 74.3 / 0.998,
    at: 1_785_960_360_000,
    stale: false,
    source: 'coingecko',
  });
  assert.equal(parseSolPrice('coingecko', { solana: { usd: -1 } }), null);
  assert.equal(parseSolPrice('kraken', { result: {} }), null);
});

test('falls back from the cached backend to a public SOL price provider', async () => {
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { ok: false };
    return {
      ok: true,
      json: async () => ({
        solana: { usd: 74.3, last_updated_at: 1_785_960_360 },
        'usd-coin': { usd: 1 },
      }),
    };
  };

  const result = await fetchSolPrice('/rounds/api/sol-price', fetchMock);
  assert.equal(result.usd, 74.3);
  assert.equal(result.usdc, 74.3);
  assert.equal(result.source, 'coingecko');
  assert.equal(calls.length, 2);
});
