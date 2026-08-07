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

