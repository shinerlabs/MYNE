import {
  bodyJson,
  CHAT_SESSION_PURPOSE,
  currentSessionEpoch,
  guardCors,
  isSolanaWalletAddress,
  json,
  rateLimitGuard,
  supabase,
} from '../_shared/common.ts';

const CHALLENGE_LIFETIME_MS = 5 * 60_000;

Deno.serve(async (req) => {
  const corsResponse = guardCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const payload = await bodyJson(req, 2_048);
  const walletAddress = payload?.walletAddress;
  if (!isSolanaWalletAddress(walletAddress)) return json(req, { error: 'Invalid wallet address' }, 400);

  const rateLimited = await rateLimitGuard(req, 'solana_nonce', walletAddress, 5, 300);
  if (rateLimited) return rateLimited;

  const sessionEpoch = await currentSessionEpoch();
  if (!sessionEpoch) return json(req, { error: 'Wallet authentication is temporarily unavailable' }, 503);

  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_LIFETIME_MS).toISOString();
  const message = [
    'MYNE Wallet Authentication',
    '',
    'Domain: myne.supply',
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Purpose: ${CHAT_SESSION_PURPOSE}`,
    `Expires: ${expiresAt}`,
  ].join('\n');
  const { error } = await supabase.from('auth_nonces').insert({
    nonce,
    wallet_address: walletAddress,
    message,
    purpose: CHAT_SESSION_PURPOSE,
    session_epoch: sessionEpoch,
    expires_at: expiresAt,
  });
  if (error) return json(req, { error: 'Could not create login challenge' }, 500);
  return json(req, { nonce, message, expiresAt });
});
