import { bodyJson, cors, json, supabase } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const { walletAddress } = await bodyJson(req);
  if (typeof walletAddress !== 'string' || walletAddress.length < 32 || walletAddress.length > 50) return json({ error: 'Invalid wallet address' }, 400);
  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const message = `Sign in to MYNE Chat\n\nWallet: ${walletAddress}\nNonce: ${nonce}\nExpires: ${expiresAt}`;
  const { error } = await supabase.from('auth_nonces').insert({ nonce, wallet_address: walletAddress, message, expires_at: expiresAt });
  if (error) return json({ error: 'Could not create login challenge' }, 500);
  return json({ nonce, message, expiresAt });
});
