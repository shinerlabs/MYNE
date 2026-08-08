const tokenAmountFromRow = (row) => {
  try {
    return BigInt(row?.account?.data?.parsed?.info?.tokenAmount?.amount ?? 0);
  } catch {
    return null;
  }
};

const keyString = (key) => (typeof key?.toBase58 === 'function' ? key.toBase58() : String(key));

/**
 * Pick a wallet-owned SPL token account that can fund one instruction.
 * Prefer the canonical ATA when it has enough tokens, then fall back to the
 * largest valid account. Token programs cannot combine several source
 * accounts in one transfer, so a split balance is reported explicitly.
 */
export function selectTokenAccountForAmount(rows, requiredAmount, preferredAddress = null) {
  const required = BigInt(requiredAmount?.toString?.() ?? requiredAmount ?? 0);
  const candidates = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ row, amount: tokenAmountFromRow(row) }))
    .filter(({ row, amount }) => row?.pubkey && amount !== null && amount >= required);
  if (!candidates.length) return null;
  const preferred = preferredAddress == null ? null : keyString(preferredAddress);
  const preferredCandidate = candidates.find(({ row }) => keyString(row.pubkey) === preferred);
  if (preferredCandidate) return preferredCandidate.row.pubkey;
  return candidates.reduce((largest, candidate) => (
    candidate.amount > largest.amount ? candidate : largest
  )).row.pubkey;
}

export function tokenAccountBalance(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((total, row) => {
    const amount = tokenAmountFromRow(row);
    return amount === null ? total : total + amount;
  }, 0n);
}
