import { createClient } from '@supabase/supabase-js';

/**
 * Supabase wiring for the social layer (chat, profiles, and follows).
 *
 * In development everything goes through Vite's same-origin `/supabase` proxy:
 *   - the browser never talks to *.supabase.co directly (fewer CORS/leak surfaces)
 *   - the anon key is public by design; RLS + Edge Functions enforce every write
 *   - SERVICE_ROLE must never appear in a VITE_* var or in this bundle
 *
 * `import.meta.env.MODE` is the build mode, not NODE_ENV — a production build
 * served locally still resolves to the remote URL, which is what we want.
 *
 * Production talks directly to the deployed Supabase project. Development uses Vite's
 * same-origin proxy so local CORS and Realtime behavior match the hosted service.
 */
// These are publishable client values, but production must provide them explicitly. A baked-in
// project fallback can silently point a Mainnet bundle at the wrong database after a migration.
export const REMOTE_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const useProxy = Boolean(import.meta.env.DEV);
export const SUPABASE_URL = useProxy ? `${window.location.origin}/supabase` : REMOTE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export const isSocialConfigured = Boolean(REMOTE_SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = isSocialConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Chat authenticates with Solana message-signing session tokens, not GoTrue.
      // Persisting a GoTrue JWT here makes Realtime join with a stale token and
      // the connection lands permanently Offline.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'myne-chat-gotrue-unused',
    },
    realtime: {
      params: { eventsPerSecond: 10 },
      timeout: 20000,
    },
  })
  : null;

/** Chat topic — must match the Edge Functions' broadcast target. */
export const CHAT_TOPIC = 'chat:global';

/** Newest N messages kept in the DOM. No infinite scrollback. */
export const HISTORY_LIMIT = 100;

/**
 * Must match the CHECK constraint in 0003_chat_social.sql and the allowlist in
 * the chat-react function. Anything outside this set is rejected server-side.
 */
export const REACTIONS = ['👍', '🔥', '😂', '😮', '😢', '💎', '🚀', '🧂'];

export const shortWallet = (address) =>
  (typeof address === 'string' && address.length >= 10
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : String(address ?? ''));

/** fetch + JSON + timeout, with error text a user can act on. */
export const fetchJson = async (url, options = {}, timeoutMs = 20000) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Request timed out — check your network, or disable wallet/ad-block extensions that intercept requests');
    }
    throw new Error(err?.message?.includes('Failed to fetch')
      ? 'Cannot reach the chat backend — a browser extension or service worker may be intercepting requests'
      : (err?.message || 'Network request failed'));
  } finally {
    window.clearTimeout(timer);
  }
};
