import {
  guardCors,
  json,
  rateLimitGuard,
  requireSession,
  supabase,
} from '../_shared/common.ts';

const MAX_MESSAGE_IDS = 100;

Deno.serve(async (req) => {
  const corsResponse = guardCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'GET') return json(req, { error: 'Method not allowed' }, 405);

  const hasAuthorization = Boolean(req.headers.get('authorization'));
  const session = hasAuthorization ? await requireSession(req) : null;
  if (hasAuthorization && !session) return json(req, { error: 'Invalid wallet session' }, 401);
  const rateLimited = await rateLimitGuard(
    req,
    'chat_reactions',
    session?.walletAddress ?? null,
    120,
    60,
  );
  if (rateLimited) return rateLimited;

  const requested = (new URL(req.url).searchParams.get('ids') || '')
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const ids = [...new Set(requested)].slice(0, MAX_MESSAGE_IDS);
  if (!ids.length) return json(req, { reactions: {}, mine: [] });

  const { data, error } = await supabase
    .from('chat_reactions')
    .select('message_id,wallet_address,emoji')
    .in('message_id', ids);
  if (error) return json(req, { error: 'Could not load reactions' }, 500);

  const reactions: Record<string, { emoji: string; count: number }[]> = {};
  for (const row of data || []) {
    const key = String(row.message_id);
    const list = reactions[key] || [];
    const found = list.find((entry) => entry.emoji === row.emoji);
    if (found) found.count += 1;
    else list.push({ emoji: row.emoji, count: 1 });
    reactions[key] = list;
  }
  const mine = session
    ? (data || [])
      .filter((row) => row.wallet_address === session.walletAddress)
      .map((row) => `${row.message_id}:${row.emoji}`)
    : [];
  return json(req, { reactions, mine });
});
