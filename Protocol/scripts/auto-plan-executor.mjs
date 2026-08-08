import assert from 'node:assert/strict';

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};

export async function fetchActiveAutoPlanAuthorities({ indexedRows, pageSize = 250, maxPages = 100 }) {
  assert.equal(typeof indexedRows, 'function', 'indexedRows callback is required');
  const size = boundedInteger(pageSize, 250, 1, 1_000);
  const pages = boundedInteger(maxPages, 100, 1, 1_000);
  const authorities = new Set();
  for (let page = 0; page < pages; page += 1) {
    const offset = page * size;
    const rows = await indexedRows(
      `mine_auto_plans?active=eq.true&balance_lamports=gt.0&select=authority&order=authority.asc&limit=${size}&offset=${offset}`,
    );
    for (const row of rows) {
      if (typeof row?.authority === 'string' && row.authority) authorities.add(row.authority);
    }
    if (rows.length < size) return [...authorities];
  }
  throw new Error(`Auto-plan index exceeded the bounded ${size * pages} active-plan scan`);
}

async function mapConcurrent(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try { results[index] = await mapper(values[index]); } catch (error) { results[index] = { error }; }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function sendAutoPlanBatchesIsolated({ entries, batchSize, sendBatch, onEvent = () => {} }) {
  const size = boundedInteger(batchSize, 4, 1, 6);
  const sendIsolated = async (batch) => {
    try {
      const sent = await sendBatch(batch);
      onEvent({
        event: 'auto-plans-executed',
        authorities: batch.map(({ authority }) => authority),
        signature: sent?.signature ?? null,
        measuredUnits: sent?.measuredUnits,
        computeLimit: sent?.computeLimit,
      });
      return;
    } catch (error) {
      if (batch.length > 1) {
        const split = Math.ceil(batch.length / 2);
        await sendIsolated(batch.slice(0, split));
        await sendIsolated(batch.slice(split));
        return;
      }
      onEvent({
        event: 'auto-plan-execution-failed',
        authority: batch[0]?.authority ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  for (let offset = 0; offset < entries.length; offset += size) {
    await sendIsolated(entries.slice(offset, offset + size));
  }
}

/**
 * Reconcile Auto Mine throughout the full betting interval. Every pass rechecks the plan on
 * chain, so retries are idempotent through AutoPlan.last_round and can pick up late index writes.
 */
export async function executeAutoPlansDuringWindow({
  bettingEndsAt,
  nowSeconds,
  sleep,
  indexedRows,
  buildEntry,
  sendBatch,
  batchSize = process.env.AUTO_PLAN_BATCH_SIZE || 4,
  retryMs = process.env.AUTO_PLAN_RETRY_MS || 5_000,
  buildConcurrency = process.env.AUTO_PLAN_READ_CONCURRENCY || 12,
  onEvent = () => {},
}) {
  const retryDelay = boundedInteger(retryMs, 5_000, 500, 15_000);
  const concurrency = boundedInteger(buildConcurrency, 12, 1, 32);
  while (await nowSeconds() < bettingEndsAt) {
    try {
      const authorities = await fetchActiveAutoPlanAuthorities({ indexedRows });
      const built = await mapConcurrent(authorities, concurrency, async (authority) => buildEntry({ authority }));
      const executable = [];
      for (let index = 0; index < built.length; index += 1) {
        const result = built[index];
        if (result?.error) {
          onEvent({
            event: 'auto-plan-invalid-index-entry',
            authority: authorities[index],
            error: result.error instanceof Error ? result.error.message : String(result.error),
          });
        } else if (result) executable.push(result);
      }
      await sendAutoPlanBatchesIsolated({ entries: executable, batchSize, sendBatch, onEvent });
    } catch (error) {
      onEvent({
        event: 'auto-plan-index-unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const remainingMs = (bettingEndsAt - await nowSeconds()) * 1_000;
    if (remainingMs <= 0) break;
    await sleep(Math.min(retryDelay, Math.max(100, remainingMs)));
  }
}
