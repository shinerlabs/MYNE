import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Mainnet address derivation never creates or invites funding a PDA', async () => {
  const source = await read('../scripts/derive-mainnet-addresses.mjs');
  assert.match(source, /PublicKey\.findProgramAddressSync/);
  assert.match(source, /created: false/);
  assert.match(source, /Do not send SOL to any derived PDA/);
  assert.match(source, /MAINNET_TRANSACTION_PAYER/);
  assert.match(source, /MAINNET_ADMIN_FEE_WALLET/);
  assert.match(source, /MAINNET_REFERRAL_FALLBACK_WALLET/);
  assert.doesNotMatch(source, /7VHaD8JMcdLo3c9PC7xgLnACJyoT1S3kKDCJt4H5S6A4/);
});

test('chat moderator provisioning is explicit, service-role-only, and address-free', async () => {
  const [script, migration] = await Promise.all([
    read('../scripts/provision-chat-admin.mjs'),
    read('../../supabase/migrations/20260807142000_chat_admin_provisioning.sql'),
  ]);
  assert.match(script, /APPLY_CHAT_ADMIN/);
  assert.match(script, /CONFIRM_CHAT_ADMIN_WALLET/);
  assert.match(script, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(script, /7VHaD8JMcdLo3c9PC7xgLnACJyoT1S3kKDCJt4H5S6A4/);
  assert.match(migration, /security definer/);
  assert.match(migration, /is_valid_solana_wallet_address/);
  assert.match(migration, /revoke all on function public\.set_chat_admin/);
  assert.match(migration, /grant execute on function public\.set_chat_admin[\s\S]*to service_role/);
});
