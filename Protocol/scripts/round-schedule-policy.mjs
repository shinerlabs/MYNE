import assert from 'node:assert/strict';

// Must mirror `PROVIDER_PREPARATION_LEAD_SECONDS` in the on-chain program. The
// production host validates it against v6's configured 60-second betting
// duration before starting any transaction worker.
export const PROVIDER_PREPARATION_LEAD_SECONDS = 60;

/**
 * Round workers that must exist at a given scheduled timestamp.
 *
 * The active round is always included for restart/recovery. Once the bounded
 * provider preparation window begins, the next round is included too. This is
 * what lets its commitment be bound while the active round is still betting,
 * without moving either round's scheduled `opened_at`.
 */
export function roundIdsToPrepare({
  now,
  initializedAt,
  roundDurationSeconds,
  preparationLeadSeconds = PROVIDER_PREPARATION_LEAD_SECONDS,
}) {
  for (const [name, value] of Object.entries({
    now, initializedAt, roundDurationSeconds, preparationLeadSeconds,
  })) {
    assert.ok(Number.isSafeInteger(value), `${name} must be a safe integer`);
  }
  assert.ok(roundDurationSeconds > 0, 'roundDurationSeconds must be positive');
  assert.ok(
    preparationLeadSeconds > 0 && preparationLeadSeconds < roundDurationSeconds,
    'preparationLeadSeconds must be inside one round',
  );
  if (now < initializedAt) return [];

  const currentRound = Math.floor((now - initializedAt) / roundDurationSeconds);
  const roundIds = [currentRound];
  const nextRound = currentRound + 1;
  const nextPreparationStartsAt = initializedAt
    + nextRound * roundDurationSeconds
    - preparationLeadSeconds;
  if (now >= nextPreparationStartsAt) roundIds.push(nextRound);
  return roundIds;
}
