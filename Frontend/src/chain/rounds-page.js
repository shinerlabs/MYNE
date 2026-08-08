import {
  readRound, readRoundsRange, readWalletReceiptRounds, readWinnerCounts, readMyClaimStatus, readExpectedRewards, readExpectedSolRewards,
  readRoundIndexAtResolve, countUnknownClaimStatus,
} from './lottery.js';
import { classifyRoundLifecycle } from './round-lifecycle.js';
import { nowSeconds, roundIdAt, roundEnd, roundState } from './round.js';
import {
  loadIndexedRoundProjectionRows, loadIndexedRounds, loadIndexedWalletRoundHistory,
  loadIndexedWinnerCounts,
} from './rounds-index.js';
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
 *   resolving   the scheduled result has not yet been published
 *   refund-ready/refunded  settlement timed out and receipt recovery is active/complete
 *
 * A short-lived cache of the raw scan means paging/filtering doesn't re-scan the chain on every
 * click; it refreshes when the round advances or the cache ages past STALE_MS.
 */
export const ROUND_PAGE_SIZE = 50;
const STALE_MS = 3000;
const RECENT_CHAIN_ROUNDS = 4;

let cache = { all: [], fetchedAt: 0, current: -1n, truncated: false };

const decorate = (r) => {
  const lifecycle = classifyRoundLifecycle(r, { nowSeconds: nowSeconds() });
  const { status } = lifecycle;
  // A resolved zero-bid round has a verifiable tile but no payout mode. A
  // played Motherlode is the headline; otherwise the 50/50 sample decides
  // solo vs split. Drives both the badge and filter buttons.
  const mode = status !== 'settled' ? status
    : r.totalWager === 0n ? 'empty'
      : r.jackpotHit ? 'motherlode' : r.singleMinerRound ? 'solo' : 'split';
  return { ...r, lifecycle, status, mode, endsAt: roundEnd(r.roundId) };
};

const matchesFilter = (r, filter) => filter === 'all'
  || (filter === 'mined' ? r.status === 'settled' && r.totalWager > 0n : r.mode === filter);

/**
 * Overlay a bounded set of recent Round PDA reads on the rebuildable index.
 * Direct chain rows win by id; the result stays newest-first and page-sized.
 */
export function mergeAuthoritativeRecentRounds(indexedRows, recentRows, {
  filter = 'all', pageSize = ROUND_PAGE_SIZE,
} = {}) {
  const indexedById = new Map(
    (indexedRows || []).map((row) => [String(row.roundId), row]),
  );
  const authoritative = new Map(
    (recentRows || []).map((row) => {
      const key = String(row.roundId);
      const indexed = indexedById.get(key);
      // A direct settled result may lead the index by one transaction. Do not
      // carry forward an active-row health flag until the indexed settlement
      // (which also derives the solo winner) has landed.
      const projectionComplete = indexed?.projectionComplete === true
        && (!row.resolved || indexed.resolved === true);
      const merged = {
        ...indexed,
        ...row,
        // Direct account reads own round facts. Only the participant index can
        // prove that its roster is complete, so preserve that health bit from
        // the indexed version and default brand-new rows to unknown.
        projectionComplete,
        singleMinerWinner: projectionComplete
          ? indexed.singleMinerWinner
          : row.singleMinerWinner,
      };
      if (merged.lifecycle) merged.lifecycle = {
        ...merged.lifecycle,
        projectionComplete,
        participantCountsKnown: projectionComplete && merged.status === 'settled',
      };
      return [key, merged];
    }),
  );
  const rows = new Map();
  for (const row of indexedRows || []) {
    const key = String(row.roundId);
    // Delete the stale indexed version before deciding whether the direct-chain version belongs
    // in the active filter. Otherwise a round that resolved from `split` to `solo` could remain
    // visible in both filters.
    if (!authoritative.has(key) && matchesFilter(row, filter)) rows.set(key, row);
  }
  for (const [key, row] of authoritative) {
    if (matchesFilter(row, filter)) rows.set(key, row);
  }
  return [...rows.values()]
    .sort((a, b) => (BigInt(a.roundId) === BigInt(b.roundId)
      ? 0
      : BigInt(a.roundId) > BigInt(b.roundId) ? -1 : 1))
    .slice(0, pageSize);
}

/** Add fully decoded recent settlements to wallet claim discovery even while the index lags. */
export function mergeSettledClaimRounds(indexedSettled, recentRows, walletReceiptRounds = []) {
  return [...new Map([
    ...(indexedSettled || []),
    ...(recentRows || []).filter((row) => row.status === 'settled' && row.totalWager > 0n),
    ...(walletReceiptRounds || []).filter((row) => row.status === 'settled' && row.totalWager > 0n),
  ].map((row) => [String(row.roundId), row])).values()];
}

/**
 * Select optional wallet decoration without converting an unavailable private
 * history read into a fabricated zero/unclaimed status.
 */
export function selectWalletRoundDecoration({
  account, direct = null, historical = null,
  historicalAvailable = false, projectionComplete = false,
} = {}) {
  if (!account) return { myBet: 0n, claimed: false, walletHistoryKnown: true };
  if (direct?.myBet > 0n) return { ...direct, walletHistoryKnown: true };
  if (projectionComplete && historicalAvailable) {
    return historical
      ? { ...historical, walletHistoryKnown: true }
      : { myBet: 0n, claimed: false, walletHistoryKnown: true };
  }
  return { myBet: null, claimed: null, walletHistoryKnown: false };
}

const summaryContribution = (round) => {
  const resolved = Boolean(round?.resolved ?? round?.status === 'settled');
  const deployed = resolved ? BigInt(round?.totalWager ?? 0) : 0n;
  const played = resolved && deployed > 0n;
  return {
    mined: played ? 1 : 0,
    deployed,
    minted: resolved ? BigInt(round?.bullionForWinners ?? 0) : 0n,
    jackpots: played && round?.jackpotHit ? 1 : 0,
  };
};

/** Replace stale recent index contributions with confirmed direct-PDA facts. */
export function mergeAuthoritativeRoundSummary(summary, indexedRows, directRows, count) {
  const result = { ...summary, count };
  const indexed = new Map((indexedRows || []).map((row) => [String(row.roundId), row]));
  for (const direct of directRows || []) {
    const before = summaryContribution(indexed.get(String(direct.roundId)));
    const after = summaryContribution(direct);
    result.mined += after.mined - before.mined;
    result.deployed += after.deployed - before.deployed;
    result.minted += after.minted - before.minted;
    result.jackpots += after.jackpots - before.jackpots;
  }
  return result;
}

async function readRecentElapsedRounds(current) {
  if (current <= 0n) return [];
  const from = current - 1n;
  const to = from >= BigInt(RECENT_CHAIN_ROUNDS - 1)
    ? from - BigInt(RECENT_CHAIN_ROUNDS - 1)
    : 0n;
  const { rounds } = await readRoundsRange(from, to, RECENT_CHAIN_ROUNDS);
  return rounds.map(decorate);
}

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
  const lifecycle = classifyRoundLifecycle(row, {
    nowSeconds: nowSeconds(), isLive: true, phase,
  });
  return {
    ...row, lifecycle, status: lifecycle.status, mode: lifecycle.status,
    isLive: true, phase, secondsLeft,
  };
}

export const roundHistoryPageWindow = (page, pageSize, authoritativeCount = 0) => {
  // Backwards compatible with the former `hasLive` boolean while allowing the recent direct
  // Round-PDA overlay to participate in the same virtual pagination math.
  const prefix = typeof authoritativeCount === 'boolean'
    ? Number(authoritativeCount)
    : Math.max(0, Number(authoritativeCount) || 0);
  const start = page * pageSize;
  const end = start + pageSize;
  const authoritativeOnPage = Math.max(0, Math.min(prefix, end) - start);
  return {
    offset: Math.max(0, start - prefix),
    pageSize: pageSize - authoritativeOnPage,
  };
};

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
  // Claim amounts depend only on this wallet's exact open receipt ledger and
  // the Round account. Public roster enrichment is intentionally excluded:
  // a throttled round-wide scan must never delay the Rewards panel.
  const [expected, expectedSol, resolveIndex] = await Promise.all([
    readExpectedRewards(base, account),
    readExpectedSolRewards(base, account),
    // Retained for the shared row shape. V6 does not back-date unsettled
    // receipt rewards into historical passive distributions.
    readRoundIndexAtResolve(base),
  ]);
  return base.map((r) => {
    const myBet = mine.get(String(r.roundId)).myBet;
    return {
      ...r,
      myBet,
      claimed: false,
      winners: null,
      sharedWith: 0n,
      userEth: expectedSol.get(String(r.roundId)) ?? 0n,
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
async function loadFromIndex({
  page, pageSize, account, filter, current, liveRound, recentChainRows,
}) {
  const hasLive = filter === 'all' && Boolean(liveRound);
  const authoritativeById = new Map();
  for (const row of recentChainRows || []) authoritativeById.set(String(row.roundId), row);
  if (hasLive) authoritativeById.set(String(liveRound.roundId), liveRound);
  const authoritativeRows = [...authoritativeById.values()];
  const filteredAuthoritativeRows = authoritativeRows.filter((row) => matchesFilter(row, filter));
  const authoritativeCount = filteredAuthoritativeRows.length;
  // The direct window is deliberately bounded to five rows (active + four elapsed), far below
  // every production page size. They therefore all fall within virtual page zero even if an
  // indexed row for a missing PDA interleaves by id. Later pages shift by the exact prefix count.
  const excludedIds = [...new Set([
    String(current),
    ...authoritativeRows.map((row) => String(row.roundId)),
  ])];
  const loadPage = async (targetPage) => {
    const window = roundHistoryPageWindow(targetPage, pageSize, authoritativeCount);
    return loadIndexedRounds({
      page: targetPage,
      pageSize: window.pageSize,
      offset: window.offset,
      filter,
      currentRoundId: current,
      excludeRoundIds: excludedIds,
    });
  };
  const [indexed, authoritativeProjectionRows] = await Promise.all([
    loadPage(page),
    loadIndexedRoundProjectionRows(authoritativeRows.map((row) => row.roundId)),
  ]);
  if (!indexed) return null;

  const filteredTotal = indexed.filteredTotal + authoritativeCount;
  const pages = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  // The query already ran at the requested page; if that page no longer exists (filter changed,
  // history shrank) re-run at the clamped one rather than rendering an empty table.
  const finalIndexed = safePage === page ? indexed : await loadPage(safePage);
  if (!finalIndexed) return null;
  const rowsRaw = finalIndexed?.rows ?? [];
  const slice = safePage === 0
    ? mergeAuthoritativeRecentRounds(
      [
        ...rowsRaw.map(decorate),
        ...(authoritativeProjectionRows || []).map(decorate),
      ],
      authoritativeRows,
      { filter, pageSize },
    )
    : rowsRaw.map(decorate);

  const total = finalIndexed.total + authoritativeRows.length;
  const summary = mergeAuthoritativeRoundSummary(
    finalIndexed.summary,
    authoritativeProjectionRows,
    authoritativeRows,
    total,
  );

  return {
    indexed: { ...finalIndexed, filteredTotal, total, summary },
    // Actionable reward rounds come from the wallet's still-open receipt PDAs,
    // not an ever-growing scan of every historical settlement.
    settled: [],
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
  // This bounded read is required on every page: besides shifting virtual page boundaries, it
  // discovers a just-settled claim even when the wallet is viewing page 2+ and the indexer is
  // temporarily behind.
  const recentChainRows = await readRecentElapsedRounds(current).catch(() => []);
  const walletReceiptRounds = account
    ? await readWalletReceiptRounds(account).then((rows) => rows.map(decorate)).catch(() => null)
    : [];
  const walletClaimsAvailable = walletReceiptRounds !== null;

  const viaIndex = await loadFromIndex({
    page, pageSize, account, filter, current, liveRound, recentChainRows,
  });
  if (viaIndex) {
    const { indexed, settled, pages, safePage, slice } = viaIndex;
    const settledForClaims = mergeSettledClaimRounds(
      settled,
      recentChainRows,
      walletReceiptRounds ?? [],
    );
    const pageSettled = slice.filter((r) => r.status === 'settled');
    const [indexedCounts, actionableMine, historicalMine] = await Promise.all([
      loadIndexedWinnerCounts(pageSettled),
      walletClaimsAvailable
        ? readMyClaimStatus(settledForClaims, account)
        : Promise.resolve(new Map()),
      // Wallet-authenticated archived decoration belongs to the visible
      // Rounds ledger. Mine-route refreshes use this same loader for claim
      // discovery, but must never prompt merely to render historical labels.
      account && includeLive
        ? loadIndexedWalletRoundHistory(pageSettled, account)
        : Promise.resolve(new Map()),
    ]);
    // Mainnet history is an indexed read surface. Never turn a temporary bet-index problem into
    // fifty sequential public-RPC calls; the row remains visible and its count can reconcile on
    // the next Realtime/poll refresh. Local/Devnet retain the direct-chain fallback for testing.
    const counts = indexedCounts ?? (NETWORK.cluster === 'mainnet-beta'
      ? null
      : await readWinnerCounts(pageSettled));
    const rows = slice.map((r) => {
      const key = String(r.roundId);
      const direct = actionableMine.get(key);
      // An exact, still-open receipt wins every disagreement. Once the PDA is
      // gone, the completeness-gated index preserves the row decoration only.
      const walletDisplay = selectWalletRoundDecoration({
        account,
        direct,
        historical: historicalMine?.get(key) ?? null,
        historicalAvailable: historicalMine instanceof Map,
        projectionComplete: r.projectionComplete === true,
      });
      return {
        ...r,
        // null is deliberately distinct from zero: if the public bet index is temporarily
        // unavailable the result remains visible, but the UI must not invent "0 winners".
        winners: r.projectionComplete === true && counts
          ? (counts.get(key) ?? null)
          : null,
        myBet: walletDisplay.myBet,
        claimed: walletDisplay.claimed,
        walletHistoryKnown: walletDisplay.walletHistoryKnown,
      };
    });
    const claimable = walletClaimsAvailable
      // Historical index rows must never become claim buttons. Only current
      // authority-filtered BetReceipt PDAs enter this calculation.
      ? await buildClaimable(settledForClaims, actionableMine, account)
      : [];
    return {
      rows,
      // >0 means the claim panel is INCOMPLETE, not that there is nothing to claim. The UI must
      // say so rather than render a confident zero over an unreadable chain.
      claimableUnknown: walletClaimsAvailable ? countUnknownClaimStatus(actionableMine) : 1,
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
  const allSettled = mergeSettledClaimRounds(
    all.filter((r) => r.status === 'settled'),
    recentChainRows,
    walletReceiptRounds ?? [],
  );
  const [counts, mine] = await Promise.all([
    readWinnerCounts(pageSettled),
    walletClaimsAvailable ? readMyClaimStatus(allSettled, account) : Promise.resolve(new Map()),
  ]);

  const rows = slice.map((r) => ({
    ...r,
    winners: counts.get(String(r.roundId)) ?? 0n,
    myBet: mine.get(String(r.roundId))?.myBet ?? 0n,
    claimed: mine.get(String(r.roundId))?.claimed ?? false,
  }));

  const claimable = walletClaimsAvailable ? await buildClaimable(allSettled, mine, account) : [];

  return {
    rows,
    claimableUnknown: walletClaimsAvailable ? countUnknownClaimStatus(mine) : 1,
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
