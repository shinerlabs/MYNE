import {
  bodyJson,
  broadcast,
  ensureWalletProfile,
  guardCors,
  json,
  rateLimitGuard,
  requireSession,
  supabase,
} from '../_shared/common.ts';
import { CHAT_MIN_MYNE_BASE_UNITS, readMyneChatBalance } from '../_shared/myne-chat-balance.ts';

const balanceGateEnabled = (): boolean =>
  Deno.env.get('CHAT_REQUIRE_MYNE_BALANCE') === 'true'
  // One-release compatibility: the former flag now enables the safer balance gate.
  || Deno.env.get('CHAT_REQUIRE_MINED_ROUNDS') === 'true';

Deno.serve(async (req) => {
  const corsResponse = guardCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const session = await requireSession(req);
  if (!session) return json(req, { error: 'Sign in with your wallet to chat' }, 401);
  const rateLimited = await rateLimitGuard(req, 'chat_send', session.walletAddress, 12, 60);
  if (rateLimited) return rateLimited;

  const payload = await bodyJson(req, 4_096);
  const body = payload?.body;
  if (typeof body !== 'string') return json(req, { error: 'Message must be 1–300 characters' }, 400);
  const normalizedBody = body.trim();
  if (normalizedBody.length < 1 || normalizedBody.length > 300) {
    return json(req, { error: 'Message must be 1–300 characters' }, 400);
  }

  if (balanceGateEnabled()) {
    try {
      const balance = await readMyneChatBalance(session.walletAddress);
      if (!balance.eligible || balance.totalBaseUnits < CHAT_MIN_MYNE_BASE_UNITS) {
        return json(req, {
          error: 'Hold at least 0.01 MYNE in your wallet, mining rewards, or staking position to unlock chat',
        }, 403);
      }
    } catch {
      console.error('MYNE chat balance verification failed');
      return json(req, { error: 'Could not verify your MYNE balance' }, 500);
    }
  }

  if (!await ensureWalletProfile(session.walletAddress)) {
    return json(req, { error: 'Could not verify chat access' }, 500);
  }
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('display_name,avatar_url,banned')
    .eq('wallet_address', session.walletAddress)
    .single();
  if (profileError) return json(req, { error: 'Could not verify chat access' }, 500);
  if (profile.banned) return json(req, { error: 'This wallet is banned from chat' }, 403);

  const { data, error } = await supabase.from('chat_feed').insert({
    wallet_address: session.walletAddress,
    display_name: profile.display_name ?? null,
    avatar_url: profile.avatar_url ?? null,
    body: normalizedBody,
  }).select('*').single();
  if (error) return json(req, { error: 'Could not send message' }, 500);
  await broadcast('message', data);
  return json(req, { message: data });
});
