import {
  bodyJson,
  broadcast,
  ensureWalletProfile,
  guardCors,
  json,
  rateLimitGuard,
  requireSession,
  supabase,
} from '../_shared/common.ts';

const allowed = new Set(['👍', '🔥', '😂', '😮', '😢', '💎', '🚀', '🧂']);

Deno.serve(async (req) => {
  const corsResponse = guardCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const session = await requireSession(req);
  if (!session) return json(req, { error: 'Sign in required' }, 401);
  const rateLimited = await rateLimitGuard(req, 'chat_react', session.walletAddress, 60, 60);
  if (rateLimited) return rateLimited;

  const payload = await bodyJson(req, 2_048);
  const messageId = payload?.messageId;
  const emoji = payload?.emoji;
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0
    || typeof emoji !== 'string' || !allowed.has(emoji)) {
    return json(req, { error: 'Invalid reaction' }, 400);
  }
  if (!await ensureWalletProfile(session.walletAddress)) {
    return json(req, { error: 'Could not save reaction' }, 500);
  }

  const key = {
    message_id: messageId,
    wallet_address: session.walletAddress,
    emoji,
  };
  const { data: existing, error: lookupError } = await supabase
    .from('chat_reactions')
    .select('message_id')
    .match(key)
    .maybeSingle();
  if (lookupError) return json(req, { error: 'Could not save reaction' }, 500);

  let reacted = false;
  if (existing) {
    const { error } = await supabase.from('chat_reactions').delete().match(key);
    if (error) return json(req, { error: 'Could not save reaction' }, 500);
  } else {
    const { error } = await supabase.from('chat_reactions').insert(key);
    if (error) return json(req, { error: 'Could not save reaction' }, 500);
    reacted = true;
  }
  const { count, error: countError } = await supabase
    .from('chat_reactions')
    .select('*', { count: 'exact', head: true })
    .eq('message_id', messageId)
    .eq('emoji', emoji);
  if (countError) return json(req, { error: 'Could not load reactions' }, 500);
  await broadcast('reaction', {
    messageId,
    emoji,
    count: count ?? 0,
    reacted,
    walletAddress: session.walletAddress,
  });
  return json(req, { count: count ?? 0, reacted });
});
