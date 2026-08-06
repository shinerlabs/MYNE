import { createClient } from 'npm:@supabase/supabase-js@2';
import bs58 from 'npm:bs58';
import nacl from 'npm:tweetnacl';

export const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-guest-id',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export const bodyJson = async (req: Request) => {
  try { return await req.json(); } catch { return {}; }
};

export function base64Bytes(value: string) {
  const raw = atob(value);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function verifyWalletSignature(wallet: string, message: string, signature: string) {
  try { return nacl.sign.detached.verify(new TextEncoder().encode(message), base64Bytes(signature), bs58.decode(wallet)); }
  catch { return false; }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const fromB64url = (value: string) => base64Bytes(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));

export async function signSession(walletAddress: string, expiresAt: number) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ walletAddress, exp: expiresAt })));
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

export async function requireSession(req: Request) {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const [payload, encodedSig] = token.split('.');
  if (!payload || !encodedSig) return null;
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, fromB64url(encodedSig), new TextEncoder().encode(payload));
  if (!valid) return null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return decoded.exp > Date.now() ? decoded : null;
  } catch { return null; }
}

export const broadcast = async (event: string, payload: unknown) => {
  const channel = supabase.channel('chat:global');
  await channel.subscribe();
  await channel.send({ type: 'broadcast', event, payload });
  await channel.unsubscribe();
};
