import {
  bodyJson,
  broadcast,
  guardCors,
  json,
  rateLimitGuard,
  requireSession,
  supabase,
} from '../_shared/common.ts';

Deno.serve(async (req) => {
  const corsResponse = guardCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const session = await requireSession(req);
  if (!session) return json(req, { error: 'Sign in required' }, 401);
  const rateLimited = await rateLimitGuard(req, 'chat_delete', session.walletAddress, 30, 60);
  if (rateLimited) return rateLimited;

  const { data: admin, error: adminError } = await supabase
    .from('chat_admins')
    .select('wallet_address')
    .eq('wallet_address', session.walletAddress)
    .maybeSingle();
  if (adminError) return json(req, { error: 'Could not verify admin access' }, 500);
  if (!admin) return json(req, { error: 'Admin access required' }, 403);

  const payload = await bodyJson(req, 1_024);
  const messageId = payload?.messageId;
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0) {
    return json(req, { error: 'Invalid message id' }, 400);
  }
  const { data: deleted, error } = await supabase
    .from('chat_feed')
    .delete()
    .eq('id', messageId)
    .select('id')
    .maybeSingle();
  if (error) return json(req, { error: 'Could not delete message' }, 500);
  if (!deleted) return json(req, { error: 'Message not found' }, 404);
  await broadcast('message_delete', { id: messageId });
  return json(req, { ok: true });
});
