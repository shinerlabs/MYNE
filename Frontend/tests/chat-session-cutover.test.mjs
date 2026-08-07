import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sessionSource = await readFile(new URL('../src/social/session.js', import.meta.url), 'utf8');
const chatSource = await readFile(new URL('../src/social/chat.js', import.meta.url), 'utf8');

test('wallet-only chat cut-over retires sessions that predate moderator hints', () => {
  assert.match(sessionSource, /CHAT_SESSION_KEY = 'myne-solana-chat-session-v3'/);
  assert.match(sessionSource, /'myne-solana-chat-session-v2'/);
  assert.match(sessionSource, /'myne-solana-chat-session-v1'/);
  assert.doesNotMatch(sessionSource, /for \(const key of \[CHAT_SESSION_KEY,/);
});

test('chat mutations automatically re-authenticate after a server-side session reset', () => {
  assert.match(chatSource, /authedFetchJson\(`\$\{FUNCTIONS_URL\}\/chat-send`/);
  assert.match(chatSource, /authedFetchJson\(`\$\{FUNCTIONS_URL\}\/chat-react`/);
  assert.doesNotMatch(chatSource, /ensureSession\(\)/);
});
