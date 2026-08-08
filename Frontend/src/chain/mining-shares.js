const toBigInt = (value) => BigInt(value?.toString?.() ?? value ?? 0);

/**
 * V6 unclaimed MYNE uses an asset/share ledger:
 *   MiningPool.totalUnclaimed       = exact aggregate MYNE liability
 *   MiningPool.rewardPerUnclaimed   = aggregate share supply
 *   Miner.passiveRewardDebt         = the miner's shares
 *
 * JS BigInt keeps the multiplication exact. Invalid or cross-slot snapshots
 * fail closed to zero instead of enabling a claim button from stale cache.
 */
export function miningShareValue(totalAssets, totalShares, minerShares) {
  const assets = toBigInt(totalAssets);
  const shares = toBigInt(totalShares);
  const owned = toBigInt(minerShares);
  if (owned === 0n) return 0n;
  if (assets <= 0n || shares <= 0n || owned > shares) return 0n;
  return (assets * owned) / shares;
}

export function effectiveUnclaimedMyne(miner, miningPool) {
  if (!miner || !miningPool) return 0n;
  return miningShareValue(
    miningPool.totalUnclaimed,
    miningPool.rewardPerUnclaimed,
    miner.passiveRewardDebt,
  );
}

/**
 * Split the authoritative share value into its retained reward basis and the
 * passive increase created by other holders' claim fees.
 *
 * Older v6 accounts used `unclaimedMyne` as a refreshed value cache. Clamping
 * that baseline keeps the upgrade backward-compatible: historical passive
 * value already folded into the cache starts at zero, while every passive fee
 * after the upgrade becomes visible without overstating the claimable total.
 */
export function miningRewardBreakdown(miner, miningPool) {
  const total = effectiveUnclaimedMyne(miner, miningPool);
  if (total === 0n) return { total: 0n, mined: 0n, passive: 0n };
  const cachedBasis = toBigInt(miner?.unclaimedMyne);
  const mined = cachedBasis < 0n ? 0n : cachedBasis > total ? total : cachedBasis;
  return { total, mined, passive: total - mined };
}
