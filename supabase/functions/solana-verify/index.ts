import { bodyJson, cors, json, signSession, supabase, verifyWalletSignature } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const { walletAddress, nonce, message, signature } = await bodyJson(req);
  if (![walletAddress, nonce, message, signature].every((v) => typeof v === 'string')) return json({ error: 'Incomplete login challenge' }, 400);
  const { data: row } = await supabase.from('auth_nonces').select('*').eq('nonce', nonce).eq('wallet_address', walletAddress).maybeSingle();
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now() || row.message !== message) return json({ error: 'Challenge expired or invalid' }, 401);
  if (!verifyWalletSignature(walletAddress, message, signature)) return json({ error: 'Signature verification failed' }, 401);
  await supabase.from('auth_nonces').update({ used_at: new Date().toISOString() }).eq('nonce', nonce);
  const expiresAt = Date.now() + 24 * 60 * 60_000;
  return json({ token: await signSession(walletAddress, expiresAt), expiresAt: new Date(expiresAt).toISOString() });
});
