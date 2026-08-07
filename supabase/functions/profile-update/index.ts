import {
  bodyJson,
  broadcast,
  ensureWalletProfile,
  guardCors,
  json,
  rateLimitGuard,
  requireSession,
  supabase,
  validateAvatarDataUrl,
} from '../_shared/common.ts';

const hasControlCharacters = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);

Deno.serve(async (req) => {
  const corsResponse = guardCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const session = await requireSession(req);
  if (!session) return json(req, { error: 'Sign in required' }, 401);
  const rateLimited = await rateLimitGuard(req, 'profile_update', session.walletAddress, 10, 600);
  if (rateLimited) return rateLimited;

  const payload = await bodyJson(req, 300_000);
  if (!payload) return json(req, { error: 'Invalid profile update' }, 400);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (payload.displayName !== undefined) {
    if (typeof payload.displayName !== 'string') return json(req, { error: 'Invalid display name' }, 400);
    const displayName = payload.displayName.trim().normalize('NFKC');
    if (displayName.length > 24 || hasControlCharacters(displayName)) {
      return json(req, { error: 'Invalid display name' }, 400);
    }
    patch.display_name = displayName || null;
  }
  if (payload.bio !== undefined) {
    if (typeof payload.bio !== 'string') return json(req, { error: 'Invalid bio' }, 400);
    const bio = payload.bio.trim().normalize('NFKC');
    if (bio.length > 160 || hasControlCharacters(bio)) return json(req, { error: 'Invalid bio' }, 400);
    patch.bio = bio || null;
  }
  if (payload.avatar !== undefined) {
    if (!payload.avatar || typeof payload.avatar !== 'object' || Array.isArray(payload.avatar)) {
      return json(req, { error: 'Invalid avatar' }, 400);
    }
    const dataUrl = (payload.avatar as Record<string, unknown>).dataUrl;
    if (dataUrl === null) patch.avatar_url = null;
    else {
      const avatarUrl = validateAvatarDataUrl(dataUrl);
      if (!avatarUrl) return json(req, { error: 'Avatar must be a valid PNG, JPEG or WebP under 180KB' }, 400);
      patch.avatar_url = avatarUrl;
    }
  }
  if (Object.keys(patch).length === 1) return json(req, { error: 'No profile changes supplied' }, 400);
  if (!await ensureWalletProfile(session.walletAddress)) {
    return json(req, { error: 'Could not save profile' }, 500);
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('wallet_address', session.walletAddress)
    .select('wallet_address,display_name,avatar_url,bio')
    .single();
  if (error?.code === '23505') return json(req, { error: 'That username is already in use' }, 409);
  if (error) return json(req, { error: 'Could not save profile' }, 500);

  await broadcast('profile', {
    walletAddress: data.wallet_address,
    displayName: data.display_name,
    avatarUrl: data.avatar_url,
    bio: data.bio,
  });
  return json(req, {
    profile: {
      walletAddress: data.wallet_address,
      displayName: data.display_name,
      avatarUrl: data.avatar_url,
      bio: data.bio,
    },
  });
});
