import { bodyJson, broadcast, cors, json, requireSession, supabase } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const session = await requireSession(req);
  if (!session) return json({ error: 'Sign in required' }, 401);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const { body } = await bodyJson(req);
  if (typeof body !== 'string' || body.trim().length < 1 || body.length > 300) return json({ error: 'Message must be 1–300 characters' }, 400);
  const { data: profile } = await supabase.from('profiles').select('display_name,avatar_url').eq('wallet_address', session.walletAddress).maybeSingle();
  const { data, error } = await supabase.from('chat_feed').insert({ wallet_address: session.walletAddress, display_name: profile?.display_name ?? null, avatar_url: profile?.avatar_url ?? null, body: body.trim() }).select('*').single();
  if (error) return json({ error: 'Could not send message' }, 500);
  await broadcast('message', data);
  return json({ message: data });
});
