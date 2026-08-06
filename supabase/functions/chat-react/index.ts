import { bodyJson, broadcast, cors, json, requireSession, supabase } from '../_shared/common.ts';
const allowed = new Set(['👍','🔥','😂','😮','😢','💎','🚀','🧂']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const session = await requireSession(req);
  if (!session) return json({ error: 'Sign in required' }, 401);
  const { messageId, emoji } = await bodyJson(req);
  if (!Number.isInteger(messageId) || !allowed.has(emoji)) return json({ error: 'Invalid reaction' }, 400);
  const { data: existing } = await supabase.from('chat_reactions').select('message_id').eq('message_id', messageId).eq('wallet_address', session.walletAddress).eq('emoji', emoji).maybeSingle();
  let reacted = false;
  if (existing) await supabase.from('chat_reactions').delete().match({ message_id: messageId, wallet_address: session.walletAddress, emoji });
  else { await supabase.from('chat_reactions').insert({ message_id: messageId, wallet_address: session.walletAddress, emoji }); reacted = true; }
  const { count } = await supabase.from('chat_reactions').select('*', { count: 'exact', head: true }).eq('message_id', messageId).eq('emoji', emoji);
  await broadcast('reaction', { messageId, emoji, count: count ?? 0, reacted, walletAddress: session.walletAddress });
  return json({ count: count ?? 0, reacted });
});
