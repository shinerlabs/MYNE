/** Build an inclusive round-id scan in the caller's requested direction. */
export function roundIdsForRange(fromId, toId, maxScan = 2000) {
  let start = BigInt(fromId);
  const end = BigInt(toId);
  if (start < 0n) start = 0n;
  if (maxScan <= 0) return { ids: [], truncated: start !== end };
  const step = start <= end ? 1n : -1n;
  const ids = [];
  for (let id = start; ids.length < maxScan; id += step) {
    ids.push(id);
    if (id === end) break;
  }
  return { ids, truncated: ids.at(-1) !== end };
}
