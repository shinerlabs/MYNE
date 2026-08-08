import assert from 'node:assert/strict';

// Must mirror `PROVIDER_PREPARATION_LEAD_SECONDS` in the on-chain program. The
// production host validates it against v6's configured 60-second betting
// duration before starting any transaction worker.
export const PROVIDER_PREPARATION_LEAD_SECONDS = 60;
// Host wall-clock seconds can lead Solana's on-chain Clock by a small amount.
// Enter the existing 60-second preparation window two seconds late rather
// than submitting at its exact boundary; scheduled opened_at is unchanged.
export const PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS = 2;

// Per-round children use distinct process statuses so the supervisor can
// distinguish a harmless paused deferral from an irrecoverably missed window.
export const ROUND_KEEPER_DEFERRED_EXIT_CODE = 75;
export const ROUND_KEEPER_MISSED_EXIT_CODE = 76;

/**
 * First future round that can still be prebound inside the host's safe window.
 *
 * A paused protocol can cross one or more scheduled `opened_at` boundaries
 * without creating their Round PDAs. Resuming those missing identifiers would
 * either shorten betting or ask a keeper to open a round after its advertised
 * start. Instead, select a future identifier whose prebind deadline has not
 * passed. Earlier missing identifiers are an intentional schedule gap.
 */
export function firstSafeResumeRoundId({
  now,
  initializedAt,
  roundDurationSeconds,
  preparationLeadSeconds = PROVIDER_PREPARATION_LEAD_SECONDS,
  preparationSafetyMarginSeconds = PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS,
  nextRoundPrebindGraceSeconds,
}) {
  for (const [name, value] of Object.entries({
    now,
    initializedAt,
    roundDurationSeconds,
    preparationLeadSeconds,
    preparationSafetyMarginSeconds,
    nextRoundPrebindGraceSeconds,
  })) {
    assert.ok(Number.isSafeInteger(value), `${name} must be a safe integer`);
  }
  assert.ok(roundDurationSeconds > 0, 'roundDurationSeconds must be positive');
  assert.ok(
    preparationLeadSeconds > 0 && preparationLeadSeconds < roundDurationSeconds,
    'preparationLeadSeconds must be inside one round',
  );
  assert.ok(
    preparationSafetyMarginSeconds >= 0
      && nextRoundPrebindGraceSeconds > 0
      && preparationSafetyMarginSeconds + nextRoundPrebindGraceSeconds
        < preparationLeadSeconds,
    'Safe resume prebind deadline must fit inside the preparation window',
  );

  if (now < initializedAt) return 0;
  const currentRoundId = Math.floor((now - initializedAt) / roundDurationSeconds);
  const nextRoundId = currentRoundId + 1;
  const nextPrebindDeadline = initializedAt
    + nextRoundId * roundDurationSeconds
    - preparationLeadSeconds
    + preparationSafetyMarginSeconds
    + nextRoundPrebindGraceSeconds;
  return now < nextPrebindDeadline ? nextRoundId : nextRoundId + 1;
}

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
  preparationSafetyMarginSeconds = PROVIDER_PREPARATION_SAFETY_MARGIN_SECONDS,
}) {
  for (const [name, value] of Object.entries({
    now,
    initializedAt,
    roundDurationSeconds,
    preparationLeadSeconds,
    preparationSafetyMarginSeconds,
  })) {
    assert.ok(Number.isSafeInteger(value), `${name} must be a safe integer`);
  }
  assert.ok(roundDurationSeconds > 0, 'roundDurationSeconds must be positive');
  assert.ok(
    preparationLeadSeconds > 0 && preparationLeadSeconds < roundDurationSeconds,
    'preparationLeadSeconds must be inside one round',
  );
  assert.ok(
    preparationSafetyMarginSeconds >= 0
      && preparationSafetyMarginSeconds < preparationLeadSeconds,
    'preparationSafetyMarginSeconds must fit inside the preparation window',
  );
  if (now < initializedAt) return [];

  const currentRound = Math.floor((now - initializedAt) / roundDurationSeconds);
  const roundIds = [currentRound];
  const nextRound = currentRound + 1;
  const nextPreparationStartsAt = initializedAt
    + nextRound * roundDurationSeconds
    - preparationLeadSeconds
    + preparationSafetyMarginSeconds;
  if (now >= nextPreparationStartsAt) roundIds.push(nextRound);
  return roundIds;
}
