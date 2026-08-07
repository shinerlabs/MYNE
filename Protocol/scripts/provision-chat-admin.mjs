/** Provision one wallet-scoped chat moderator without putting its address in Git. */
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';

const wallet = new PublicKey(process.env.CHAT_ADMIN_WALLET || '').toBase58();
const enabled = process.env.CHAT_ADMIN_ENABLED !== '0';
const apply = process.env.APPLY_CHAT_ADMIN === '1';
const maskedWallet = `${wallet.slice(0, 6)}…${wallet.slice(-5)}`;

const plan = {
  apply,
  enabled,
  wallet: maskedWallet,
  authorization: 'Supabase service-role-only RPC; chat-delete rechecks every request',
};

if (!apply) {
  console.log(JSON.stringify({
    ...plan,
    next: `Set APPLY_CHAT_ADMIN=1 and CONFIRM_CHAT_ADMIN_WALLET=${wallet} to apply`,
  }, null, 2));
  process.exit(0);
}

assert.equal(
  process.env.CONFIRM_CHAT_ADMIN_WALLET,
  wallet,
  `Set CONFIRM_CHAT_ADMIN_WALLET=${wallet} to authorize this role change`,
);
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
assert.match(supabaseUrl, /^https:\/\/[a-z0-9-]+\.supabase\.co$/i, 'SUPABASE_URL must be the exact HTTPS project URL');
assert.ok(serviceRoleKey.length >= 32, 'SUPABASE_SERVICE_ROLE_KEY is required');

const response = await fetch(`${supabaseUrl}/rest/v1/rpc/set_chat_admin`, {
  method: 'POST',
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    p_wallet_address: wallet,
    p_enabled: enabled,
  }),
});
const body = await response.text();
assert.ok(response.ok, `Chat admin provisioning failed (${response.status}): ${body.slice(0, 300)}`);
assert.equal(JSON.parse(body), enabled, 'The provisioning RPC returned an unexpected result');

console.log(JSON.stringify({ ok: true, enabled, wallet: maskedWallet }, null, 2));
