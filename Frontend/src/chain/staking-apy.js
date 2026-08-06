const APY_MINUTES_PER_YEAR = 365 * 24 * 60;

/** Annualise an observed SOL reward rate against total MYNE principal. */
export const apyPercent = (rewardPerMinuteSol, stakedMyne) => {
  if (!(rewardPerMinuteSol >= 0) || !(stakedMyne > 0)) return null;
  return (rewardPerMinuteSol * APY_MINUTES_PER_YEAR / stakedMyne) * 100;
};

// Backwards-compatible name for callers that still import the original one-minute helper.
export const minuteApyPercent = apyPercent;
