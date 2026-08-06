/**
 * Mirrors claim_receipt's SOL calculation using the prize pool already settled on-chain.
 * The current protocol funds this pool with 88% of gross round deployments after its 12% fee.
 */
export function settledSolReward(prizeLamports, winningStake, winningTotal) {
  const prize = BigInt(prizeLamports);
  const stake = BigInt(winningStake);
  const total = BigInt(winningTotal);
  return stake > 0n && total > 0n ? (prize * stake) / total : 0n;
}

/** Motherlode payouts are shared by every miner in the round, weighted by total deployment. */
export function sharedRoundReward(poolAmount, minerDeployment, roundDeployment) {
  const pool = BigInt(poolAmount);
  const mine = BigInt(minerDeployment);
  const total = BigInt(roundDeployment);
  return pool > 0n && mine > 0n && total > 0n ? (pool * mine) / total : 0n;
}

/**
 * Displays the stored Motherlode plus the current round's pending 1% contribution.
 * The pending amount becomes part of the config PDA only when settlement succeeds, so it must
 * disappear from this projection once the round is settled (where it is either stored or paid).
 */
export function displayedMotherlodeSol(storedLamports, currentGrossLamports, currentRoundSettled) {
  const stored = BigInt(storedLamports);
  const gross = BigInt(currentGrossLamports);
  return stored + (currentRoundSettled ? 0n : (gross * 100n) / 10_000n);
}
