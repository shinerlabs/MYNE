/**
 * Returns the stable cache key for the newest settled round, or null while no confirmed result
 * exists. Live-round activity is deliberately irrelevant: its participants must never replace
 * the complete previous-round miner roster.
 */
export function confirmedMinerRoundKey(lastResolved) {
  if (!lastResolved?.resolved || lastResolved.roundId === undefined || lastResolved.roundId === null) return null;
  return String(lastResolved.roundId);
}

/** Prefer the latest real mining round without hiding empty-round outcomes elsewhere. */
export function confirmedMinerSource(lastResolved, lastPlayedResolved) {
  if (lastPlayedResolved?.resolved) {
    try {
      if (BigInt(lastPlayedResolved.totalWager ?? 0) > 0n) return lastPlayedResolved;
    } catch { /* malformed cached state falls back to the latest settled result */ }
  }
  return lastResolved;
}

/**
 * Raw numeric previous-round helper retained for schedule calculations. The miners panel itself
 * now prefers the latest played settlement so zero-bid rounds cannot hide a participant reward.
 */
export function previousConfirmedRoundId(currentRoundId) {
  const id = BigInt(currentRoundId);
  return id > 0n ? id - 1n : null;
}

export function shouldRefreshConfirmedMiners(
  lastResolved,
  renderedKey,
  requestKey,
  renderedComplete = true,
) {
  const key = confirmedMinerRoundKey(lastResolved);
  if (key === null || key === requestKey) return false;
  if (key === renderedKey) return renderedComplete !== true;
  // A delayed RPC response must never replace a newer roster already rendered from the index.
  if (renderedKey !== '') {
    try { return BigInt(key) > BigInt(renderedKey); } catch { return false; }
  }
  return true;
}

/** An on-chain zero receipt count makes an empty roster authoritative, not a transient read. */
export function isConfirmedEmptyRound(lastResolved) {
  if (!lastResolved?.resolved || lastResolved.totalReceipts === undefined
      || lastResolved.totalReceipts === null) return false;
  try {
    return BigInt(lastResolved.totalReceipts) === 0n;
  } catch {
    return false;
  }
}

/** Keep every confirmed participant, even when the winning tile had no miners. */
export function previousRoundMinerRoster(roundResult) {
  return Array.isArray(roundResult?.miners) ? roundResult.miners : [];
}
