import { supabase, isSocialConfigured } from '../social/config.js';
import { ROUND_DURATION } from './config.js';
import { nowSeconds as chainNowSeconds } from './round.js';
import { selectLatestVerifiedStakingRewardWindow } from './staking-apy.js';
import {
  commitmentHexFromAccount, describeRandomnessRound, normalizeProofHex,
} from './randomness-mode.js';

/**
 * Round history read from the Supabase index maintained by Protocol/scripts/round-indexer.mjs.
 *
 * The chain remains the source of truth — this is a cache the backend rebuilds from `getRound`.
 * It exists because the chain path scans EVERY elapsed round on every visit (one multicall of
 * ~1,800 `getRound` calls, refreshed every 8s) and is hard-capped at `maxScan = 2000`, past
 * which the ledger silently truncates and the lifetime totals stop being lifetime totals.
 *
 * Every function here returns `null` rather than throwing when the index is unavailable. Local
 * and Devnet can fall back to direct chain reads; Mainnet refuses unbounded account scans.
 *
 * The active round is read directly from its Round PDA by rounds-page.js. The index remains the
 * source for older rows; callers can cap it at the active id and exclude that id so a pre-opened
 * future round or an indexer copy of the live round cannot duplicate/out-rank the chain row.
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
  'randomness_id', 'randomness_value::text', 'randomness_hex', 'randomness_commit_slot',
].join(', ');

/** One probe per session decides whether the table exists; no point retrying on every page. */
let available = null;

const unwrap = (n) => (n === null || n === undefined ? 0n : BigInt(n));

/** Postgres `numeric(78,0)` arrives as a string — BigInt keeps wei exact. */
function fromRow(r) {
  const randomnessCommitSlotEncoded = r.randomness_commit_slot == null
    ? 0n
    : unwrap(r.randomness_commit_slot);
  const randomnessMeta = describeRandomnessRound({
    commitSlot: randomnessCommitSlotEncoded,
    resolved: r.resolved,
  });
  return {
    roundId: BigInt(r.round_id),
    resolved: r.resolved,
    winningSquare: r.winning_square === null ? 0 : Number(r.winning_square),
    jackpotHit: r.jackpot_hit,
    singleMinerRound: r.single_miner_round,
    singleMinerWinner: r.winner || '11111111111111111111111111111111',
    totalWager: unwrap(r.total_wager_wei),
    winnerTotal: unwrap(r.winner_total_wei),
    potForWinners: unwrap(r.pot_for_winners_wei),
    bullionForWinners: unwrap(r.bullion_for_winners_wei),
    payoutMulWad: unwrap(r.payout_mul_wad),
    randomnessId: randomnessMeta.mode === 'server' ? null : (r.randomness_id || null),
    randomnessMode: randomnessMeta.mode,
    randomnessState: randomnessMeta.state,
    randomnessCommitment: randomnessMeta.mode === 'server'
      ? commitmentHexFromAccount(r.randomness_id)
      : null,
    // Prefer the byte-preserving hex form. Decimal remains compatible with rows indexed before
    // randomness_hex was added and is normalized by chain/randomness-proof.js.
    randomnessValue: r.randomness_hex || (r.randomness_value ? unwrap(r.randomness_value) : null),
    randomnessCommitSlot: randomnessMeta.slot,
    randomnessCommitSlotEncoded,
  };
}

const SERVER_PROOF_COLUMNS = [
  'round_id', 'resolved', 'randomness_id', 'randomness_value::text', 'randomness_hex',
  'randomness_commit_slot', 'randomness_provider_kind', 'randomness_commitment_hex',
  'randomness_reveal_hex', 'randomness_target_slot::text',
  'randomness_entropy_slot::text', 'randomness_entropy_hash_hex',
].join(', ');
const BASE_PROOF_COLUMNS = [
  'round_id', 'resolved', 'randomness_id', 'randomness_value::text',
  'randomness_hex', 'randomness_commit_slot',
].join(', ');
let serverProofColumnsAvailable = null;

const optionalBig = (value) => (value === null || value === undefined || value === ''
  ? null
  : BigInt(value));

function randomnessProofFromRow(row) {
  if (!row) return null;
  const encodedSlot = optionalBig(row.randomness_commit_slot) ?? 0n;
  const meta = describeRandomnessRound({ commitSlot: encodedSlot, resolved: row.resolved });
  const indexedProvider = String(row.randomness_provider_kind ?? row.randomness_provider ?? '').toLowerCase();
  const mode = meta.mode === 'server' || indexedProvider.includes('server') ? 'server' : 'switchboard';
  const entropySlot = optionalBig(row.randomness_entropy_slot ?? row.entropy_slot)
    ?? (mode === 'server' ? meta.slot : null);
  return {
    roundId: BigInt(row.round_id),
    mode,
    state: mode === 'server' ? meta.state : (row.resolved ? 'settled' : meta.state),
    randomnessAccount: mode === 'switchboard' ? (row.randomness_id || null) : null,
    commitmentHex: mode === 'server'
      ? (normalizeProofHex(row.randomness_commitment_hex ?? row.commitment_hex)
        || commitmentHexFromAccount(row.randomness_id))
      : null,
    revealHex: normalizeProofHex(row.randomness_reveal_hex ?? row.reveal_hex),
    targetSlot: optionalBig(row.randomness_target_slot ?? row.target_slot),
    entropySlot,
    slotHashHex: normalizeProofHex(row.randomness_entropy_hash_hex ?? row.slot_hash),
    randomnessHex: normalizeProofHex(row.randomness_hex)
      || (row.randomness_value ? normalizeProofHex(BigInt(row.randomness_value).toString(16).padStart(64, '0')) : null),
    encodedSlot,
  };
}

/**
 * Load the optional server reveal proof without making the round ledger depend
 * on a database migration. Older deployments fall back to the original round
 * fields and still expose the on-chain commitment, masked slot and output.
 */
export async function loadRoundRandomnessProof(roundId) {
  if (!(await indexAvailable())) return null;
  try {
    if (serverProofColumnsAvailable !== false) {
      const { data, error } = await supabase
        .from('mine_rounds')
        .select(SERVER_PROOF_COLUMNS)
        .eq('round_id', String(roundId))
        .limit(1);
      if (!error) {
        serverProofColumnsAvailable = true;
        return randomnessProofFromRow(data?.[0]);
      }
      const missingColumn = error.code === '42703' || error.code === 'PGRST204'
        || /column .* does not exist|schema cache/i.test(error.message ?? '');
      if (missingColumn) serverProofColumnsAvailable = false;
    }
    const { data, error } = await supabase
      .from('mine_rounds')
      .select(BASE_PROOF_COLUMNS)
      .eq('round_id', String(roundId))
      .limit(1);
    if (error) return null;
    return randomnessProofFromRow(data?.[0]);
  } catch {
    return null;
  }
}

/**
 * Filters mirror `matchesFilter` in rounds-page.js, but as SQL so paging never loads the whole
 * history into the browser. `mined` means resolved-with-bets; the three modes are all subsets
 * of resolved, which is why they are expressed as column predicates rather than a stored mode.
 */
function applyFilter(query, filter) {
  switch (filter) {
    case 'mined': return query.eq('resolved', true).gt('total_wager_wei', 0);
    // A cryptographic Motherlode/mode sample still exists for an empty round,
    // but it did not pay anyone. Outcome filters describe played mining
    // results; the unfiltered ledger continues to show every resolved round
    // and its published winning tile.
    case 'motherlode': return query.eq('resolved', true).gt('total_wager_wei', 0).eq('jackpot_hit', true);
    case 'solo': return query.eq('resolved', true).gt('total_wager_wei', 0).eq('jackpot_hit', false).eq('single_miner_round', true);
    case 'split': return query.eq('resolved', true).gt('total_wager_wei', 0).eq('jackpot_hit', false).eq('single_miner_round', false);
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
 * Finalized lifetime totals for the Rounds headline.
 *
 * This read deliberately has no wallet, IDL, or live-program dependency. The
 * metrics therefore remain available while mining is paused and while a newly
 * upgraded program client is still reconnecting. The index remains a cache of
 * finalized chain events; an unavailable index returns null rather than a
 * fabricated zero.
 */
export async function loadIndexedRoundStats() {
  if (!(await indexAvailable())) return null;
  try {
    const summaryQuery = supabase
      .from('mine_round_stats')
      .select('mined, deployed_wei::text, minted_wei::text, jackpots')
      .single();

    // Count records that actually exist. Scheduled ids continue advancing
    // while paused, so they are not a truthful lifetime-round total.
    const totalQuery = supabase
      .from('mine_rounds')
      .select('round_id', { count: 'exact' })
      .range(0, 0);

    const [summary, totalRounds] = await Promise.all([summaryQuery, totalQuery]);
    if (summary.error || totalRounds.error) return null;

    const row = summary.data ?? {};
    return {
      count: totalRounds.count ?? 0,
      mined: Number(row.mined ?? 0),
      deployed: unwrap(row.deployed_wei),
      minted: unwrap(row.minted_wei),
      jackpots: Number(row.jackpots ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * One page of history plus the totals across ALL rounds.
 *
 * The summary is deliberately computed server-side: it covers every round ever played, which is
 * the number the chain path could only ever approximate once it hit its scan cap.
 *
 * @returns {Promise<null|{rows, total, filteredTotal, summary}>} null → caller should use chain
 */
export async function loadIndexedRounds({
  page, pageSize, filter, currentRoundId = null, offset = null, excludeRoundId = null,
}) {
  if (!(await indexAvailable())) return null;
  try {
    const from = offset ?? page * pageSize;

    let listQuery = applyFilter(
      supabase.from('mine_rounds').select(ROUND_COLUMNS, { count: 'exact' }),
      filter,
    );
    if (currentRoundId !== null) listQuery = listQuery.lte('round_id', String(currentRoundId));
    if (excludeRoundId !== null) listQuery = listQuery.neq('round_id', String(excludeRoundId));
    listQuery = listQuery
      .order('round_id', { ascending: false })
      .range(from, from + pageSize - 1);

    const [list, stats] = await Promise.all([listQuery, loadIndexedRoundStats()]);
    if (list.error || !stats) return null;

    return {
      rows: (list.data ?? []).map(fromRow),
      filteredTotal: list.count ?? 0,
      total: stats.count,
      summary: stats,
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
        .eq('bettor', String(address))
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

const STAKING_WINDOW_CACHE_MS = 5_000;
const ROUND_CADENCE_SECONDS = Number(ROUND_DURATION);
const STAKING_WINDOW_FALLBACK_LOOKBACK_SECONDS = 6 * 60 * 60;
let stakingWindowCache = null;

/**
 * Durable realised staking rewards for an exact recent window.
 *
 * The index contains the net SOL amount actually routed to stakers by each
 * on-chain RoundFeesDistributed event. Rebuilding this window on refresh keeps
 * APY stable across browsers; a local in-memory balance sample cannot honestly
 * claim to represent the previous 30 minutes. `complete` is deliberately
 * strict so an indexer outage renders APY unavailable instead of overstating it.
 */
export async function loadStakingRewardWindow(
  windowMinutes = 30,
  nowSeconds = Number(chainNowSeconds()),
  { allowStale = false } = {},
) {
  if (!Number.isFinite(windowMinutes) || !(windowMinutes > 0)
    || !Number.isFinite(nowSeconds) || !(await indexAvailable())) return null;
  const observedAt = Math.floor(nowSeconds);
  const key = `${windowMinutes}:${Math.floor(observedAt / (STAKING_WINDOW_CACHE_MS / 1000))}:${allowStale ? 'paused' : 'live'}`;
  if (stakingWindowCache?.key === key) {
    if ('value' in stakingWindowCache) return stakingWindowCache.value;
    return stakingWindowCache.promise;
  }

  // Cache the in-flight read as well as its result. Stake and About can request
  // this metric in the same render tick; they should share one indexed query.
  const promise = (async () => {
    // Anchor the 30-minute sample to the newest COMPLETE fee row. Querying through chain-now
    // included the just-ended unresolved row for a few seconds and made APY disappear on every
    // settlement. A fresh resolved watermark is stable, while an indexer outage still fails shut.
    const { data: latestRows, error: latestError } = await supabase
      .from('mine_rounds')
      .select('round_id,resolved,settles_at,staking_net_lamports::text')
      .eq('resolved', true)
      .not('staking_net_lamports', 'is', null)
      .lte('settles_at', observedAt)
      .order('settles_at', { ascending: false })
      .limit(1);
    if (latestError || !latestRows?.length) return null;
    const end = Number(latestRows[0].settles_at);
    if (!Number.isSafeInteger(end)) return null;
    const queryStart = end - STAKING_WINDOW_FALLBACK_LOOKBACK_SECONDS;
    const { data, error } = await supabase
      .from('mine_rounds')
      .select('round_id,resolved,settles_at,staking_net_lamports::text')
      .gte('settles_at', queryStart)
      .lte('settles_at', end)
      .order('settles_at', { ascending: true })
      .limit(1000);
    if (error) return null;
    const selected = selectLatestVerifiedStakingRewardWindow(data ?? [], {
      windowMinutes,
      roundCadenceSeconds: ROUND_CADENCE_SECONDS,
      observedAt,
      maxRows: 1000,
    });
    if (!selected) return null;
    // A complete older window is a valid realised rate, but it must remain
    // distinguishable from a fully current live sample in the presentation.
    const staleLatestRow = observedAt - end > ROUND_CADENCE_SECONDS * 3;
    return {
      ...selected,
      isFallback: selected.isPartial || selected.lastSettlesAt !== end || staleLatestRow,
    };
  })().catch(() => null);
  stakingWindowCache = { key, promise };
  const value = await promise;
  if (stakingWindowCache?.key === key) stakingWindowCache = { key, value };
  return value;
}

/** Exact receipt addresses for indexed reads; null means the index is unavailable. */
export async function loadReceiptIndex({ roundId = null, address = null } = {}) {
  if (!(await indexAvailable())) return null;
  try {
    const unique = new Map();
    for (let offset = 0; ; offset += PAGE) {
      let query = supabase
        .from('mine_round_bets')
        .select('receipt,round_id,bettor')
        .order('round_id', { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (roundId !== null) query = query.eq('round_id', String(roundId));
      if (address) query = query.eq('bettor', String(address));
      const { data, error } = await query;
      if (error) return null;
      for (const row of data ?? []) unique.set(row.receipt, row);
      if (!data || data.length < PAGE) break;
    }
    return [...unique.values()];
  } catch {
    return null;
  }
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

/**
 * Newest resolved round, optionally capped at an elapsed round id. Empty
 * scheduled rounds are real, settled results with verifiable winning tiles;
 * they must advance the Mine result card just like played rounds.
 */
export async function loadLatestSettledRoundId(atOrBefore = null) {
  if (!(await indexAvailable())) return null;
  try {
    let query = supabase
      .from('mine_rounds')
      .select('round_id')
      .eq('resolved', true)
      .order('round_id', { ascending: false })
      .limit(1);
    if (atOrBefore !== null) query = query.lte('round_id', String(atOrBefore));
    const { data, error } = await query;
    if (error || !data?.length) return null;
    return BigInt(data[0].round_id);
  } catch {
    return null;
  }
}

/**
 * Newest round account observed by the finalized index, resolved or not.
 *
 * The wall-clock schedule continues advancing while the protocol is paused,
 * so it cannot identify the round on which maintenance began. This bounded
 * read preserves the last Round PDA that actually existed without scanning
 * program accounts in the browser.
 */
export async function loadLatestIndexedRoundId(atOrBefore = null) {
  if (!(await indexAvailable())) return null;
  try {
    let query = supabase
      .from('mine_rounds')
      .select('round_id')
      .order('round_id', { ascending: false })
      .limit(1);
    if (atOrBefore !== null) query = query.lte('round_id', String(atOrBefore));
    const { data, error } = await query;
    if (error || !data?.length) return null;
    return BigInt(data[0].round_id);
  } catch {
    return null;
  }
}

/**
 * Newest settled round that actually accepted a deployment.
 *
 * The Mine board still advances through every settled zero-bid result so each
 * published winning tile remains visible and auditable. The miners panel has a
 * different job: keep the latest real participant/reward card reachable instead
 * of replacing it with a run of empty rounds.
 */
export async function loadLatestPlayedSettledRoundId(atOrBefore = null) {
  if (!(await indexAvailable())) return null;
  try {
    let query = supabase
      .from('mine_rounds')
      .select('round_id')
      .eq('resolved', true)
      .gt('total_wager_wei', 0)
      .order('round_id', { ascending: false })
      .limit(1);
    if (atOrBefore !== null) query = query.lte('round_id', String(atOrBefore));
    const { data, error } = await query;
    if (error || !data?.length) return null;
    return BigInt(data[0].round_id);
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
    const data = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data: chunk, error } = await supabase
        .from('mine_round_bets')
        // ::text for the same reason as everywhere else — wei past 2^53 loses precision as a
        // bare JSON number. Page instead of imposing a silent participant ceiling.
        .select('bettor, square, amount_wei::text')
        .eq('round_id', Number(roundId))
        .order('receipt', { ascending: true })
        .order('square', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) return null;
      data.push(...(chunk ?? []));
      if (!chunk || chunk.length < PAGE) break;
    }

    const win = Number(square);
    const byBettor = new Map();
    for (const r of data) {
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
