import { bodyJson, cors, json, requireSession, supabase } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const session = await requireSession(req);
  if (!session) return json({ error: 'Sign in required' }, 401);
  const { displayName, bio, avatar } = await bodyJson(req);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (displayName !== undefined) { if (typeof displayName !== 'string' || displayName.length > 32) return json({ error: 'Invalid display name' }, 400); patch.display_name = displayName.trim() || null; }
  if (bio !== undefined) { if (typeof bio !== 'string' || bio.length > 160) return json({ error: 'Invalid bio' }, 400); patch.bio = bio.trim() || null; }
  if (avatar?.dataUrl) { if (typeof avatar.dataUrl !== 'string' || avatar.dataUrl.length > 250_000) return json({ error: 'Avatar is too large' }, 400); patch.avatar_url = avatar.dataUrl; }
  const { data, error } = await supabase.from('profiles').upsert({ wallet_address: session.walletAddress, ...patch }).select('*').single();
  if (error) return json({ error: 'Could not save profile' }, 500);
  return json({ profile: { walletAddress: data.wallet_address, displayName: data.display_name, avatarUrl: data.avatar_url, bio: data.bio } });
});
