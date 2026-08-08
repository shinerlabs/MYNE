import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [chat, social, profile, styles, baseStyles, main] = await Promise.all([
  readFile(new URL('../src/social/chat.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/social/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/social/profile.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/chat-social.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
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

test('chat defaults to latest only once per page load', () => {
  assert.match(chat, /let initialLatestPositioned = false/);
  assert.match(chat, /initialLatestPositioned \|\| !el\.isConnected \|\| el\.clientHeight <= 0/);
  assert.match(chat, /initialLatestPositioned = true;[\s\S]*pinChatToLatest\(holdMs\)/);
  assert.match(social, /showLatestMessages:\s*pinInitialChatToLatest/);
  assert.doesNotMatch(social, /showLatestMessages:\s*pinChatToLatest/);
  assert.match(main, /target\?\.classList\.add\('open'\);[\s\S]*if \(which === 'chat'\) setChat\(true\)/);
});

test('fallback chat avatars use stable wallet-derived MYNE gradients', () => {
  assert.match(profile, /const generatedAvatarTheme = \(wallet, name\)/);
  assert.match(profile, /identity = String\(wallet \|\| name \|\| 'MYNE'\)/);
  assert.match(profile, /Math\.imul\(seed, 16777619\)/);
  assert.doesNotMatch(profile, /generatedAvatarTheme[\s\S]{0,800}Math\.random/);
  assert.match(profile, /classList\.add\('is-generated'\)/);
  assert.match(styles, /\.chat-avatar\.is-generated[\s\S]*var\(--avatar-start[\s\S]*var\(--avatar-middle[\s\S]*var\(--avatar-end/);
});

test('chat emoji and sticker media stays compact inside the social rail', () => {
  assert.match(chat, /img\.width = 88;[\s\S]*img\.height = 88;/);
  assert.match(baseStyles, /\.chat-media img \{[\s\S]*width:\s*88px;[\s\S]*height:\s*88px;/);
  assert.match(styles, /\.emoji-picker button \{[\s\S]*font-size:\s*15px/);
});

test('chat reactions render only in their counted pill', () => {
  assert.doesNotMatch(chat, /animateReaction|reaction-fly/);
  assert.doesNotMatch(styles, /reaction-fly|reaction-rise/);
  assert.match(chat, /renderReactionBar\(entry, entry\.reactions\)/);
});
