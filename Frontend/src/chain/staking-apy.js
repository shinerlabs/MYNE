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

/** One formatter for every APY surface. `compact` is reserved for the narrow header pill. */
export const formatApyPercent = (value, { compact = false } = {}) => {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (compact && value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k%`;
  return value >= 1000
    ? `${Math.round(value).toLocaleString()}%`
    : `${value.toFixed(1)}%`;
};

/** Explicitly named tier values prevent an unlabeled 5× number appearing as generic APY. */
export const stakingApyVariants = (standardApyPct) => ({
  standard: Number.isFinite(standardApyPct) && standardApyPct >= 0 ? standardApyPct : null,
  burn: Number.isFinite(standardApyPct) && standardApyPct >= 0 ? standardApyPct * 5 : null,
});

/** A personal position has no meaningful APY until it has positive principal and weight. */
export const positionApyPercent = (standardApyPct, principalMyne, weightMyne) => {
  if (!Number.isFinite(standardApyPct) || standardApyPct < 0
    || !finitePositive(principalMyne) || !finitePositive(weightMyne)) return null;
  const value = standardApyPct * (weightMyne / principalMyne);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const incompleteWindow = (windowMinutes, rows = 0) => ({
  complete: false,
  windowMinutes,
  rewardLamports: 0n,
  rounds: rows,
  firstSettlesAt: null,
  lastSettlesAt: null,
});

/**
 * Validate and sum a public-index reward window ending at a fresh resolved watermark.
 *
 * The query deliberately supplies every scheduled round in the interval,
 * including unresolved rows and rows whose fee event has not been indexed. Numeric round-id
 * gaps are valid: a round PDA is not created when nobody mines, so those ids represent zero
 * volume rather than missing rewards. A missing fee, duplicate/out-of-order id, stale watermark,
 * malformed timestamp or negative amount makes the result unavailable.
 */
export function summariseStakingRewardWindow(
  rows,
  {
    start, end, windowMinutes, roundCadenceSeconds, maxRows = 1000,
    observedAt = end, watermarkSettlesAt = end,
    maxStalenessSeconds = roundCadenceSeconds * 3,
  },
) {
  if (!Array.isArray(rows) || rows.length === 0 || !Number.isSafeInteger(maxRows)
    || maxRows <= 0 || rows.length >= maxRows
    || !Number.isSafeInteger(start) || start < 0
    || !Number.isSafeInteger(end) || !(end > start)
    || !finitePositive(windowMinutes) || !Number.isSafeInteger(roundCadenceSeconds)
    || roundCadenceSeconds <= 0 || !Number.isSafeInteger(observedAt)
    || !Number.isSafeInteger(watermarkSettlesAt)
    || !Number.isSafeInteger(maxStalenessSeconds) || maxStalenessSeconds <= 0
    || watermarkSettlesAt !== end || watermarkSettlesAt > observedAt
    || observedAt - watermarkSettlesAt > maxStalenessSeconds) {
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
        || (previousRoundId !== null && roundId <= previousRoundId)
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

  // The query is anchored to the newest fully indexed settlement, so its final row must be
  // that watermark. Quiet time at the beginning of the window is valid zero-volume time.
  const complete = lastSettlesAt === watermarkSettlesAt;
  return {
    complete,
    windowMinutes,
    rewardLamports: complete ? rewardLamports : 0n,
    rounds: rows.length,
    firstSettlesAt,
    lastSettlesAt,
  };
}
