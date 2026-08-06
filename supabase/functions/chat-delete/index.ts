import { bodyJson, broadcast, cors, json, requireSession, supabase } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const session = await requireSession(req);
  if (!session) return json({ error: 'Sign in required' }, 401);
  const { data: admin } = await supabase.from('chat_admins').select('wallet_address').eq('wallet_address', session.walletAddress).maybeSingle();
  if (!admin) return json({ error: 'Admin access required' }, 403);
  const { messageId } = await bodyJson(req);
  if (!Number.isInteger(messageId)) return json({ error: 'Invalid message id' }, 400);
  const { error } = await supabase.from('chat_feed').delete().eq('id', messageId);
  if (error) return json({ error: 'Could not delete message' }, 500);
  await broadcast('delete', { messageId });
  return json({ ok: true });
});
