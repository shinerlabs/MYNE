import {
  bodyJson,
  guardCors,
  json,
  rateLimitGuard,
  requireSession,
  supabase,
} from '../_shared/common.ts';

const MAX_ROUND_IDS = 50;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const ROUND_ID_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;

const normalizeRoundIds = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > MAX_ROUND_IDS) return null;
  const ids = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !ROUND_ID_PATTERN.test(candidate)) return null;
    const id = BigInt(candidate);
    if (id > MAX_SIGNED_BIGINT) return null;
    ids.add(id.toString());
  }
  return [...ids].sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? -1 : 1;
  });
};

Deno.serve(async (req) => {
  const corsResponse = guardCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const session = await requireSession(req);
  if (!session) return json(req, { error: 'Invalid wallet session' }, 401);
  const rateLimited = await rateLimitGuard(
    req,
    'wallet_round_history',
    session.walletAddress,
    120,
    60,
  );
  if (rateLimited) return rateLimited;

  const payload = await bodyJson(req, 8 * 1024);
  const roundIds = normalizeRoundIds(payload?.roundIds);
  if (!roundIds) {
    return json(req, { error: 'roundIds must contain at most 50 nonnegative decimal strings' }, 400);
  }
  if (!roundIds.length) return json(req, { rows: [] });

  // The signed session owns the wallet argument. Never accept an address from
  // the request body: otherwise callers could enumerate another wallet's
  // archived settlement history through the service-role client.
  const { data, error } = await supabase.rpc('mine_wallet_round_history_v1', {
    p_wallet: session.walletAddress,
    p_round_ids: roundIds,
  });
  if (error) return json(req, { error: 'Could not load wallet round history' }, 500);

  return json(req, {
    rows: (data || []).map((row) => ({
      roundId: String(row.round_id),
      positionLamports: String(row.position_lamports),
      winningReceipts: String(row.winning_receipts),
      processedWinningReceipts: String(row.processed_winning_receipts),
      claimed: row.claimed === true,
    })),
  });
});
