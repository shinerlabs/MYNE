import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [session, chat, social, verify, remove] = await Promise.all([
  read('../src/social/session.js'),
  read('../src/social/chat.js'),
  read('../src/social/index.js'),
  read('../../supabase/functions/solana-verify/index.ts'),
  read('../../supabase/functions/chat-delete/index.ts'),
]);

test('wallet login carries only an admin display hint and updates existing controls', () => {
  assert.match(verify, /from\('chat_admins'\)/);
  assert.match(verify, /isAdmin: Boolean\(admin\)/);
  assert.match(session, /isAdmin: data\.isAdmin === true/);
  assert.match(chat, /for \(const entry of new Set\(messageIndex\.values\(\)\)\)/);
  assert.match(social, /setChatAdmin\(session\?\.isAdmin === true\)/);
});

test('message deletion remains server-authorized on every request', () => {
  assert.match(remove, /requireSession\(req\)/);
  assert.match(remove, /from\('chat_admins'\)/);
  assert.match(remove, /eq\('wallet_address', session\.walletAddress\)/);
  assert.match(remove, /Admin access required/);
});
