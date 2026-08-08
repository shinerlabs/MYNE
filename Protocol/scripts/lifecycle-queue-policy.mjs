const WINDOW_SIZE = 25;

function roundId(value) {
  const parsed = BigInt(String(value));
  if (parsed < 0n) throw new RangeError('Lifecycle round ids must be non-negative');
  return parsed.toString();
}

/**
 * A descending keyset walk eventually visits every unclosed round without an
 * unbounded offset or account scan. Returning to a null cursor starts the next
 * pass at the newest round.
 */
export function historicalLifecycleQuery(cursor = null) {
  const before = cursor === null ? '' : `&round_id=lt.${roundId(cursor)}`;
  return `mine_rounds?closed_signature=is.null${before}&select=*&order=round_id.desc&limit=${WINDOW_SIZE}`;
}

export function nextHistoricalLifecycleCursor(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.reduce((oldest, row) => {
    const current = BigInt(roundId(row.round_id));
    return current < oldest ? current : oldest;
  }, BigInt(roundId(rows[0].round_id))).toString();
}

/**
 * Queue order is priority order. A round returned by more than one bounded
 * query is processed once per tick using the first (highest-priority) row.
 */
export function mergeLifecycleRoundQueues(...queues) {
  const byRound = new Map();
  let invalidRow = 0;
  for (const queue of queues) {
    for (const row of queue || []) {
      // Preserve malformed rows as isolated failures instead of letting queue
      // construction abort all otherwise valid receipt processing.
      const key = row?.round_id === undefined || row?.round_id === null
        ? `invalid:${invalidRow += 1}`
        : String(row.round_id);
      if (!byRound.has(key)) byRound.set(key, row);
    }
  }
  return [...byRound.values()];
}

/**
 * Select a bounded, fair slice from the independent lifecycle queues. Large historical recovery
 * sets must not consume every RPC request in one tick, while current receipts, unprocessed rewards,
 * archive cleanup and randomness retention must each continue to make progress.
 */
export function selectLifecycleRoundBatch(limit, ...queues) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError('Lifecycle round batch limit must be a positive integer');
  }
  const selected = new Map();
  const offsets = queues.map(() => 0);
  let advanced = true;
  while (selected.size < limit && advanced) {
    advanced = false;
    for (let queueIndex = 0; queueIndex < queues.length && selected.size < limit; queueIndex += 1) {
      const queue = queues[queueIndex] || [];
      while (offsets[queueIndex] < queue.length) {
        const row = queue[offsets[queueIndex]];
        offsets[queueIndex] += 1;
        advanced = true;
        const key = row?.round_id === undefined || row?.round_id === null
          ? `invalid:${queueIndex}:${offsets[queueIndex]}`
          : String(row.round_id);
        if (selected.has(key)) continue;
        selected.set(key, row);
        break;
      }
    }
  }
  return [...selected.values()];
}

export async function processLifecycleRoundQueue(rows, processor) {
  const results = [];
  for (const row of rows) {
    try {
      results.push(await processor(row));
    } catch (error) {
      results.push({
        round: String(row?.round_id ?? 'unknown'),
        state: 'round-processing-error',
        message: String(error),
      });
    }
  }
  return results;
}
