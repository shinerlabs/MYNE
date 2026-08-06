/**
 * Returns the stable cache key for the newest settled round, or null while no confirmed result
 * exists. Live-round activity is deliberately irrelevant: its participants must never replace
 * the complete previous-round miner roster.
 */
export function confirmedMinerRoundKey(lastResolved) {
  if (!lastResolved?.resolved || lastResolved.roundId === undefined || lastResolved.roundId === null) return null;
  return String(lastResolved.roundId);
}

/**
 * The miners panel is always the immediately preceding settled round.  Round ids are raw
 * zero-based contract ids; callers should use this helper instead of carrying the id observed
 * before a rollover (which can be several rounds stale after a sleeping tab resumes).
 */
export function previousConfirmedRoundId(currentRoundId) {
  const id = BigInt(currentRoundId);
  return id > 0n ? id - 1n : null;
}

export function shouldRefreshConfirmedMiners(lastResolved, renderedKey, requestKey) {
  const key = confirmedMinerRoundKey(lastResolved);
  return key !== null && key !== renderedKey && key !== requestKey;
}

/** Keep every confirmed participant, even when the winning tile had no miners. */
export function previousRoundMinerRoster(roundResult) {
  return Array.isArray(roundResult?.miners) ? roundResult.miners : [];
}
