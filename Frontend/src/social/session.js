import { getProvider } from '../chain/client.js';
import { FUNCTIONS_URL, fetchJson } from './config.js';

const CHAT_SESSION_KEY = 'myne-solana-chat-session-v3';
const RETIRED_CHAT_SESSION_KEYS = [
  'myne-solana-chat-session-v2',
  'myne-solana-chat-session-v1',
  'gld-solana-chat-session',
];
let session = loadStoredSession();
let getConnectedWallet = () => null;
let notify = () => {};

export const configureSession = (opts) => {
  if (opts.getConnectedWallet) getConnectedWallet = opts.getConnectedWallet;
  if (opts.notify) notify = opts.notify;
};
function loadStoredSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(CHAT_SESSION_KEY));
    if (stored?.token && new Date(stored.expiresAt).getTime() >= Date.now()) {
      return { ...stored, isAdmin: stored.isAdmin === true };
    }
  } catch { /* ignore malformed or unavailable storage */ }
  return null;
}
export const getSession = () => session;
const saveSession = (next) => {
  session = next;
  try {
    localStorage.setItem(CHAT_SESSION_KEY, JSON.stringify(next));
    for (const key of RETIRED_CHAT_SESSION_KEYS) localStorage.removeItem(key);
  } catch { /* private mode */ }
};
export const clearSession = () => {
  session = null;
  try {
    localStorage.removeItem(CHAT_SESSION_KEY);
    for (const key of RETIRED_CHAT_SESSION_KEYS) localStorage.removeItem(key);
  } catch { /* ignore */ }
};
const signatureBase64 = (signature) => {
  const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature || []);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

async function signIn(provider, walletAddress) {
  if (!provider?.signMessage) throw new Error('This Solana wallet does not support message signing');
  const { res: nonceRes, data: nonceBody } = await fetchJson(`${FUNCTIONS_URL}/solana-nonce`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletAddress }),
  });
  if (!nonceRes.ok) throw new Error(nonceBody.error || 'Could not start wallet login');
  const { nonce, message } = nonceBody;
  if (!nonce || !message) throw new Error('The login challenge was incomplete');
  const signed = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
  const signature = signatureBase64(signed?.signature || signed);
  const { res, data } = await fetchJson(`${FUNCTIONS_URL}/solana-verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress, nonce, message, signature }),
  });
  if (!res.ok) throw new Error(data.error || 'Signature verification failed');
  if (!data.token) throw new Error('Session token missing from the server response');
  // This is a display hint only. The delete Edge Function independently checks
  // chat_admins on every request, so a modified browser session cannot grant
  // moderation authority.
  const next = {
    token: data.token,
    walletAddress,
    expiresAt: data.expiresAt,
    isAdmin: data.isAdmin === true,
  };
  saveSession(next);
  return next;
}

export async function ensureSession({ force = false } = {}) {
  const wallet = getConnectedWallet();
  if (force) clearSession();
  if (session?.token && session.walletAddress === wallet && new Date(session.expiresAt).getTime() >= Date.now()) return session;
  if (!wallet) throw new Error('Connect your wallet first');
  const provider = getProvider();
  if (!provider) throw new Error('No Solana wallet found');
  notify('Approve the sign-in message in your wallet…');
  return signIn(provider, wallet);
}

export async function authedFetchJson(url, options = {}, timeoutMs = 20000) {
  const withAuth = (token) => ({ ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  let current = await ensureSession();
  let result = await fetchJson(url, withAuth(current.token), timeoutMs);
  if (result.res.status === 401) {
    current = await ensureSession({ force: true });
    result = await fetchJson(url, withAuth(current.token), timeoutMs);
  }
  return { ...result, session: current };
}
