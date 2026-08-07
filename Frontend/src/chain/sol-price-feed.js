const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana%2Cusd-coin&vs_currencies=usd&include_last_updated_at=true';
const KRAKEN_URL = 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD';

const validPrice = (value) => {
  const usd = Number(value);
  return Number.isFinite(usd) && usd > 0 ? usd : null;
};

export function parseSolPrice(source, body, now = Date.now()) {
  if (source === 'backend') {
    const usd = validPrice(body?.usd);
    const usdc = validPrice(body?.usdc) ?? usd;
    return usd == null ? null : { usd, usdc, at: Number(body.at) || now, stale: Boolean(body.stale), source };
  }
  if (source === 'coingecko') {
    const usd = validPrice(body?.solana?.usd);
    const usdcUsd = validPrice(body?.['usd-coin']?.usd) ?? 1;
    return usd == null ? null : {
      usd,
      usdc: usd / usdcUsd,
      at: Number(body.solana.last_updated_at) * 1000 || now,
      stale: false,
      source,
    };
  }
  if (source === 'kraken') {
    const ticker = Object.values(body?.result ?? {})[0];
    const usd = validPrice(ticker?.c?.[0]);
    return usd == null ? null : { usd, usdc: usd, at: now, stale: false, source };
  }
  return null;
}

/** Prefer the site's cached endpoint; public providers are local/dev and outage fallbacks. */
export async function fetchSolPrice(backendUrl, fetchImpl = fetch) {
  const sources = [
    ['backend', backendUrl],
    ['coingecko', COINGECKO_URL],
    ['kraken', KRAKEN_URL],
  ];
  for (const [source, url] of sources) {
    try {
      const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
      if (!response.ok) continue;
      const parsed = parseSolPrice(source, await response.json());
      if (parsed) return parsed;
    } catch { /* try the next source */ }
  }
  return null;
}
