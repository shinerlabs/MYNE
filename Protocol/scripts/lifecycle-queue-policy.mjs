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
