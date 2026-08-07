const GRID = 25;
const toBig = (value) => BigInt(value?.toString?.() ?? value ?? 0);

/**
 * Reduce receipt accounts into the previous-round miner roster.
 *
 * Auto-burn styling is derived only from the immutable reward mode committed
 * in an on-chain receipt. Hostname/demo heuristics would let the interface
 * claim a wallet was burning when its reward was actually accumulating.
 */
export function aggregateMiners(receiptRows) {
  const grouped = new Map();
  for (const { account } of receiptRows) {
    if (account.refunded) continue;
    const address = account.authority.toBase58();
    const miner = grouped.get(address) ?? {
      address,
      tileBets: Array(GRID).fill(0n),
      deployed: 0n,
      receiptCount: 0,
      claimed: true,
      autoRound: false,
      autoBurn: false,
      autoMode: 'accumulate',
    };
    account.amounts.forEach((amount, index) => { miner.tileBets[index] += toBig(amount); });
    miner.deployed += toBig(account.totalLamports);
    miner.receiptCount += 1;
    miner.claimed = miner.claimed && Boolean(account.claimed);
    if (Number(account.rewardMode?.toString?.() ?? account.rewardMode ?? 0) === 1) {
      miner.autoRound = true;
      miner.autoBurn = true;
      miner.autoMode = 'burn';
    }
    grouped.set(address, miner);
  }
  return [...grouped.values()]
    .map((miner) => ({ ...miner, tiles: miner.tileBets.filter((amount) => amount > 0n).length }))
    .sort((a, b) => a.deployed === b.deployed
      ? a.address.localeCompare(b.address)
      : (a.deployed > b.deployed ? -1 : 1));
}
