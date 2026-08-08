const asBaseUnits = (value) => {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return BigInt(value);
};

/**
 * Adapt the single aggregate row exposed by the public burn read model.
 * A zero-row state is valid; every other internally inconsistent shape fails.
 */
export function completedBuybackBurnFromStatsRow(row) {
  if (!row || typeof row !== 'object') return null;
  const burned = asBaseUnits(row.completed_buyback_burn_base_units_text);
  const executions = asBaseUnits(row.completed_buyback_executions);
  const latest = row.latest_completed_buyback_round === null
    ? null
    : asBaseUnits(row.latest_completed_buyback_round);
  if (burned === null || executions === null) return null;
  if (executions === 0n) return burned === 0n && latest === null ? 0n : null;
  if (burned === 0n || latest === null) return null;
  return burned;
}

/** Combine the two protocol-defined burn sources without lossy number casts. */
export function combineBurnTotals({
  currentSupplyBaseUnits,
  stakingBurnBaseUnits,
  completedBuybackBurnBaseUnits,
}) {
  const current = asBaseUnits(currentSupplyBaseUnits);
  const staking = asBaseUnits(stakingBurnBaseUnits);
  const buyback = asBaseUnits(completedBuybackBurnBaseUnits);
  if ([current, staking, buyback].some((value) => value === null)) return null;
  const burned = staking + buyback;
  return {
    current,
    supplied: current + burned,
    burned,
    burnedStaking: staking,
    burnedBuyback: buyback,
  };
}

/**
 * Build an independently available supply snapshot. A missing buyback index must not hide the
 * hard cap or the mint's live SPL supply; it only makes the combined burn total incomplete.
 */
export function assembleSupplySnapshot({
  maxTokenUnits,
  currentSupplyBaseUnits,
  stakingBurnBaseUnits,
  completedBuybackBurnBaseUnits,
}) {
  const maxTokens = asBaseUnits(maxTokenUnits);
  if (maxTokens === null) return null;
  const max = maxTokens * 1_000_000_000n;
  const current = asBaseUnits(currentSupplyBaseUnits);
  const burnedStaking = asBaseUnits(stakingBurnBaseUnits);
  const burnedBuyback = asBaseUnits(completedBuybackBurnBaseUnits);
  const completeBurn = burnedStaking !== null && burnedBuyback !== null;
  const burned = completeBurn ? burnedStaking + burnedBuyback : null;
  return {
    max,
    current,
    supplied: current !== null && burned !== null ? current + burned : null,
    burned,
    burnedStaking,
    burnedBuyback,
  };
}

/** Format exact 9-decimal MYNE base units without converting a u64 through Number. */
export function formatMyneBaseUnits(value, maxFractionDigits = 3) {
  const amount = asBaseUnits(value);
  if (amount === null || !Number.isInteger(maxFractionDigits) || maxFractionDigits < 0 || maxFractionDigits > 9) return null;
  const scale = 1_000_000_000n;
  const whole = amount / scale;
  if (maxFractionDigits === 0) return whole.toLocaleString();
  const fraction = (amount % scale)
    .toString()
    .padStart(9, '0')
    .slice(0, maxFractionDigits)
    .replace(/0+$/, '');
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ''}`;
}
