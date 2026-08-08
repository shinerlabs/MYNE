import {
  readRound, readRoundsRange, readWinnerCounts, readMyClaimStatus, readExpectedRewards,
  readRoundIndexAtResolve, countUnknownClaimStatus,
} from './lottery.js';
import { settledSolReward } from './round-rewards.js';
import { roundIdAt, roundEnd, roundState } from './round.js';
import { loadIndexedRounds, loadSettledRounds } from './rounds-index.js';
import { NETWORK } from '../app-config.js';

/**
 * Real round history for the Rounds page — the FULL history, paginated.
 *
 * Every elapsed round (0 .. current-1) is scanned so numbering is continuous and the metrics
 * summarise all of history, not just a recent window. The display is paginated (newest first)
 * so the DOM never holds hundreds of rows at once; only the visible page is enriched with
 * winner counts + this account's claim status.
 *
 * Round states:
 *   settled     keeper published the verifiable result, with or without bids
 *   no-bets     historical/missing round has no published settlement yet
 *   resolving   bets are in but not yet settled — transient, seconds only
 *
 * A short-lived cache of the raw scan means paging/filtering doesn't re-scan the chain on every
 * click; it refreshes when the round advances or the cache ages past STALE_MS.
 */
export const ROUND_PAGE_SIZE = 50;
const STALE_MS = 3000;

let cache = { all: [], fetchedAt: 0, current: -1n, truncated: false };

const decorate = (r) => {
  const status = r.resolved ? 'settled' : r.totalWager === 0n ? 'no-bets' : 'resolving';
  // A resolved zero-bid round has a verifiable tile but no payout mode. A
  // played Motherlode is the headline; otherwise the 50/50 sample decides
  // solo vs split. Drives both the badge and filter buttons.
  const mode = status !== 'settled' ? status
    : r.totalWager === 0n ? 'empty'
      : r.jackpotHit ? 'motherlode' : r.singleMinerRound ? 'solo' : 'split';
  return { ...r, status, mode, endsAt: roundEnd(r.roundId) };
};

const matchesFilter = (r, filter) => filter === 'all'
  || (filter === 'mined' ? r.status === 'settled' && r.totalWager > 0n : r.mode === filter);

/**
 * Convert the exact active Round PDA into the same row shape as indexed history.
 * A missing PDA is not invented as a round; once the provider pre-opens it, the row appears.
 */
export function currentRoundHistoryEntry({ roundId, round, phase, secondsLeft }) {
  if (!round || BigInt(round.requestedAt ?? 0) <= 0n) return null;
  const activeId = BigInt(round.id ?? roundId);
  if (activeId !== BigInt(roundId)) return null;
  const row = decorate({ ...round, roundId: activeId });
  if (row.resolved) return { ...row, isLive: true, phase, secondsLeft };
  const status = phase === 'betting' ? 'live' : 'resolving';
  return { ...row, status, mode: status, isLive: true, phase, secondsLeft };
}

const indexedWindow = (page, pageSize, hasLive) => ({
  offset: hasLive && page > 0 ? page * pageSize - 1 : page * pageSize,
  pageSize: hasLive && page === 0 ? pageSize - 1 : pageSize,
});

async function readCurrentRoundEntry(current) {
  const timing = roundState();
  if (timing.roundId !== current) return null;
  const round = await readRound(current);
  return currentRoundHistoryEntry({
    roundId: current,
    round,
    phase: timing.phase,
    secondsLeft: timing.secondsLeft,
  });
}

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
 * SOL = prize * winning-tile stake / winning-tile total, MYNE = getExpectedReward
 * (handles solo/split). Calculate SOL directly from the settled integers instead of the
 * display/index multiplier: payoutMulWad is a truncated convenience value and can lose lamports
 * when multiplied a second time.
 *
 * `settled` needs only {roundId, winningSquare, potForWinners, winnerTotal, singleMinerRound} — which both the
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
  // getExpectedReward gives each round's per-user MYNE; winner counts let the UI explain a
  // split ("your share of N winners") vs a solo win. Both only for the claimable set.
  const [expected, claimCounts, resolveIndex] = await Promise.all([
    readExpectedRewards(base, account),
    readWinnerCounts(base),
    // Retained for the shared row shape. V6 does not back-date unsettled
    // receipt rewards into historical passive distributions.
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
      userEth: settledSolReward(r.potForWinners, myBet, r.winnerTotal),
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
async function loadFromIndex({ page, pageSize, account, filter, current, liveRound }) {
  const hasLive = filter === 'all' && Boolean(liveRound);
  const loadPage = async (targetPage) => {
    const window = indexedWindow(targetPage, pageSize, hasLive);
    return loadIndexedRounds({
      page: targetPage,
      pageSize: window.pageSize,
      offset: window.offset,
      filter,
      currentRoundId: current,
      excludeRoundId: hasLive ? current : null,
    });
  };
  const indexed = await loadPage(page);
  if (!indexed) return null;
  // Scoped to this account's own bets when the index can say — otherwise every settled round.
  const settled = await loadSettledRounds(account);
  if (!settled) return null; // half the data would mean a wrong claimable panel — bail to chain

  const filteredTotal = indexed.filteredTotal + (hasLive ? 1 : 0);
  const pages = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  // The query already ran at the requested page; if that page no longer exists (filter changed,
  // history shrank) re-run at the clamped one rather than rendering an empty table.
  const finalIndexed = safePage === page ? indexed : await loadPage(safePage);
  const rowsRaw = finalIndexed?.rows ?? [];
  const slice = hasLive && safePage === 0 ? [liveRound, ...rowsRaw] : rowsRaw.map(decorate);
  if (hasLive && safePage === 0) {
    for (let index = 1; index < slice.length; index += 1) slice[index] = decorate(slice[index]);
  }

  const total = hasLive ? filteredTotal : finalIndexed.filteredTotal;
  const summary = hasLive
    ? { ...finalIndexed.summary, count: Math.max(finalIndexed.summary.count, total) }
    : finalIndexed.summary;

  return {
    indexed: { ...finalIndexed, filteredTotal, total, summary },
    settled,
    pages,
    safePage,
    slice,
  };
}

export async function loadRoundHistory({
  page = 0, pageSize = ROUND_PAGE_SIZE, account = null, filter = 'all', force = false,
  includeLive = false,
} = {}) {
  const current = roundIdAt();
  const now = Date.now();
  const stale = force || current !== cache.current || (now - cache.fetchedAt) > STALE_MS || !cache.all.length;
  const liveRound = includeLive && filter === 'all'
    ? await readCurrentRoundEntry(current).catch(() => null)
    : null;

  const viaIndex = await loadFromIndex({ page, pageSize, account, filter, current, liveRound });
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
      myBet: mine.get(String(r.roundId))?.myBet ?? r.myBet ?? 0n,
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

  // Production history is intentionally index-backed. Falling through would issue an ever-growing
  // sequence of round PDA reads and then a program-wide receipt scan; an index outage must degrade
  // visibly, not turn every visitor into an unbounded public-RPC crawler.
  if (NETWORK.cluster === 'mainnet-beta') {
    throw new Error('Production round index is unavailable; on-chain account scans are disabled');
  }

  if (stale) {
    if (current > 0n) {
      const { rounds, truncated } = await readRoundsRange(current - 1n, 0n);
      cache = { all: rounds.map(decorate), fetchedAt: now, current, truncated };
    } else {
      cache = { all: [], fetchedAt: now, current, truncated: false };
    }
  }

  const all = liveRound
    ? [liveRound, ...cache.all.filter((row) => row.roundId !== liveRound.roundId)]
    : cache.all;
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
    mined: acc.mined + (r.status === 'settled' && r.totalWager > 0n ? 1 : 0),
    deployed: acc.deployed + r.totalWager,
    minted: acc.minted + r.bullionForWinners,
    jackpots: acc.jackpots + (r.jackpotHit && r.totalWager > 0n ? 1 : 0),
  }), { count: 0, mined: 0, deployed: 0n, minted: 0n, jackpots: 0 });
}
