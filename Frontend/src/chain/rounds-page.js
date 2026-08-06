import { readRoundsRange, readWinnerCounts, readMyClaimStatus, readExpectedRewards, readRoundIndexAtResolve, countUnknownClaimStatus } from './lottery.js';
import { roundIdAt, roundEnd } from './round.js';
import { loadIndexedRounds, loadSettledRounds } from './rounds-index.js';

const WAD = 10n ** 18n;

/**
 * Real round history for the Rounds page — the FULL history, paginated.
 *
 * Every elapsed round (0 .. current-1) is scanned so numbering is continuous and the metrics
 * summarise all of history, not just a recent window. The display is paginated (newest first)
 * so the DOM never holds hundreds of rows at once; only the visible page is enriched with
 * winner counts + this account's claim status.
 *
 * Round states:
 *   settled     someone bet and the keeper resolved it — a real result
 *   no-bets     nobody wagered; the keeper skips these, pot carries forward
 *   resolving   bets are in but not yet settled — transient, seconds only
 *
 * A short-lived cache of the raw scan means paging/filtering doesn't re-scan the chain on every
 * click; it refreshes when the round advances or the cache ages past STALE_MS.
 */
export const ROUND_PAGE_SIZE = 12;
const STALE_MS = 3000;

let cache = { all: [], fetchedAt: 0, current: -1n, truncated: false };

const decorate = (r) => {
  const status = r.totalWager === 0n ? 'no-bets' : r.resolved ? 'settled' : 'resolving';
  // A jackpot hit is the headline; otherwise the 50/50 flip decides solo vs split. Empty/
  // unsettled rounds have no outcome. Drives both the badge and the filter buttons.
  const mode = status !== 'settled' ? status
    : r.jackpotHit ? 'motherlode' : r.singleMinerRound ? 'solo' : 'split';
  return { ...r, status, mode, endsAt: roundEnd(r.roundId) };
};

const matchesFilter = (r, filter) => filter === 'all'
  || (filter === 'mined' ? r.status === 'settled' : r.mode === filter);

/**
 * @returns {{rows, page, pages, total, filteredTotal, truncated, summary}}
 *   rows          the enriched rounds for the requested page (newest first)
 *   page/pages    clamped current page and total page count for the active filter
 *   total         count of all elapsed rounds (unfiltered)
 *   summary       totals across ALL rounds (not just the page)
 */
/**
 * Every unclaimed win across all history, for the claimable panel + claim-all.
 *
 * Amounts are PER-USER (this account's share), NOT the round's total pot:
 * SOL = bet * payoutMulWad / WAD, BULLION = getExpectedReward (handles solo/split). Using round
 * totals here would overstate a split win.
 *
 * `settled` needs only {roundId, winningSquare, payoutMulWad, singleMinerRound} — which both the
 * chain scan and the Supabase index can supply, so the two paths share this verbatim.
 */
async function buildClaimable(settled, mine, account) {
  const base = account
    ? settled.filter((r) => {
        const m = mine.get(String(r.roundId));
        return m && m.myBet > 0n && !m.claimed;
      })
    : [];
  if (!base.length) return [];
  // getExpectedReward gives each round's per-user BULLION; winner counts let the UI explain a
  // split ("your share of N winners") vs a solo win. Both only for the claimable set.
  const [expected, claimCounts, resolveIndex] = await Promise.all([
    readExpectedRewards(base, account),
    readWinnerCounts(base),
    // Needed to value the passive MYNE these rounds have accrued since they resolved — see
    // `passiveOnRounds`. Without it a never-claimed account shows 0.000 passive forever.
    readRoundIndexAtResolve(base),
  ]);
  return base.map((r) => {
    const myBet = mine.get(String(r.roundId)).myBet;
    const winners = claimCounts.get(String(r.roundId)) ?? 0n;
    return {
      ...r,
      myBet,
      claimed: false,
      winners,
      // Split round paying more than one miner — the amount shown is this account's slice.
      sharedWith: !r.singleMinerRound && winners > 1n ? winners : 0n,
      userEth: (myBet * r.payoutMulWad) / WAD,
      userBullion: expected.get(String(r.roundId)) ?? 0n,
      indexAtResolve: resolveIndex.get(String(r.roundId)) ?? 0n,
    };
  });
}

/**
 * Page + summary from the Supabase index, or null if it cannot answer authoritatively.
 *
 * Only the ROUND FACTS come from the index; winner counts and this account's claim status are
 * still read from the chain, because they are per-account state the indexer does not hold.
 * What the index removes is the full `getRound` scan — the part that was capped at 2000 rounds.
 */
async function loadFromIndex({ page, pageSize, account, filter, current }) {
  const indexed = await loadIndexedRounds({ page, pageSize, filter, currentRoundId: current });
  if (!indexed) return null;
  // Scoped to this account's own bets when the index can say — otherwise every settled round.
  const settled = await loadSettledRounds(account);
  if (!settled) return null; // half the data would mean a wrong claimable panel — bail to chain

  const pages = Math.max(1, Math.ceil(indexed.filteredTotal / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  // The query already ran at the requested page; if that page no longer exists (filter changed,
  // history shrank) re-run at the clamped one rather than rendering an empty table.
  const rowsRaw = safePage === page
    ? indexed.rows
    : (await loadIndexedRounds({ page: safePage, pageSize, filter, currentRoundId: current }))?.rows ?? [];

  return { indexed, settled, pages, safePage, slice: rowsRaw.map(decorate) };
}

export async function loadRoundHistory({ page = 0, pageSize = ROUND_PAGE_SIZE, account = null, filter = 'all', force = false } = {}) {
  const current = roundIdAt();
  const now = Date.now();
  const stale = force || current !== cache.current || (now - cache.fetchedAt) > STALE_MS || !cache.all.length;

  const viaIndex = await loadFromIndex({ page, pageSize, account, filter, current });
  if (viaIndex) {
    const { indexed, settled, pages, safePage, slice } = viaIndex;
    const pageSettled = slice.filter((r) => r.status === 'settled');
    const [counts, mine] = await Promise.all([
      readWinnerCounts(pageSettled),
      readMyClaimStatus(settled, account),
    ]);
    const rows = slice.map((r) => ({
      ...r,
      winners: counts.get(String(r.roundId)) ?? 0n,
      myBet: mine.get(String(r.roundId))?.myBet ?? 0n,
      claimed: mine.get(String(r.roundId))?.claimed ?? false,
    }));
    const claimable = await buildClaimable(settled, mine, account);
    return {
      rows,
      // >0 means the claim panel is INCOMPLETE, not that there is nothing to claim. The UI must
      // say so rather than render a confident zero over an unreadable chain.
      claimableUnknown: countUnknownClaimStatus(mine),
      page: safePage,
      pages,
      total: indexed.total,
      filteredTotal: indexed.filteredTotal,
      // The index holds every round, so the chain path's 2000-round scan cap does not apply.
      truncated: false,
      summary: indexed.summary,
      claimable,
    };
  }

  if (stale) {
    if (current > 0n) {
      const { rounds, truncated } = await readRoundsRange(current - 1n, 0n);
      cache = { all: rounds.map(decorate), fetchedAt: now, current, truncated };
    } else {
      cache = { all: [], fetchedAt: now, current, truncated: false };
    }
  }

  const all = cache.all;
  const filtered = filter === 'all' ? all : all.filter((r) => matchesFilter(r, filter));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const slice = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  // Winner counts are display-only, so fetch them for the visible page alone. Claim status,
  // however, must cover ALL settled history — otherwise a winning round on another page would
  // be invisible to the Mine-page "claimable" UI and to claim-all. The same map enriches the
  // page's myBet/claimed, so there's no double fetch.
  const pageSettled = slice.filter((r) => r.status === 'settled');
  const allSettled = all.filter((r) => r.status === 'settled');
  const [counts, mine] = await Promise.all([
    readWinnerCounts(pageSettled),
    readMyClaimStatus(allSettled, account),
  ]);

  const rows = slice.map((r) => ({
    ...r,
    winners: counts.get(String(r.roundId)) ?? 0n,
    myBet: mine.get(String(r.roundId))?.myBet ?? 0n,
    claimed: mine.get(String(r.roundId))?.claimed ?? false,
  }));

  const claimable = await buildClaimable(allSettled, mine, account);

  return {
    rows,
    claimableUnknown: countUnknownClaimStatus(mine),
    page: safePage,
    pages,
    total: all.length,
    filteredTotal: filtered.length,
    truncated: cache.truncated,
    summary: summarise(all),
    claimable,
  };
}

/**
 * `count` is every elapsed round (including empty ones) so it matches the round numbering;
 * `mined` counts only rounds that actually had bets, which is the more meaningful figure.
 */
export function summarise(rounds) {
  return rounds.reduce((acc, r) => ({
    count: acc.count + 1,
    mined: acc.mined + (r.status === 'settled' ? 1 : 0),
    deployed: acc.deployed + r.totalWager,
    minted: acc.minted + r.bullionForWinners,
    jackpots: acc.jackpots + (r.jackpotHit ? 1 : 0),
  }), { count: 0, mined: 0, deployed: 0n, minted: 0n, jackpots: 0 });
}
