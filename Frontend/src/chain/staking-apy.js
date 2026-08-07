const APY_MINUTES_PER_YEAR = 365 * 24 * 60;

const finitePositive = (value) => Number.isFinite(value) && value > 0;

const unsignedInteger = (value) => {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return null;
};

/**
 * Annualise an observed SOL reward rate against the SOL value of one unit of
 * staking weight. Rewards are paid in SOL while stake is denominated in MYNE;
 * dividing by a raw token count produces a dimensionally invalid percentage.
 */
export const apyPercent = (rewardPerMinuteSol, totalWeightMyne, mynePerSol) => {
  if (!Number.isFinite(rewardPerMinuteSol) || rewardPerMinuteSol < 0
    || !finitePositive(totalWeightMyne) || !finitePositive(mynePerSol)) return null;
  const weightValueSol = totalWeightMyne / mynePerSol;
  if (!finitePositive(weightValueSol)) return null;
  const annualised = (rewardPerMinuteSol * APY_MINUTES_PER_YEAR / weightValueSol) * 100;
  return Number.isFinite(annualised) && annualised >= 0 ? annualised : null;
};

// Backwards-compatible name for callers that still import the original one-minute helper.
export const minuteApyPercent = apyPercent;

const incompleteWindow = (windowMinutes, rows = 0) => ({
  complete: false,
  windowMinutes,
  rewardLamports: 0n,
  rounds: rows,
  firstSettlesAt: null,
  lastSettlesAt: null,
});

/**
 * Validate and sum a public-index reward window without hiding gaps.
 *
 * The query deliberately supplies every scheduled round in the interval,
 * including unresolved rows and rows whose fee event has not been indexed.
 * A missing fee, duplicate/skipped id, stale edge, malformed timestamp or
 * negative amount makes the result unavailable instead of producing a
 * plausible but incomplete headline yield.
 */
export function summariseStakingRewardWindow(
  rows,
  { start, end, windowMinutes, roundCadenceSeconds, maxRows = 1000 },
) {
  if (!Array.isArray(rows) || rows.length === 0 || !Number.isSafeInteger(maxRows)
    || maxRows <= 0 || rows.length >= maxRows
    || !Number.isSafeInteger(start) || start < 0
    || !Number.isSafeInteger(end) || !(end > start)
    || !finitePositive(windowMinutes) || !Number.isSafeInteger(roundCadenceSeconds)
    || roundCadenceSeconds <= 0) {
    return incompleteWindow(windowMinutes, Array.isArray(rows) ? rows.length : 0);
  }

  let rewardLamports = 0n;
  let previousRoundId = null;
  let previousSettlesAt = null;
  let firstSettlesAt = null;
  let lastSettlesAt = null;

  for (const row of rows) {
    try {
      const roundId = unsignedInteger(row?.round_id);
      const settlesAt = Number(row?.settles_at);
      const reward = unsignedInteger(row?.staking_net_lamports);
      if (roundId === null || reward === null || row?.resolved !== true
        || !Number.isSafeInteger(settlesAt) || settlesAt < start || settlesAt > end
        || (previousRoundId !== null && roundId !== previousRoundId + 1n)
        || (previousSettlesAt !== null && settlesAt <= previousSettlesAt)) {
        return incompleteWindow(windowMinutes, rows.length);
      }
      firstSettlesAt ??= settlesAt;
      lastSettlesAt = settlesAt;
      previousRoundId = roundId;
      previousSettlesAt = settlesAt;
      rewardLamports += reward;
    } catch {
      return incompleteWindow(windowMinutes, rows.length);
    }
  }

  // For a complete periodic series, the first/last scheduled settlement is
  // strictly less than one cadence from its window edge. Accepting a whole
  // extra cadence here would let one silently omitted edge row pass as valid.
  const complete = firstSettlesAt < start + roundCadenceSeconds
    && lastSettlesAt > end - roundCadenceSeconds;
  return {
    complete,
    windowMinutes,
    rewardLamports: complete ? rewardLamports : 0n,
    rounds: rows.length,
    firstSettlesAt,
    lastSettlesAt,
  };
}
