import {
  FUNCTIONS_URL, fetchJson, supabase, isSocialConfigured,
} from '../social/config.js';
import { getSession } from '../social/session.js';
import { ROUND_DURATION } from './config.js';
import { nowSeconds as chainNowSeconds } from './round.js';
import { selectLatestVerifiedStakingRewardWindow } from './staking-apy.js';
import {
  commitmentHexFromAccount, describeRandomnessRound, normalizeProofHex,
} from './randomness-mode.js';
import { intervalReward } from './round-rewards.js';

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
  'opened_at', 'betting_ends_at', 'settles_at', 'refund_at',
  'total_wager_wei::text', 'winner_total_wei::text', 'pot_for_winners_wei::text',
  'bullion_for_winners_wei::text', 'payout_mul_wad::text', 'solo_sample::text',
  'total_receipts', 'processed_receipts', 'closed_receipts', 'buyback_completed',
  'projection_complete', 'projection_version', 'source_slot',
  'archive_verified', 'archive_hash', 'archived_at', 'closed_signature',
  'settlement_signature', 'settlement_slot',
  // The randomness that decided the round — what the fairness row displays.
  'randomness_id', 'randomness_value::text', 'randomness_hex', 'randomness_commit_slot',
  'randomness_provider_kind', 'randomness_commitment_hex',
].join(', ');

/** One probe per session decides whether the table exists; no point retrying on every page. */
let available = null;

const unwrap = (n) => (n === null || n === undefined ? 0n : BigInt(n));

/** Postgres `numeric(78,0)` arrives as a string — BigInt keeps wei exact. */
export function indexedRoundFromRow(r) {
  const randomnessCommitSlotEncoded = r.randomness_commit_slot == null
    ? 0n
    : unwrap(r.randomness_commit_slot);
  const randomnessMeta = describeRandomnessRound({
    commitSlot: randomnessCommitSlotEncoded,
    resolved: r.resolved,
  });
  const indexedProvider = String(r.randomness_provider_kind ?? '').toLowerCase();
  const serverRound = randomnessMeta.mode === 'server' || indexedProvider.includes('server');
  const randomnessCommitment = serverRound
    ? (normalizeProofHex(r.randomness_commitment_hex)
      || commitmentHexFromAccount(r.randomness_id))
    : null;
  return {
    roundId: BigInt(r.round_id),
    resolved: r.resolved,
    winningSquare: r.winning_square === null ? 0 : Number(r.winning_square),
    jackpotHit: r.jackpot_hit,
    singleMinerRound: r.single_miner_round,
    singleMinerWinner: r.projection_complete === true && r.winner
      ? r.winner
      : '11111111111111111111111111111111',
    openedAt: unwrap(r.opened_at),
    bettingEndsAt: unwrap(r.betting_ends_at),
    settlesAt: unwrap(r.settles_at),
    refundAt: unwrap(r.refund_at),
    totalWager: unwrap(r.total_wager_wei),
    winnerTotal: unwrap(r.winner_total_wei),
    potForWinners: unwrap(r.pot_for_winners_wei),
    bullionForWinners: unwrap(r.bullion_for_winners_wei),
    payoutMulWad: unwrap(r.payout_mul_wad),
    soloSample: unwrap(r.solo_sample),
    totalReceipts: unwrap(r.total_receipts),
    processedReceipts: unwrap(r.processed_receipts),
    closedReceipts: unwrap(r.closed_receipts),
    buybackCompleted: Boolean(r.buyback_completed),
    projectionComplete: r.projection_complete === true,
    projectionVersion: Number(r.projection_version ?? 0),
    sourceSlot: r.source_slot == null ? null : unwrap(r.source_slot),
    archiveVerified: Boolean(r.archive_verified),
    archiveHash: r.archive_hash || null,
    archivedAt: r.archived_at || null,
    closedSignature: r.closed_signature || null,
    settlementSignature: r.settlement_signature || null,
    settlementSlot: r.settlement_slot == null ? null : unwrap(r.settlement_slot),
    randomnessId: serverRound ? null : (r.randomness_id || null),
    randomnessMode: serverRound ? 'server' : randomnessMeta.mode,
    randomnessState: serverRound
      ? (r.resolved
        ? 'settled'
        : randomnessMeta.mode === 'server'
          ? randomnessMeta.state
          : randomnessCommitment ? 'commitment-bound' : 'commitment-pending')
      : randomnessMeta.state,
    randomnessCommitment,
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
  const commitmentHex = mode === 'server'
    ? (normalizeProofHex(row.randomness_commitment_hex ?? row.commitment_hex)
      || commitmentHexFromAccount(row.randomness_id))
    : null;
  const entropySlot = optionalBig(row.randomness_entropy_slot ?? row.entropy_slot)
    ?? (mode === 'server' ? meta.slot : null);
  return {
    roundId: BigInt(row.round_id),
    mode,
    state: mode === 'server'
      ? (row.resolved
        ? 'settled'
        : meta.mode === 'server'
          ? meta.state
          : commitmentHex ? 'commitment-bound' : 'commitment-pending')
      : (row.resolved ? 'settled' : meta.state),
    randomnessAccount: mode === 'switchboard' ? (row.randomness_id || null) : null,
    commitmentHex,
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
  page, pageSize, filter, currentRoundId = null, offset = null,
  excludeRoundId = null, excludeRoundIds = [],
}) {
  if (!(await indexAvailable())) return null;
  try {
    const from = offset ?? page * pageSize;
    const excluded = [...new Set([
      ...(excludeRoundIds || []),
      ...(excludeRoundId === null ? [] : [excludeRoundId]),
    ].map(String))];

    const applyBounds = (query) => {
      let bounded = query;
      if (currentRoundId !== null) bounded = bounded.lte('round_id', String(currentRoundId));
      // Recent direct-chain rows are a replacement surface, not extra rows. Exclude every
      // authoritative id before SQL filtering/counting so a stale indexed state cannot survive
      // a filter merely because its replacement no longer matches that filter.
      for (const roundId of excluded) bounded = bounded.neq('round_id', roundId);
      return bounded;
    };

    let listQuery = applyBounds(applyFilter(
      supabase.from('mine_rounds').select(ROUND_COLUMNS, { count: 'exact' }),
      filter,
    ));
    listQuery = listQuery
      .order('round_id', { ascending: false })
      .range(from, from + pageSize - 1);

    // `filteredTotal` and `total` must describe the same bounded/excluded virtual dataset as
    // the rows. The lifetime stats table cannot provide that count when a recent chain row is
    // replacing (or removing) its stale indexed counterpart.
    const totalQuery = filter === 'all'
      ? null
      : applyBounds(supabase.from('mine_rounds').select('round_id', { count: 'exact' }))
        .range(0, 0);
    const [list, stats, allRows] = await Promise.all([
      listQuery,
      loadIndexedRoundStats(),
      totalQuery ?? Promise.resolve(null),
    ]);
    if (list.error || !stats || allRows?.error) return null;
    const total = filter === 'all' ? (list.count ?? 0) : (allRows?.count ?? 0);

    return {
      rows: (list.data ?? []).map(indexedRoundFromRow),
      filteredTotal: list.count ?? 0,
      total,
      summary: { ...stats, count: total },
    };
  } catch {
    return null;
  }
}

/**
 * Bounded index metadata for the direct-chain overlay. Those recent ids are
 * deliberately excluded from the paged query, but their participant health
 * and derived solo winner still belong to the finalized projection.
 */
export async function loadIndexedRoundProjectionRows(roundIds) {
  const ids = [...new Set((roundIds || []).map(String))];
  if (!ids.length) return [];
  if (!(await indexAvailable())) return null;
  try {
    const { data, error } = await supabase
      .from('mine_rounds')
      .select(ROUND_COLUMNS)
      .in('round_id', ids)
      .order('round_id', { ascending: false });
    if (error) return null;
    return (data ?? []).map(indexedRoundFromRow);
  } catch {
    return null;
  }
}

/**
 * Winner counts for a visible history page, derived from the public bet index in one bounded
 * request instead of issuing one receipt-index query plus one Solana RPC read per round.
 *
 * The raw count is the number of eligible wallets. The row renderer reduces a Solo result to
 * one paid winner while retaining this raw number for the "1 of N" explanation. Motherlode
 * counts every participant in the round; Split/Solo count wallets on the winning tile only.
 */
export function winnerCountsFromIndexedBets(rounds, bets) {
  const completeRounds = rounds.filter((round) => round.projectionComplete === true);
  const participants = new Map(completeRounds.map((round) => [String(round.roundId), new Set()]));
  const byId = new Map(completeRounds.map((round) => [String(round.roundId), round]));
  for (const bet of bets) {
    const key = String(bet.round_id);
    const round = byId.get(key);
    if (!round || !round.resolved || round.totalWager <= 0n) continue;
    if (!round.jackpotHit && Number(bet.square) !== Number(round.winningSquare)) continue;
    participants.get(key)?.add(String(bet.bettor));
  }
  return new Map(rounds.map((round) => [
    String(round.roundId),
    round.projectionComplete === true
      ? BigInt(participants.get(String(round.roundId))?.size ?? 0)
      : null,
  ]));
}

export async function loadIndexedWinnerCounts(rounds) {
  if (!rounds.length) return new Map();
  if (!(await indexAvailable())) return null;
  try {
    const ids = rounds
      .filter((round) => round.projectionComplete === true)
      .map((round) => String(round.roundId));
    if (!ids.length) return winnerCountsFromIndexedBets(rounds, []);
    const bets = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data: chunk, error } = await supabase
        .from('mine_round_bets')
        .select('round_id,receipt,bettor,square')
        .in('round_id', ids)
        .order('round_id', { ascending: false })
        .order('receipt', { ascending: true })
        .order('square', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) return null;
      bets.push(...(chunk ?? []));
      if (!chunk || chunk.length < PAGE) break;
    }
    return winnerCountsFromIndexedBets(rounds, bets);
  } catch {
    return null;
  }
}

/**
 * Parse the wallet-owned, display-only history response without allowing the
 * endpoint to decorate any round outside the caller's exact visible window.
 */
export function walletRoundHistoryFromRows(rows, requestedRoundIds) {
  if (!Array.isArray(rows)) return null;
  const requested = new Set((requestedRoundIds || []).map(String));
  if (requested.size > 50) return null;
  const result = new Map();
  for (const row of rows) {
    const roundId = String(row?.roundId ?? '');
    const position = String(row?.positionLamports ?? '');
    const winningReceipts = String(row?.winningReceipts ?? '');
    const processedWinningReceipts = String(row?.processedWinningReceipts ?? '');
    if (!requested.has(roundId) || result.has(roundId)
      || !/^(?:0|[1-9][0-9]*)$/.test(position)
      || !/^(?:0|[1-9][0-9]*)$/.test(winningReceipts)
      || !/^(?:0|[1-9][0-9]*)$/.test(processedWinningReceipts)
      || typeof row.claimed !== 'boolean') return null;
    const myBet = BigInt(position);
    const receipts = BigInt(winningReceipts);
    const processed = BigInt(processedWinningReceipts);
    if (myBet <= 0n || receipts <= 0n || processed > receipts
      || row.claimed !== (processed === receipts)) return null;
    result.set(roundId, {
      myBet,
      claimed: row.claimed,
      winningReceipts: receipts,
      processedWinningReceipts: processed,
      historical: true,
    });
  }
  return result;
}

let walletHistoryRequest = null;

/**
 * Wallet decoration for one visible Rounds page only.
 *
 * This signed-session endpoint reads archived index rows after BetReceipt PDAs
 * close. It is presentation state only: claim discovery and transaction
 * construction continue to use authority-filtered open PDAs and StakePosition.
 */
export async function loadIndexedWalletRoundHistory(rounds, address) {
  if (!address || !Array.isArray(rounds)) return new Map();
  const visibleIds = [...new Set(rounds.map((round) => String(round.roundId)))];
  if (visibleIds.length > 50) return null;
  const ids = [...new Set(rounds
    .filter((round) => round.projectionComplete === true)
    .map((round) => String(round.roundId)))]
    .sort((left, right) => {
      const a = BigInt(left);
      const b = BigInt(right);
      return a === b ? 0 : a > b ? -1 : 1;
    });
  if (!ids.length) return new Map();
  const wallet = String(address);
  const key = `${wallet}:${ids.join(',')}`;
  if (walletHistoryRequest?.key === key) return walletHistoryRequest.promise;
  const stored = getSession();
  // Public round history never requires wallet authentication. If the user
  // has not already established a signed wallet session (for example through
  // chat), leave this optional decoration unknown and never open a signature
  // prompt merely to render the ledger.
  if (!stored?.token || stored.walletAddress !== wallet
    || new Date(stored.expiresAt).getTime() < Date.now()) return null;
  const promise = (async () => {
    try {
      const { res, data } = await fetchJson(
        `${FUNCTIONS_URL}/wallet-round-history`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${stored.token}`,
          },
          body: JSON.stringify({ roundIds: ids }),
        },
      );
      if (!res.ok || getSession()?.walletAddress !== wallet) return null;
      return walletRoundHistoryFromRows(data?.rows, ids);
    } catch {
      return null;
    }
  })();
  walletHistoryRequest = { key, promise };
  const result = await promise;
  if (walletHistoryRequest?.key === key) walletHistoryRequest = null;
  return result;
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
        .select('round_id,receipt,square')
        .eq('bettor', String(address))
        .order('round_id', { ascending: false })
        .order('receipt', { ascending: true })
        .order('square', { ascending: true })
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

/** Invalidate the realised APY sample after a finalized round-index event. */
export const invalidateStakingRewardWindowCache = () => {
  stakingWindowCache = null;
};

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
    if (roundId !== null) {
      const { data: health, error: healthError } = await supabase
        .from('mine_rounds')
        .select('projection_complete')
        .eq('round_id', String(roundId))
        .limit(1);
      if (healthError || health?.[0]?.projection_complete !== true) return null;
    }
    const unique = new Map();
    for (let offset = 0; ; offset += PAGE) {
      let query = supabase
        .from('mine_round_bets')
        .select('receipt,round_id,bettor,square')
        .order('round_id', { ascending: false })
        .order('receipt', { ascending: true })
        .order('square', { ascending: true })
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

/** Latest settlement with enough exact fields to render a winner after its PDA is closed. */
export async function loadLatestSettledRound(atOrBefore = null) {
  if (!(await indexAvailable())) return null;
  try {
    let query = supabase
      .from('mine_rounds')
      .select(ROUND_COLUMNS)
      .eq('resolved', true)
      .order('round_id', { ascending: false })
      .limit(1);
    if (atOrBefore !== null) query = query.lte('round_id', String(atOrBefore));
    const { data, error } = await query;
    if (error || !data?.length) return null;
    return indexedRoundFromRow(data[0]);
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

/** Latest played settlement with the exact indexed fields needed by the Mine miners card. */
export async function loadLatestPlayedSettledRound(atOrBefore = null) {
  if (!(await indexAvailable())) return null;
  try {
    let query = supabase
      .from('mine_rounds')
      .select(ROUND_COLUMNS)
      .eq('resolved', true)
      .gt('total_wager_wei', 0)
      .order('round_id', { ascending: false })
      .limit(1);
    if (atOrBefore !== null) query = query.lte('round_id', String(atOrBefore));
    const { data, error } = await query;
    if (error || !data?.length) return null;
    return indexedRoundFromRow(data[0]);
  } catch {
    return null;
  }
}

/**
 * Reconstruct the complete previous-round miner roster from the append-only bet index.
 *
 * This mirrors the normal Split/Solo interval arithmetic used by the contract and keeps the
 * public roster usable during an RPC outage. A Motherlode's accumulated SOL/MYNE pools are not
 * present in the public round row, so those rare reward amounts remain explicitly unavailable
 * until the direct account read succeeds; participant identity and deployment remain exact.
 */
export function indexedMinerRoster(round, rows) {
  const receipts = new Map();
  for (const row of rows) {
    const square = Number(row.square);
    if (!Number.isInteger(square) || square < 0 || square >= 25) continue;
    const key = String(row.receipt);
    const receipt = receipts.get(key) ?? {
      authority: String(row.bettor),
      amounts: Array(25).fill(0n),
      starts: Array(25).fill(0n),
      total: 0n,
      rewardMode: 0,
    };
    const amount = unwrap(row.amount_wei);
    receipt.amounts[square] += amount;
    receipt.starts[square] = unwrap(row.cumulative_start_wei);
    receipt.total += amount;
    receipt.rewardMode = Math.max(receipt.rewardMode, Number(row.reward_mode ?? 0));
    receipts.set(key, receipt);
  }

  const grouped = new Map();
  for (const receipt of receipts.values()) {
    const miner = grouped.get(receipt.authority) ?? {
      address: receipt.authority,
      tileBets: Array(25).fill(0n),
      deployed: 0n,
      receiptCount: 0,
      claimed: false,
      autoRound: false,
      autoBurn: false,
      autoMode: 'accumulate',
      receipts: [],
    };
    receipt.amounts.forEach((amount, square) => { miner.tileBets[square] += amount; });
    miner.deployed += receipt.total;
    miner.receiptCount += 1;
    miner.receipts.push(receipt);
    if (receipt.rewardMode === 1) {
      miner.autoRound = true;
      miner.autoBurn = true;
      miner.autoMode = 'burn';
    }
    grouped.set(receipt.authority, miner);
  }

  const winningSquare = Number(round.winningSquare);
  const miners = [...grouped.values()].map((miner) => {
    const winningStake = miner.tileBets[winningSquare] ?? 0n;
    const onWinningTile = winningStake > 0n && round.winnerTotal > 0n;
    const isSoloWinner = Boolean(round.singleMinerRound
      && round.singleMinerWinner === miner.address);
    const winningSolReward = miner.receipts.reduce((sum, receipt) => sum + intervalReward(
      round.potForWinners,
      receipt.starts[winningSquare],
      receipt.amounts[winningSquare],
      round.winnerTotal,
    ), 0n);
    const baseMyneReward = !onWinningTile ? 0n
      : round.singleMinerRound ? (isSoloWinner ? round.bullionForWinners : 0n)
        : miner.receipts.reduce((sum, receipt) => sum + intervalReward(
          round.bullionForWinners,
          receipt.starts[winningSquare],
          receipt.amounts[winningSquare],
          round.winnerTotal,
        ), 0n);
    return {
      ...miner,
      receipts: undefined,
      tiles: miner.tileBets.filter((amount) => amount > 0n).length,
      wagered: miner.deployed,
      eth: winningSolReward,
      winningStake,
      winningTileTotal: round.winnerTotal,
      winningSolReward,
      motherlodeSolReward: 0n,
      prizeLamports: round.potForWinners,
      bullion: baseMyneReward,
      won: round.jackpotHit ? miner.deployed > 0n : (onWinningTile || isSoloWinner),
      onWinningTile,
      isSoloWinner,
      motherlodeShare: round.jackpotHit && miner.deployed > 0n,
      amountKnown: !round.jackpotHit,
    };
  }).sort((a, b) => a.deployed === b.deployed
    ? a.address.localeCompare(b.address)
    : (a.deployed > b.deployed ? -1 : 1));

  return {
    winningSquare,
    winnerTotal: round.winnerTotal,
    solo: round.singleMinerRound,
    winners: miners.filter((miner) => miner.won),
    miners,
  };
}

export async function loadIndexedMinerRoster(round) {
  if (!round?.resolved || round.projectionComplete !== true || !(await indexAvailable())) return null;
  try {
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data: chunk, error } = await supabase
        .from('mine_round_bets')
        .select('receipt,bettor,square,amount_wei::text,cumulative_start_wei::text,reward_mode')
        .eq('round_id', String(round.roundId))
        .order('receipt', { ascending: true })
        .order('square', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) return null;
      rows.push(...(chunk ?? []));
      if (!chunk || chunk.length < PAGE) break;
    }
    return indexedMinerRoster(round, rows);
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
    const { data: health, error: healthError } = await supabase
      .from('mine_rounds')
      .select('projection_complete')
      .eq('round_id', String(roundId))
      .limit(1);
    if (healthError || health?.[0]?.projection_complete !== true) return null;
    const data = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data: chunk, error } = await supabase
        .from('mine_round_bets')
        // ::text for the same reason as everywhere else — wei past 2^53 loses precision as a
        // bare JSON number. Page instead of imposing a silent participant ceiling.
        .select('bettor, square, amount_wei::text')
        .eq('round_id', String(roundId))
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
