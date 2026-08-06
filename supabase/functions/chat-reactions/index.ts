import { cors, json, requireSession, supabase } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const session = await requireSession(req);
  const ids = (new URL(req.url).searchParams.get('ids') || '').split(',').map(Number).filter(Number.isInteger);
  if (!ids.length) return json({ reactions: {}, mine: [] });
  const { data } = await supabase.from('chat_reactions').select('message_id,wallet_address,emoji').in('message_id', ids);
  const reactions: Record<string, { emoji: string; count: number }[]> = {};
  for (const row of data || []) {
    const key = String(row.message_id); const list = reactions[key] || []; const found = list.find((x) => x.emoji === row.emoji);
    if (found) found.count += 1; else list.push({ emoji: row.emoji, count: 1 }); reactions[key] = list;
  }
  const mine = (data || []).filter((r) => session && r.wallet_address === session.walletAddress).map((r) => `${r.message_id}:${r.emoji}`);
  return json({ reactions, mine });
});
