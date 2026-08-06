/**
 * Returns the stable cache key for the newest settled round, or null while no confirmed result
 * exists. Live-round activity is deliberately irrelevant: its participants must never replace
 * the complete previous-round miner roster.
 */
export function confirmedMinerRoundKey(lastResolved) {
  if (!lastResolved?.resolved || lastResolved.roundId === undefined || lastResolved.roundId === null) return null;
  return String(lastResolved.roundId);
}

export function shouldRefreshConfirmedMiners(lastResolved, renderedKey, requestKey) {
  const key = confirmedMinerRoundKey(lastResolved);
  return key !== null && key !== renderedKey && key !== requestKey;
}

/** Keep every confirmed participant, even when the winning tile had no miners. */
export function previousRoundMinerRoster(roundResult) {
  return Array.isArray(roundResult?.miners) ? roundResult.miners : [];
}
