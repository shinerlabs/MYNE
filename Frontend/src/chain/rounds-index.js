import { supabase, isSocialConfigured } from '../social/config.js';

/**
 * Round history read from the Supabase index (see backend/src/services/round-index.service.ts).
 *
 * The chain remains the source of truth — this is a cache the backend rebuilds from `getRound`.
 * It exists because the chain path scans EVERY elapsed round on every visit (one multicall of
 * ~1,800 `getRound` calls, refreshed every 8s) and is hard-capped at `maxScan = 2000`, past
 * which the ledger silently truncates and the lifetime totals stop being lifetime totals.
 *
 * Every function here returns `null` rather than throwing when the index is unavailable — an
 * unapplied migration, a cold indexer, an offline backend. `loadRoundHistory` treats `null` as
 * "fall back to the chain", so the page degrades to today's behaviour instead of breaking.
 *
 * The LIVE round is never served from here. It is unresolved by definition and the indexer only
 * writes rounds up to `current - 1`.
 */

/**
 * Explicit column list because every wei value needs `::text`.
 *
 * PostgREST serialises `numeric` as a bare JSON number, and wei is ~1e15-1e18 — past 2^53, so
 * JSON.parse silently rounds: payout_mul_wad 1958333333333333333 came back as
 * ...333333200, which would have mis-sized every claim. Casting makes it arrive quoted, and
 * BigInt() on a string is exact.
 */
const ROUND_COLUMNS = [
  'round_id', 'resolved', 'winning_square', 'jackpot_hit', 'single_miner_round', 'winner',
  'total_wager_wei::text', 'winner_total_wei::text', 'pot_for_winners_wei::text',
  'bullion_for_winners_wei::text', 'payout_mul_wad::text',
  // The randomness that decided the round — what the fairness row displays.
  'randomness_id', 'randomness_value::text',
  'drand_round', 'drand_url',
].join(', ');

/** One probe per session decides whether the table exists; no point retrying on every page. */
let available = null;

const unwrap = (n) => (n === null || n === undefined ? 0n : BigInt(n));

/** Postgres `numeric(78,0)` arrives as a string — BigInt keeps wei exact. */
function fromRow(r) {
  return {
    roundId: BigInt(r.round_id),
    resolved: r.resolved,
    winningSquare: r.winning_square === null ? 0 : Number(r.winning_square),
    jackpotHit: r.jackpot_hit,
    singleMinerRound: r.single_miner_round,
    singleMinerWinner: r.winner || '0x0000000000000000000000000000000000000000',
    totalWager: unwrap(r.total_wager_wei),
    winnerTotal: unwrap(r.winner_total_wei),
    potForWinners: unwrap(r.pot_for_winners_wei),
    bullionForWinners: unwrap(r.bullion_for_winners_wei),
    payoutMulWad: unwrap(r.payout_mul_wad),
    randomnessId: r.randomness_id || null,
    randomnessValue: r.randomness_value ? unwrap(r.randomness_value) : null,
    drandRound: r.drand_round != null ? Number(r.drand_round) : null,
    drandUrl: r.drand_url || null,
  };
}

/**
 * Filters mirror `matchesFilter` in rounds-page.js, but as SQL so paging never loads the whole
 * history into the browser. `mined` means resolved-with-bets; the three modes are all subsets
 * of resolved, which is why they are expressed as column predicates rather than a stored mode.
 */
function applyFilter(query, filter) {
  switch (filter) {
    case 'mined': return query.eq('resolved', true).gt('total_wager_wei', 0);
    case 'motherlode': return query.eq('resolved', true).eq('jackpot_hit', true);
    case 'solo': return query.eq('resolved', true).eq('jackpot_hit', false).eq('single_miner_round', true);
    case 'split': return query.eq('resolved', true).eq('jackpot_hit', false).eq('single_miner_round', false);
    default: return query;
  }
}

/**
 * Cheap existence probe, resolved once per session — the table does not appear mid-visit.
 *
 * The in-flight PROMISE is memoised, not just the result: several callers hit this in the same
 * tick (the list, the settled-round query, each refresh), and caching only the result let them
 * all race past the null check and fire their own probe.
 */
let probe = null;
export async function indexAvailable() {
  if (available !== null) return available;
  if (!isSocialConfigured) return (available = false);
  probe ??= (async () => {
    try {
      // A plain GET, not `head: true`. With a HEAD request there is no body for supabase-js to
      // parse, and PostgREST's 404 for a missing relation came back with `error` unset — so the
      // probe reported the table as present and every caller then issued a doomed query.
      const { data, error } = await supabase.from('mine_rounds').select('round_id').limit(1);
      available = !error && Array.isArray(data);
    } catch {
      available = false;
    }
    return available;
  })();
  return probe;
}

/**
 * One page of history plus the totals across ALL rounds.
 *
 * The summary is deliberately computed server-side: it covers every round ever played, which is
 * the number the chain path could only ever approximate once it hit its scan cap.
 *
 * @returns {Promise<null|{rows, total, filteredTotal, summary}>} null → caller should use chain
 */
export async function loadIndexedRounds({ page, pageSize, filter, currentRoundId }) {
  if (!(await indexAvailable())) return null;
  try {
    const from = page * pageSize;

    const listQuery = applyFilter(
      supabase.from('mine_rounds').select(ROUND_COLUMNS, { count: 'exact' }),
      filter,
    ).order('round_id', { ascending: false }).range(from, from + pageSize - 1);

    // Totals come from a Postgres view, not from summing rows here: PostgREST caps an unbounded
    // select at 1000 rows, and with 1140 resolved rounds a client-side sum silently aggregated
    // an arbitrary subset — it reported 0 motherlodes while the motherlode filter showed 9.
    const summaryQuery = supabase
      .from('mine_round_stats')
      .select('mined, deployed_wei::text, minted_wei::text, jackpots')
      .single();

    const [list, summary] = await Promise.all([listQuery, summaryQuery]);
    if (list.error || summary.error) return null;

    const st = summary.data ?? {};
    const deployed = unwrap(st.deployed_wei);
    const minted = unwrap(st.minted_wei);
    const jackpots = Number(st.jackpots ?? 0);
    const mined = Number(st.mined ?? 0);

    return {
      rows: (list.data ?? []).map(fromRow),
      filteredTotal: list.count ?? 0,
      // Every elapsed round, indexed or not — keeps numbering continuous with the chain.
      total: currentRoundId > 0n ? Number(currentRoundId) : 0,
      summary: { count: currentRoundId > 0n ? Number(currentRoundId) : 0, mined, deployed, minted, jackpots },
    };
  } catch {
    return null;
  }
}

/**
 * Every settled round as `{roundId, winningSquare}` — the shape `readMyClaimStatus` wants.
 *
 * Claim status is inherently per-account on-chain state, so it still costs a multicall. What
 * the index removes is the ~1,800-call `getRound` scan that used to be needed just to learn
 * WHICH rounds were settled and what their winning squares were.
 */
const PAGE = 1000; // PostgREST's default cap — request in exactly this size and page past it.

/**
 * The round ids `address` has actually bet in, from the per-square bet index.
 *
 * Returns null if the answer cannot be trusted (no index, query error) — the caller must then
 * fall back to scanning every settled round rather than assume "no bets", because assuming would
 * hide real winnings.
 */
export async function loadMyBetRounds(address) {
  if (!address || !(await indexAvailable())) return null;
  try {
    const ids = new Set();
    for (let offset = 0; ; offset += PAGE) {
      const { data: chunk, error } = await supabase
        .from('mine_round_bets')
        .select('round_id')
        .eq('bettor', String(address).toLowerCase())   // stored lowercase by the indexer
        .order('round_id', { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (error) return null;
      for (const row of chunk ?? []) ids.add(String(row.round_id));
      if (!chunk || chunk.length < PAGE) break;
    }
    // COVERAGE WATERMARK — the newest round this table has ANY row for, from any bettor.
    //
    // The scoped filter is only trustworthy up to here. A bet indexer that stalls does not error
    // and does not empty the table: it just stops advancing, so `ids` stays a small, PLAUSIBLE,
    // non-null set and every later round silently looks like "you never bet". That is exactly how
    // a real 1 MYNE win in round 1401 rendered as "Unclaimed 0.000" while the bet index sat at 1315.
    // Erroring is handled; falling behind was not.
    const { data: head, error: headErr } = await supabase
      .from('mine_round_bets')
      .select('round_id')
      .order('round_id', { ascending: false })
      .limit(1);
    if (headErr) return null;
    // -1 when the table is empty: then nothing is covered and every round is checked on-chain.
    const maxIndexed = head?.length ? BigInt(head[0].round_id) : -1n;
    return { ids, maxIndexed };
  } catch {
    return null;
  }
}

/** Fast account activity check used by mainnet social access policy. */
export async function countMyBetRounds(address) {
  const rounds = await loadMyBetRounds(address);
  return rounds?.ids ? rounds.ids.size : null;
}

/**
 * Settled rounds to check for an unclaimed win.
 *
 * Scoped to the rounds `address` actually bet in when the bet index can answer that. Without the
 * scope this returns EVERY settled round, so the claim check costs two chain reads per round of
 * chain history for every user — a wallet that has never played pays exactly as much as the
 * heaviest miner, and the cost grows forever. `mine_round_bets` is indexed on
 * `(bettor, round_id desc)`, so the scoped lookup is cheap and turns the scan into O(your bets).
 *
 * A null `myRounds` means the index could not answer, NOT that there are no bets — in that case
 * fall through to the full list, which is slow but never wrong.
 */
export async function loadSettledRounds(address = null) {
  if (!(await indexAvailable())) return null;
  const myRounds = address ? await loadMyBetRounds(address) : null;
  try {
    // Paged, because an unbounded select silently stops at 1000 rows: with 1140 settled rounds
    // the oldest 140 would never be checked for an unclaimed win.
    const data = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data: chunk, error } = await supabase
        .from('mine_rounds')
        // payout_mul_wad + single_miner_round size the claim; fetching them here keeps the
        // claimable panel to one query instead of a round trip per winning round.
        .select('round_id, winning_square, payout_mul_wad::text, single_miner_round')
        .eq('resolved', true)
        .gt('total_wager_wei', 0)
        .order('round_id', { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (error) return null;
      data.push(...(chunk ?? []));
      if (!chunk || chunk.length < PAGE) break;
    }
    // Trust the scoped set only within the bet index's coverage. Anything NEWER than the watermark
    // is unindexed, not unplayed, so it still gets the two on-chain reads — which keeps the
    // O(your bets) win for all of history while a stalled indexer can no longer hide a fresh win.
    const scoped = myRounds
      ? data.filter((r) => myRounds.ids.has(String(r.round_id)) || BigInt(r.round_id) > myRounds.maxIndexed)
      : data;
    return scoped.map((r) => ({
      roundId: BigInt(r.round_id),
      winningSquare: Number(r.winning_square ?? 0),
      payoutMulWad: unwrap(r.payout_mul_wad),
      singleMinerRound: Boolean(r.single_miner_round),
    }));
  } catch {
    return null;
  }
}

/** Stored drand link for one round — used by the expanded fairness row. */
export async function loadDrandLink(roundId) {
  if (!(await indexAvailable())) return null;
  try {
    const { data, error } = await supabase
      .from('mine_rounds')
      .select('drand_round, drand_url')
      .eq('round_id', Number(roundId))
      .maybeSingle();
    if (error || !data?.drand_url || data.drand_round == null) return null;
    return { round: Number(data.drand_round), url: data.drand_url };
  } catch {
    return null;
  }
}

/**
 * Miners who bet on a given square in a given round, biggest stake first.
 *
 * This is the one thing the chain genuinely cannot answer: `getBettorsOnSquare` returns a COUNT,
 * and no view function lists addresses — they exist only in `BetPlaced` logs. So the expanded
 * round panel is only possible with the index.
 *
 * Fetches EVERY square for the round, not just the winning one, because the two numbers shown
 * are different things:
 *   deployed — what the miner staked across the whole round, i.e. what it cost them
 *   payout   — derived from their stake on the WINNING square alone
 * A miner who spread 0.05 over five tiles and hit one with 0.01 deployed 0.05 and is paid
 * on 0.01; showing the winning-square stake in both places would overstate their return.
 *
 * @returns {Promise<null|Array<{bettor, deployed: bigint, winningStake: bigint}>>}
 */
export async function loadRoundBets(roundId, square) {
  if (!(await indexAvailable())) return null;
  try {
    const { data, error } = await supabase
      .from('mine_round_bets')
      // ::text for the same reason as everywhere else — wei past 2^53 loses precision as a
      // bare JSON number.
      .select('bettor, square, amount_wei::text')
      .eq('round_id', Number(roundId))
      .limit(2000);
    if (error) return null;

    const win = Number(square);
    const byBettor = new Map();
    for (const r of data ?? []) {
      const key = r.bettor;
      const acc = byBettor.get(key) ?? { bettor: key, deployed: 0n, winningStake: 0n };
      const amount = unwrap(r.amount_wei);
      acc.deployed += amount;
      if (Number(r.square) === win) acc.winningStake += amount;
      byBettor.set(key, acc);
    }
    // Only miners actually ON the winning square belong in the roster.
    return [...byBettor.values()]
      .filter((m) => m.winningStake > 0n)
      .sort((a, b) => (b.winningStake === a.winningStake ? 0 : b.winningStake > a.winningStake ? 1 : -1));
  } catch {
    return null;
  }
}
