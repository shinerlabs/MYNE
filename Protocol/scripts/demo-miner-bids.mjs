const LAMPORTS_PER_MULTIPLIER = 1_000_000n;
const MIN_MULTIPLIER = 10n;
const MULTIPLIER_SPAN = 11n;

/**
 * A restart-safe 10x-20x demo bid shared by every coverage miner in a round.
 *
 * The old keeper randomized every wallet and every tile independently. That
 * made five visually identical all-tile miners carry different winning-tile
 * stakes, so their correctly proportional rewards appeared incorrect. The
 * round id now selects one amount for the whole cohort. It still exercises a
 * different mining value over time without making equal-looking bids unequal.
 */
export function demoCoverageBidLamports(roundId) {
  const id = BigInt(roundId?.toString?.() ?? roundId);
  const multiplier = MIN_MULTIPLIER + ((id * 7n + 3n) % MULTIPLIER_SPAN);
  return Number(multiplier * LAMPORTS_PER_MULTIPLIER);
}

/** Build the controlled coverage miner's tile map for localnet or Devnet. */
export function demoCoverageBids(roundId, minerIndex, isDevnet) {
  const bid = demoCoverageBidLamports(roundId);
  const tileCount = isDevnet ? 5 : 25;
  const firstTile = isDevnet ? Number(minerIndex) * tileCount : 0;
  return Object.fromEntries(Array.from(
    { length: tileCount },
    (_, offset) => [(firstTile + offset) % 25, bid],
  ));
}
