import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [chat, social, styles] = await Promise.all([
  readFile(new URL('../src/social/chat.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/social/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/chat-social.css', import.meta.url), 'utf8'),
]);

test('locked chat keeps a neutral composer placeholder', () => {
  assert.doesNotMatch(chat, /Connect to chat/);
  assert.doesNotMatch(social, /Connect to chat/);
  assert.match(chat, /placeholder \|\| 'Send a message…'/);
});

test('disconnected chat does not render its own wallet connection card', () => {
  assert.doesNotMatch(chat, /Connect your wallet to chat/);
  assert.doesNotMatch(social, /Connect your wallet to chat/);
  assert.doesNotMatch(chat, /chat-gate/);
  assert.doesNotMatch(styles, /chat-gate/);
});

test('chat history limit remains internal rather than appearing as a feed caption', () => {
  assert.doesNotMatch(chat, /Showing last/);
  assert.doesNotMatch(chat, /chat-history-status/);
});
