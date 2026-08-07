import {
  bodyJson,
  CHAT_SESSION_PURPOSE,
  ensureWalletProfile,
  guardCors,
  isNonce,
  isSolanaWalletAddress,
  isUuid,
  json,
  rateLimitGuard,
  signSession,
  supabase,
  verifyWalletSignature,
} from '../_shared/common.ts';

const SESSION_LIFETIME_MS = 24 * 60 * 60_000;

Deno.serve(async (req) => {
  const corsResponse = guardCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const payload = await bodyJson(req, 4_096);
  const walletAddress = payload?.walletAddress;
  const nonce = payload?.nonce;
  const message = payload?.message;
  const signature = payload?.signature;
  if (!isSolanaWalletAddress(walletAddress)
    || !isNonce(nonce)
    || typeof message !== 'string' || message.length < 1 || message.length > 1_024
    || typeof signature !== 'string' || signature.length > 128) {
    return json(req, { error: 'Incomplete or invalid login challenge' }, 400);
  }

  const rateLimited = await rateLimitGuard(req, 'solana_verify', walletAddress, 10, 300);
  if (rateLimited) return rateLimited;

  const { data: row, error: lookupError } = await supabase
    .from('auth_nonces')
    .select('nonce,wallet_address,message,purpose,session_epoch,expires_at,used_at')
    .eq('nonce', nonce)
    .eq('wallet_address', walletAddress)
    .eq('purpose', CHAT_SESSION_PURPOSE)
    .maybeSingle();
  if (lookupError) return json(req, { error: 'Could not verify login challenge' }, 500);
  if (!row
    || row.used_at
    || row.message !== message
    || row.purpose !== CHAT_SESSION_PURPOSE
    || !isUuid(row.session_epoch)
    || new Date(row.expires_at).getTime() <= Date.now()) {
    return json(req, { error: 'Challenge expired or invalid' }, 401);
  }
  if (!verifyWalletSignature(walletAddress, row.message, signature)) {
    return json(req, { error: 'Signature verification failed' }, 401);
  }

  // This RPC performs the compare-and-set atomically and checks the current session epoch.
  const { data: consumed, error: consumeError } = await supabase.rpc('consume_solana_nonce', {
    p_wallet_address: walletAddress,
    p_nonce: nonce,
    p_message: row.message,
    p_purpose: CHAT_SESSION_PURPOSE,
  });
  if (consumeError) return json(req, { error: 'Could not verify login challenge' }, 500);
  if (consumed !== true) return json(req, { error: 'Challenge expired or already used' }, 401);
  if (!await ensureWalletProfile(walletAddress)) return json(req, { error: 'Could not start wallet session' }, 500);
  const { data: sessionAllowed, error: sessionError } = await supabase.rpc('is_chat_session_current', {
    p_session_epoch: row.session_epoch,
    p_wallet_address: walletAddress,
  });
  if (sessionError) return json(req, { error: 'Could not start wallet session' }, 500);
  if (sessionAllowed !== true) return json(req, { error: 'This wallet cannot use chat' }, 403);

  // UI hint only: chat-delete repeats this exact server-side lookup for every
  // moderation request. Never authorize deletion from the signed token claim.
  const { data: admin, error: adminError } = await supabase
    .from('chat_admins')
    .select('wallet_address')
    .eq('wallet_address', walletAddress)
    .maybeSingle();
  if (adminError) return json(req, { error: 'Could not verify chat role' }, 500);

  const expiresAt = Date.now() + SESSION_LIFETIME_MS;
  const token = await signSession(walletAddress, expiresAt, row.session_epoch);
  return json(req, {
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    isAdmin: Boolean(admin),
  });
});
