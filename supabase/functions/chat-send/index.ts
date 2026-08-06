import { bodyJson, broadcast, cors, json, requireSession, supabase } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const session = await requireSession(req);
  const guestId = req.headers.get('x-guest-id')?.trim() || '';
  const isGuest = !session && /^guest_[a-z0-9-]{12,100}$/i.test(guestId);
  if (!session && !isGuest) return json({ error: 'Guest identity missing' }, 401);
  // Mainnet can switch on server-side enforcement with CHAT_REQUIRE_MINED_ROUNDS=true. Devnet
  // and testnet deliberately leave guest chat open for testing and onboarding.
  if (Deno.env.get('CHAT_REQUIRE_MINED_ROUNDS') === 'true') {
    if (!session) return json({ error: 'Connect a wallet to use mainnet chat' }, 401);
    const { data: bets, error: betError } = await supabase
      .from('mine_round_bets').select('round_id').eq('bettor', session.walletAddress.toLowerCase()).limit(10000);
    const minedRounds = new Set((bets ?? []).map((row) => String(row.round_id)));
    if (betError || minedRounds.size < 5) return json({ error: 'Mine at least 5 rounds to unlock chat' }, 403);
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const { body } = await bodyJson(req);
  if (typeof body !== 'string' || body.trim().length < 1 || body.length > 300) return json({ error: 'Message must be 1–300 characters' }, 400);
  const { data: profile } = session
    ? await supabase.from('profiles').select('display_name,avatar_url').eq('wallet_address', session.walletAddress).maybeSingle()
    : { data: null };
  const { data, error } = await supabase.from('chat_feed').insert({
    wallet_address: session?.walletAddress ?? null,
    guest_id: isGuest ? guestId : null,
    display_name: profile?.display_name ?? (isGuest ? 'Guest' : null),
    avatar_url: profile?.avatar_url ?? null,
    body: body.trim(),
  }).select('*').single();
  if (error) return json({ error: 'Could not send message' }, 500);
  await broadcast('message', data);
  return json({ message: data });
});
