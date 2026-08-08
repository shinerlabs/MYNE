import assert from 'node:assert/strict';

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};

export const OPERATION_TIMEOUT_CODE = 'MYNE_OPERATION_TIMEOUT';
export const AUTO_PLAN_REINVEST_SOL_FLAG = 2;

const asBigInt = (value, name) => {
  const parsed = typeof value === 'bigint' ? value : BigInt(value?.toString?.() ?? value ?? 0);
  assert.ok(parsed >= 0n, `${name} must be non-negative`);
  return parsed;
};

/**
 * Classify the exact funds an AutoPlan may use for its next atomic execution.
 * Claimable SOL counts only after explicit on-chain reinvest consent; the
 * frontend wallet budget must continue to exclude it until confirmation.
 */
export function autoPlanExecutionFunding({ rewardMode, balanceLamports, pendingSol, requiredLamports }) {
  const mode = Number(rewardMode);
  assert.ok(Number.isInteger(mode) && mode >= 0 && mode <= 3, 'Auto-plan reward mode is invalid');
  const reinvestSol = (mode & AUTO_PLAN_REINVEST_SOL_FLAG) !== 0;
  const balance = asBigInt(balanceLamports, 'Auto-plan balance');
  const pending = reinvestSol ? asBigInt(pendingSol, 'Claimable SOL') : 0n;
  const required = asBigInt(requiredLamports, 'Auto-plan round cost');
  return {
    reinvestSol,
    pendingSol: pending,
    availableLamports: balance + pending,
    executable: balance + pending >= required,
  };
}

/**
 * Put a hard wall-clock boundary around an external operation. The caller may
 * additionally abort the underlying request, but the timeout itself never
 * relies on a cooperative RPC/HTTP implementation.
 */
export async function withOperationTimeout(operation, {
  timeoutMs,
  label,
  onTimeout = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  assert.equal(typeof operation, 'function', 'Timed operation callback is required');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Operation timeout must be positive');
  assert.ok(typeof label === 'string' && label, 'Operation timeout label is required');
  let timer = null;
  let completed = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => {
      if (completed) return;
      const error = new Error(`${label} exceeded ${timeoutMs}ms`);
      error.code = OPERATION_TIMEOUT_CODE;
      try {
        onTimeout(error);
      } catch (timeoutError) {
        reject(timeoutError);
        return;
      }
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    completed = true;
    if (timer !== null) clearTimer(timer);
  }
}

export async function fetchActiveAutoPlanAuthorities({
  indexedRows,
  pageSize = 250,
  maxPages = 100,
  operationTimeoutMs = 8_000,
}) {
  assert.equal(typeof indexedRows, 'function', 'indexedRows callback is required');
  const size = boundedInteger(pageSize, 250, 1, 1_000);
  const pages = boundedInteger(maxPages, 100, 1, 1_000);
  const timeout = boundedInteger(operationTimeoutMs, 8_000, 500, 30_000);
  const authorities = new Set();
  for (let page = 0; page < pages; page += 1) {
    const offset = page * size;
    const rows = await withOperationTimeout(
      () => indexedRows(
        `mine_auto_plans?active=eq.true&or=(balance_lamports.gt.0,reward_mode.gte.2)&select=authority&order=authority.asc&limit=${size}&offset=${offset}`,
      ),
      { timeoutMs: timeout, label: `Auto-plan index page ${page + 1}` },
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

export async function sendAutoPlanBatchesIsolated({
  entries,
  batchSize,
  sendBatch,
  canSend = async () => true,
  operationTimeoutMs = 12_000,
  sendTimeoutMs = operationTimeoutMs,
  onEvent = () => {},
}) {
  const size = boundedInteger(batchSize, 4, 1, 6);
  const timeout = boundedInteger(operationTimeoutMs, 12_000, 500, 30_000);
  const sendTimeout = boundedInteger(sendTimeoutMs, timeout, 500, 60_000);
  const sendIsolated = async (batch) => {
    if (!(await withOperationTimeout(canSend, {
      timeoutMs: timeout,
      label: 'Auto-plan betting-window check',
    }))) {
      onEvent({ event: 'auto-plan-window-closed', skipped: batch.length });
      return;
    }
    try {
      const sent = await withOperationTimeout(() => sendBatch(batch), {
        timeoutMs: sendTimeout,
        label: `Auto-plan batch (${batch.length})`,
      });
      onEvent({
        event: 'auto-plans-executed',
        authorities: batch.map(({ authority }) => authority),
        signature: sent?.signature ?? null,
        measuredUnits: sent?.measuredUnits,
        computeLimit: sent?.computeLimit,
      });
      return;
    } catch (error) {
      // A timed-out send has an indeterminate landing status. Do not bisect and
      // immediately resubmit it; the next window pass first reloads every plan
      // from chain and the on-chain last_round guard decides what remains.
      if (error?.code === OPERATION_TIMEOUT_CODE) {
        onEvent({
          event: 'auto-plan-batch-indeterminate',
          authorities: batch.map(({ authority }) => authority),
          error: error.message,
        });
        return;
      }
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
  operationTimeoutMs = process.env.AUTO_PLAN_OPERATION_TIMEOUT_MS || 8_000,
  sendTimeoutMs = process.env.AUTO_PLAN_SEND_TIMEOUT_MS || 30_000,
  onEvent = () => {},
}) {
  const retryDelay = boundedInteger(retryMs, 5_000, 500, 15_000);
  const concurrency = boundedInteger(buildConcurrency, 12, 1, 32);
  const timeout = boundedInteger(operationTimeoutMs, 8_000, 500, 30_000);
  const sendTimeout = boundedInteger(sendTimeoutMs, 30_000, 2_000, 60_000);
  const readNow = () => withOperationTimeout(nowSeconds, {
    timeoutMs: timeout,
    label: 'Auto-plan chain time',
  });
  while (await readNow() < bettingEndsAt) {
    try {
      const authorities = await fetchActiveAutoPlanAuthorities({
        indexedRows,
        operationTimeoutMs: timeout,
      });
      const built = await mapConcurrent(authorities, concurrency, async (authority) => (
        withOperationTimeout(() => buildEntry({ authority }), {
          timeoutMs: timeout,
          label: `Auto-plan account ${authority}`,
        })
      ));
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
      await sendAutoPlanBatchesIsolated({
        entries: executable,
        batchSize,
        sendBatch,
        canSend: async () => await readNow() < bettingEndsAt,
        operationTimeoutMs: timeout,
        sendTimeoutMs: sendTimeout,
        onEvent,
      });
    } catch (error) {
      onEvent({
        event: 'auto-plan-index-unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const remainingMs = (bettingEndsAt - await readNow()) * 1_000;
    if (remainingMs <= 0) break;
    await sleep(Math.min(retryDelay, Math.max(100, remainingMs)));
  }
}
