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

/** One full-number formatter for every APY surface, including the header pill. */
export const formatApyPercent = (value) => {
  if (!Number.isFinite(value) || value < 0) return '—';
  return value >= 1000
    ? `${Math.round(value).toLocaleString()}%`
    : `${value.toFixed(1)}%`;
};

/** Explicitly named tier values prevent an unlabeled 5× number appearing as generic APY. */
export const stakingApyVariants = (standardApyPct) => ({
  standard: Number.isFinite(standardApyPct) && standardApyPct >= 0 ? standardApyPct : null,
  burn: Number.isFinite(standardApyPct) && standardApyPct >= 0 ? standardApyPct * 5 : null,
});

/**
 * Small, deployment-local snapshot used only while the protocol is paused.
 * Keeping this separate from the live metric object prevents a maintenance
 * period from silently changing the last APY users saw before mining stopped.
 */
export const stakingApySnapshot = (metrics, capturedAt = metrics?.capturedAt ?? Date.now()) => {
  if (!metrics || !Number.isFinite(metrics.apyStandardPct) || metrics.apyStandardPct < 0
    || !Number.isFinite(metrics.apyBurnPct) || metrics.apyBurnPct < 0
    || !Number.isSafeInteger(capturedAt) || capturedAt <= 0) return null;
  const snapshot = {
    apyStandardPct: metrics.apyStandardPct,
    apyBurnPct: metrics.apyBurnPct,
    aprWindowDays: Number.isFinite(metrics.aprWindowDays) ? metrics.aprWindowDays : 0,
    aprWindowRounds: Number.isSafeInteger(metrics.aprWindowRounds) ? metrics.aprWindowRounds : 0,
    aprAsOf: Number.isSafeInteger(metrics.aprAsOf) ? metrics.aprAsOf : null,
    capturedAt,
  };
  // Retain the exact valuation/run-rate inputs that produced the visible APY.
  // They let position estimates remain consistent through a protocol pause or
  // a temporary index outage instead of substituting a made-up return.
  if (finitePositive(metrics.totalWeight)) snapshot.totalWeight = metrics.totalWeight;
  if (Number.isFinite(metrics.rewardsToStakersEth) && metrics.rewardsToStakersEth >= 0) {
    snapshot.rewardsToStakersEth = metrics.rewardsToStakersEth;
  }
  if (finitePositive(metrics.mynePerSol)) snapshot.mynePerSol = metrics.mynePerSol;
  return snapshot;
};

/** Keep the last displayed APY only for the same final reward window. */
export const selectPausedApySnapshot = (currentMetrics, previousSnapshot) => {
  if (currentMetrics?.protocolPaused !== true) return null;
  const current = stakingApySnapshot(currentMetrics);
  const previous = stakingApySnapshot(previousSnapshot);
  // Pausing stops new mining rows. If the index can no longer prove a fresh
  // 30-minute window during maintenance, retain the last value that was
  // successfully validated for this network/program instead of replacing it
  // with the misleading "< 30M" pending state.
  if (!current) return previous;
  return previous?.aprAsOf === current?.aprAsOf ? previous : current;
};

/**
 * Resolve the one APY value every public surface may display. During a pause,
 * the last verified snapshot for the same reward window wins; while live, the
 * current read passes through unchanged.
 */
export const resolveStakingApyDisplay = (currentMetrics, previousSnapshot) => {
  const snapshot = selectPausedApySnapshot(currentMetrics, previousSnapshot);
  return {
    snapshot,
    metrics: snapshot
      ? {
        ...currentMetrics,
        ...snapshot,
        aprPct: snapshot.apyStandardPct,
        aprStatus: 'paused',
      }
      : currentMetrics,
  };
};

/** A personal position has no meaningful APY until it has positive principal and weight. */
export const positionApyPercent = (standardApyPct, principalMyne, weightMyne) => {
  if (!Number.isFinite(standardApyPct) || standardApyPct < 0
    || !finitePositive(principalMyne) || !finitePositive(weightMyne)) return null;
  const value = standardApyPct * (weightMyne / principalMyne);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

/**
 * Estimate a position's SOL rewards from the same verified pool run-rate used
 * by the APY display. Burn stake is represented by its on-chain weight, so the
 * calculation naturally respects the 5x tier without applying it twice.
 */
export const positionRewardEstimate = ({
  standardApyPct,
  principalMyne,
  weightMyne,
  totalWeightMyne,
  poolRewardsPerDaySol,
  mynePerSol,
  days = 7,
}) => {
  const positionApyPct = positionApyPercent(standardApyPct, principalMyne, weightMyne);
  if (positionApyPct == null
    || !Number.isSafeInteger(days) || days < 1 || days > 365) return null;
  const hasPoolShare = finitePositive(totalWeightMyne) && weightMyne <= totalWeightMyne;
  const poolShare = hasPoolShare ? weightMyne / totalWeightMyne : null;
  const hasPoolRunRate = finitePositive(poolShare)
    && Number.isFinite(poolRewardsPerDaySol) && poolRewardsPerDaySol >= 0;
  const rewardSol = hasPoolRunRate
    ? poolRewardsPerDaySol * poolShare * days
    : finitePositive(mynePerSol)
      ? (principalMyne / mynePerSol) * (positionApyPct / 100) * (days / 365)
      : null;
  if (!Number.isFinite(rewardSol) || rewardSol < 0) return null;
  return {
    days,
    rewardSol,
    poolSharePct: poolShare == null ? null : poolShare * 100,
    positionApyPct,
    source: hasPoolRunRate ? 'pool' : 'apy',
  };
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
 * including zero-volume rounds, unresolved rows and rows whose fee event has not been indexed.
 * Production indexing writes the scheduled zero-volume rows, so a missing/duplicate id, missing
 * fee, stale watermark, malformed timestamp or negative amount makes the result unavailable.
 */
export function summariseStakingRewardWindow(
  rows,
  {
    start, end, windowMinutes, roundCadenceSeconds, maxRows = 1000,
    observedAt = end, watermarkSettlesAt = end,
    maxStalenessSeconds = roundCadenceSeconds * 3,
    maxSettlementGapSeconds = roundCadenceSeconds + 5,
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
    || !Number.isSafeInteger(maxSettlementGapSeconds) || maxSettlementGapSeconds <= 0
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
        || (previousRoundId !== null && roundId !== previousRoundId + 1n)
        || (previousSettlesAt !== null && settlesAt <= previousSettlesAt)) {
        return incompleteWindow(windowMinutes, rows.length);
      }
      // Indexed settlement time may not silently skip a scheduled fee-bearing interval. A gap
      // larger than one cadence plus clock/confirmation tolerance fails closed.
      if (previousSettlesAt !== null && settlesAt - previousSettlesAt > maxSettlementGapSeconds) {
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

  // The final row must be the selected watermark and the first scheduled settlement must cover
  // the left edge. This rejects both a truncated query and an omitted edge row.
  const complete = lastSettlesAt === watermarkSettlesAt
    && firstSettlesAt < start + maxSettlementGapSeconds;
  return {
    complete,
    windowMinutes,
    rewardLamports: complete ? rewardLamports : 0n,
    rounds: rows.length,
    firstSettlesAt,
    lastSettlesAt,
  };
}

/**
 * Return the newest exact reward window from a bounded chronological index read.
 *
 * Pausing can expose an older index gap inside the latest 30 minutes. Walking
 * backwards is safe only because every candidate is still passed through the
 * same strict consecutive-round, fee-event and time-coverage validator used by
 * the live metric. Missing rows are never interpreted as zero rewards.
 */
export function selectLatestCompleteStakingRewardWindow(
  rows,
  {
    windowMinutes,
    roundCadenceSeconds,
    observedAt,
    maxRows = 1000,
  },
) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length >= maxRows
    || !Number.isFinite(windowMinutes) || !(windowMinutes > 0)
    || !Number.isSafeInteger(roundCadenceSeconds) || roundCadenceSeconds <= 0
    || !Number.isSafeInteger(observedAt)) return null;

  const windowSeconds = Math.round(windowMinutes * 60);
  for (let endIndex = rows.length - 1; endIndex >= 0; endIndex -= 1) {
    const end = Number(rows[endIndex]?.settles_at);
    if (!Number.isSafeInteger(end) || end > observedAt) continue;
    const start = end - windowSeconds;
    let startIndex = endIndex;
    while (startIndex > 0 && Number(rows[startIndex - 1]?.settles_at) >= start) startIndex -= 1;
    const candidate = rows.slice(startIndex, endIndex + 1);
    const summary = summariseStakingRewardWindow(candidate, {
      start,
      end,
      windowMinutes,
      roundCadenceSeconds,
      maxRows,
      observedAt,
      watermarkSettlesAt: end,
      maxStalenessSeconds: Number.MAX_SAFE_INTEGER,
      maxSettlementGapSeconds: roundCadenceSeconds + 5,
    });
    if (summary.complete) return summary;
  }
  return null;
}

/**
 * Prefer the exact requested window, then fall back to the newest contiguous
 * run of fully resolved fee rows. A gap shortens the observed period; it is
 * never silently counted as a zero-reward round. This keeps the displayed APY
 * responsive after an index/keeper interruption while preserving an honest,
 * auditable denominator for the estimate.
 */
export function selectLatestVerifiedStakingRewardWindow(
  rows,
  {
    windowMinutes,
    roundCadenceSeconds,
    observedAt,
    maxRows = 1000,
    minimumFallbackRounds = 1,
  },
) {
  const exact = selectLatestCompleteStakingRewardWindow(rows, {
    windowMinutes, roundCadenceSeconds, observedAt, maxRows,
  });
  if (exact) return { ...exact, isPartial: false };
  if (!Array.isArray(rows) || rows.length === 0 || rows.length >= maxRows
    || !Number.isFinite(windowMinutes) || !(windowMinutes > 0)
    || !Number.isSafeInteger(roundCadenceSeconds) || roundCadenceSeconds <= 0
    || !Number.isSafeInteger(observedAt)
    || !Number.isSafeInteger(minimumFallbackRounds) || minimumFallbackRounds < 1) return null;

  const targetSeconds = Math.round(windowMinutes * 60);
  const maxSettlementGapSeconds = roundCadenceSeconds + 5;
  const accepted = [];
  let expectedRoundId = null;
  let laterSettlesAt = null;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const roundId = unsignedInteger(row?.round_id);
    const settlesAt = Number(row?.settles_at);
    const reward = unsignedInteger(row?.staking_net_lamports);
    const valid = roundId !== null && reward !== null && row?.resolved === true
      && Number.isSafeInteger(settlesAt) && settlesAt <= observedAt;
    if (!valid) {
      if (accepted.length) break;
      continue;
    }
    if (expectedRoundId !== null && roundId + 1n !== expectedRoundId) break;
    if (laterSettlesAt !== null) {
      const gap = laterSettlesAt - settlesAt;
      if (gap <= 0 || gap > maxSettlementGapSeconds) break;
    }
    accepted.push({ settlesAt, reward });
    expectedRoundId = roundId;
    laterSettlesAt = settlesAt;
    if (accepted.length * roundCadenceSeconds >= targetSeconds) break;
  }

  if (accepted.length < minimumFallbackRounds) return null;
  accepted.reverse();
  const firstSettlesAt = accepted[0].settlesAt;
  const lastSettlesAt = accepted.at(-1).settlesAt;
  const observedSeconds = Math.min(targetSeconds, accepted.length * roundCadenceSeconds);
  const effectiveWindowMinutes = observedSeconds / 60;
  return {
    complete: true,
    windowMinutes: effectiveWindowMinutes,
    requestedWindowMinutes: windowMinutes,
    rewardLamports: accepted.reduce((total, row) => total + row.reward, 0n),
    rounds: accepted.length,
    firstSettlesAt,
    lastSettlesAt,
    isPartial: effectiveWindowMinutes < windowMinutes,
  };
}
