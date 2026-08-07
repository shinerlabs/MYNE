import { createClient } from 'npm:@supabase/supabase-js@2';
import bs58 from 'npm:bs58';
import nacl from 'npm:tweetnacl';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export const CHAT_SESSION_PURPOSE = 'chat_session';
const CHAT_SESSION_VERSION = 2;
const CHAT_SESSION_ISSUER = 'myne-wallet-auth';
const CHAT_SESSION_AUDIENCE = 'myne-chat';
const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_JSON_BODY_BYTES = 512 * 1024;
const MAX_AVATAR_BYTES = 180 * 1024;
const PROD_ORIGINS = new Set(['https://myne.supply', 'https://www.myne.supply']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type JsonRecord = Record<string, unknown>;

export type ChatSession = {
  v: number;
  iss: string;
  aud: string;
  sub: string;
  walletAddress: string;
  sessionEpoch: string;
  iat: number;
  exp: number;
  jti: string;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return url.origin === origin
      && (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

/**
 * Production origins are fixed. Local browser origins are accepted only when an operator
 * explicitly lists them in MYNE_CORS_LOCAL_ORIGINS (comma-separated); arbitrary hosted
 * origins cannot be added through that variable by mistake.
 */
const allowedOrigins = (): Set<string> => {
  const allowed = new Set(PROD_ORIGINS);
  const configured = Deno.env.get('MYNE_CORS_LOCAL_ORIGINS') || '';
  for (const candidate of configured.split(',').map((value) => value.trim()).filter(Boolean)) {
    if (isLoopbackOrigin(candidate)) allowed.add(candidate);
  }
  return allowed;
};

export const isAllowedOrigin = (origin: string | null): boolean =>
  !origin || allowedOrigins().has(origin);

export const corsHeaders = (req: Request): Headers => {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  });
  const origin = req.headers.get('origin');
  if (origin && isAllowedOrigin(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
};

export const json = (req: Request, body: unknown, status = 200, extraHeaders?: HeadersInit): Response => {
  const headers = corsHeaders(req);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
};

/** Reject disallowed browser origins and answer valid preflights before any DB work. */
export const guardCors = (req: Request): Response | null => {
  const origin = req.headers.get('origin');
  if (!isAllowedOrigin(origin)) return json(req, { error: 'Origin not allowed' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  return null;
};

export const bodyJson = async (req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonRecord | null> => {
  const contentType = (req.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return null;
  const declaredLength = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  try {
    const text = await req.text();
    if (!text || new TextEncoder().encode(text).byteLength > maxBytes) return null;
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
};

const decodeCanonicalBase64 = (value: string): Uint8Array | null => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const raw = atob(value);
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    return bytesToBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
};

const b64url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const fromB64url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const raw = atob(padded);
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    return b64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
};

export const isSolanaWalletAddress = (value: unknown): value is string => {
  if (typeof value !== 'string' || !WALLET_PATTERN.test(value)) return false;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bs58.encode(bytes) === value;
  } catch {
    return false;
  }
};

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && ANY_UUID_PATTERN.test(value);

export const isNonce = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);

export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  if (!isSolanaWalletAddress(wallet) || typeof message !== 'string' || message.length > 1_024) return false;
  const signatureBytes = decodeCanonicalBase64(signature);
  if (!signatureBytes || signatureBytes.length !== nacl.sign.signatureLength) return false;
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      signatureBytes,
      bs58.decode(wallet),
    );
  } catch {
    return false;
  }
}

const sessionSecret = (): string =>
  Deno.env.get('CHAT_SESSION_SECRET') || SUPABASE_SERVICE_ROLE_KEY;

const sessionKey = async (usage: KeyUsage[]): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sessionSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  );

export async function currentSessionEpoch(): Promise<string | null> {
  const { data, error } = await supabase.rpc('current_chat_session_epoch');
  return !error && isUuid(data) ? data : null;
}

export async function signSession(
  walletAddress: string,
  expiresAt: number,
  sessionEpoch: string,
): Promise<string> {
  if (!isSolanaWalletAddress(walletAddress) || !isUuid(sessionEpoch)) throw new Error('Invalid session identity');
  const now = Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > MAX_SESSION_LIFETIME_MS) {
    throw new Error('Invalid session expiry');
  }
  const claims: ChatSession = {
    v: CHAT_SESSION_VERSION,
    iss: CHAT_SESSION_ISSUER,
    aud: CHAT_SESSION_AUDIENCE,
    sub: walletAddress,
    walletAddress,
    sessionEpoch,
    iat: now,
    exp: expiresAt,
    jti: crypto.randomUUID(),
  };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await sessionKey(['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${payload}.${b64url(signature)}`;
}

const validSessionClaims = (value: unknown, now: number): value is ChatSession => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  const expectedKeys = ['aud', 'exp', 'iat', 'iss', 'jti', 'sessionEpoch', 'sub', 'v', 'walletAddress'].sort().join(',');
  if (keys !== expectedKeys) return false;
  const claims = value as ChatSession;
  return claims.v === CHAT_SESSION_VERSION
    && claims.iss === CHAT_SESSION_ISSUER
    && claims.aud === CHAT_SESSION_AUDIENCE
    && claims.sub === claims.walletAddress
    && isSolanaWalletAddress(claims.walletAddress)
    && isUuid(claims.sessionEpoch)
    && isUuid(claims.jti)
    && Number.isSafeInteger(claims.iat)
    && Number.isSafeInteger(claims.exp)
    && claims.iat <= now + 60_000
    && claims.exp > now
    && claims.exp > claims.iat
    && claims.exp - claims.iat <= MAX_SESSION_LIFETIME_MS;
};

export async function requireSession(req: Request): Promise<ChatSession | null> {
  const header = req.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
  if (!match || match[1].length > 2_048) return null;
  const parts = match[1].split('.');
  if (parts.length !== 2) return null;
  const payloadBytes = fromB64url(parts[0]);
  const signatureBytes = fromB64url(parts[1]);
  if (!payloadBytes || !signatureBytes || signatureBytes.length !== 32) return null;
  const key = await sessionKey(['verify']);
  const validSignature = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    new TextEncoder().encode(parts[0]),
  );
  if (!validSignature) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
  } catch {
    return null;
  }
  if (!validSessionClaims(claims, Date.now())) return null;
  const { data: isCurrent, error } = await supabase.rpc('is_chat_session_current', {
    p_session_epoch: claims.sessionEpoch,
    p_wallet_address: claims.walletAddress,
  });
  return !error && isCurrent === true ? claims : null;
}

const clientIp = (req: Request): string => {
  const candidate = req.headers.get('cf-connecting-ip')
    || req.headers.get('x-real-ip')
    || req.headers.get('x-forwarded-for')?.split(',')[0]
    || 'unknown';
  const normalized = candidate.trim().toLowerCase();
  return normalized && normalized.length <= 64 ? normalized : 'unknown';
};

const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export async function enforceRateLimit(
  req: Request,
  action: string,
  walletAddress: string | null,
  limit: number,
  windowSeconds: number,
): Promise<{ result: RateLimitResult | null; error: boolean }> {
  if (!/^[a-z_]{3,32}$/.test(action)
    || (walletAddress !== null && !isSolanaWalletAddress(walletAddress))
    || !Number.isInteger(limit) || limit < 1 || limit > 1_000
    || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400) {
    return { result: null, error: true };
  }
  const pepper = Deno.env.get('RATE_LIMIT_HASH_SECRET') || sessionSecret();
  const ipHash = await sha256Hex(`${pepper}\u0000${clientIp(req)}`);
  const { data, error } = await supabase.rpc('enforce_chat_rate_limit', {
    p_wallet_address: walletAddress,
    p_ip_hash: ipHash,
    p_action: action,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error || !isRecord(data)) return { result: null, error: true };
  const allowed = data.allowed;
  const remaining = Number(data.remaining);
  const retryAfterSeconds = Number(data.retry_after_seconds);
  if (typeof allowed !== 'boolean' || !Number.isFinite(remaining) || !Number.isFinite(retryAfterSeconds)) {
    return { result: null, error: true };
  }
  return {
    result: {
      allowed,
      remaining: Math.max(0, Math.floor(remaining)),
      retryAfterSeconds: Math.max(0, Math.ceil(retryAfterSeconds)),
    },
    error: false,
  };
}

export async function rateLimitGuard(
  req: Request,
  action: string,
  walletAddress: string | null,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  const { result, error } = await enforceRateLimit(req, action, walletAddress, limit, windowSeconds);
  if (error || !result) return json(req, { error: 'Could not verify request rate' }, 503);
  if (result.allowed) return null;
  return json(
    req,
    { error: 'Too many requests. Please try again shortly.' },
    429,
    { 'Retry-After': String(Math.max(1, result.retryAfterSeconds)) },
  );
}

export async function ensureWalletProfile(walletAddress: string): Promise<boolean> {
  if (!isSolanaWalletAddress(walletAddress)) return false;
  const { error } = await supabase
    .from('profiles')
    .upsert({ wallet_address: walletAddress }, { onConflict: 'wallet_address', ignoreDuplicates: true });
  return !error;
}

const hasMagic = (bytes: Uint8Array, expected: number[], offset = 0): boolean =>
  expected.every((byte, index) => bytes[offset + index] === byte);

/** Validate the MIME, canonical base64, decoded size and raster file signature. */
export function validateAvatarDataUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 250_000) return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = decodeCanonicalBase64(match[2]);
  if (!bytes || bytes.length < 12 || bytes.length > MAX_AVATAR_BYTES) return null;
  const valid = match[1] === 'png'
    ? hasMagic(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : match[1] === 'jpeg'
      ? hasMagic(bytes, [0xff, 0xd8, 0xff]) && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
      : hasMagic(bytes, [0x52, 0x49, 0x46, 0x46]) && hasMagic(bytes, [0x57, 0x45, 0x42, 0x50], 8);
  return valid ? value : null;
}

export const broadcast = async (event: string, payload: unknown): Promise<void> => {
  const channel = supabase.channel('chat:global');
  await channel.subscribe();
  await channel.send({ type: 'broadcast', event, payload });
  await channel.unsubscribe();
};
