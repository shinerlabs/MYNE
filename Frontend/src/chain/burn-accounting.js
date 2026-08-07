const asBaseUnits = (value) => {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return BigInt(value);
};

const completedRound = (value) => {
  const round = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
  return round?.resolved === true && round?.buyback_completed === true;
};

/**
 * Sum only indexed burns whose round has reached the on-chain
 * `BuybackCompleted` state. Invalid or duplicate evidence fails closed.
 */
export function sumCompletedBuybackBurnRows(rows) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  let total = 0n;
  for (const row of rows) {
    const roundId = asBaseUnits(row?.round_id);
    const sequence = asBaseUnits(row?.sequence);
    const burned = asBaseUnits(row?.burned_base_units);
    const signature = typeof row?.burn_signature === 'string' ? row.burn_signature.trim() : '';
    if (roundId === null || sequence === null || burned === null || burned === 0n
      || !signature || !completedRound(row?.mine_rounds)) return null;
    const key = `${roundId}:${sequence}`;
    if (seen.has(key)) return null;
    seen.add(key);
    total += burned;
  }
  return total;
}

/**
 * Reconcile the two named burn sources against the mint's actual supply loss.
 * This prevents a stale/malformed index from presenting an apparently precise
 * burn total. Any unattributed token burn remains unavailable until indexed.
 */
export function reconcileBurnTotals({
  totalEmittedBaseUnits,
  currentSupplyBaseUnits,
  stakingBurnBaseUnits,
  completedBuybackBurnBaseUnits,
}) {
  const emitted = asBaseUnits(totalEmittedBaseUnits);
  const current = asBaseUnits(currentSupplyBaseUnits);
  const staking = asBaseUnits(stakingBurnBaseUnits);
  const buyback = asBaseUnits(completedBuybackBurnBaseUnits);
  if ([emitted, current, staking, buyback].some((value) => value === null)) return null;
  if (current > emitted) return null;
  const burned = staking + buyback;
  if (burned !== emitted - current) return null;
  return {
    current,
    supplied: emitted,
    burned,
    burnedStaking: staking,
    burnedBuyback: buyback,
  };
}
