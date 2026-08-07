import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [
  common,
  nonce,
  verify,
  send,
  react,
  reactions,
  remove,
  profile,
  config,
] = await Promise.all([
  load('../_shared/common.ts'),
  load('../solana-nonce/index.ts'),
  load('../solana-verify/index.ts'),
  load('../chat-send/index.ts'),
  load('../chat-react/index.ts'),
  load('../chat-reactions/index.ts'),
  load('../chat-delete/index.ts'),
  load('../profile-update/index.ts'),
  load('../../config.toml'),
]);

test('CORS is fail-closed to MYNE production origins and explicit loopback development origins', () => {
  assert.match(common, /https:\/\/myne\.supply/);
  assert.match(common, /https:\/\/www\.myne\.supply/);
  assert.match(common, /MYNE_CORS_LOCAL_ORIGINS/);
  assert.match(common, /\['localhost', '127\.0\.0\.1', '\[::1\]'\]/);
  assert.doesNotMatch(common, /Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/);
  assert.match(common, /Origin not allowed/);
});

test('wallet sessions bind canonical Solana keys to an epoch and reject legacy claims', () => {
  assert.match(common, /bs58\.decode\(value\)/);
  assert.match(common, /bytes\.length === 32 && bs58\.encode\(bytes\) === value/);
  assert.match(common, /CHAT_SESSION_VERSION = 2/);
  assert.match(common, /sessionEpoch/);
  assert.match(common, /is_chat_session_current/);
  assert.match(common, /keys !== expectedKeys/);
  assert.match(common, /signatureBytes\.length !== nacl\.sign\.signatureLength/);
});

test('nonce verification uses the signed stored message and an atomic one-time consume RPC', () => {
  assert.match(nonce, /purpose: CHAT_SESSION_PURPOSE/);
  assert.match(nonce, /session_epoch: sessionEpoch/);
  assert.match(verify, /row\.message !== message/);
  assert.match(verify, /verifyWalletSignature\(walletAddress, row\.message, signature\)/);
  assert.match(verify, /rpc\('consume_solana_nonce'/);
  assert.doesNotMatch(verify, /\.update\(\{\s*used_at/);
});

test('every public function is origin guarded and every mutation is wallet/rate guarded', () => {
  for (const source of [nonce, verify, send, react, reactions, remove, profile]) {
    assert.match(source, /guardCors\(req\)/);
    assert.match(source, /rateLimitGuard\(/);
  }
  for (const source of [send, react, remove, profile]) {
    assert.match(source, /requireSession\(req\)/);
    assert.match(source, /session\.walletAddress/);
  }
});

test('all custom-wallet functions bypass platform JWT parsing and enforce auth in their handlers', () => {
  for (const functionName of [
    'solana-nonce',
    'solana-verify',
    'chat-send',
    'chat-react',
    'chat-reactions',
    'chat-delete',
    'profile-update',
  ]) {
    assert.match(config, new RegExp(`\\[functions\\.${functionName}\\]\\nverify_jwt = false`));
  }
  assert.doesNotMatch(nonce, /ensureWalletProfile/);
  assert.match(verify, /ensureWalletProfile\(walletAddress\)/);
});

test('chat eligibility uses the indexed count RPC instead of scanning bet rows', () => {
  assert.match(send, /rpc\('wallet_mined_round_count'/);
  assert.doesNotMatch(send, /mine_round_bets/);
  assert.doesNotMatch(send, /limit\(10000\)/);
});

test('wallet ownership is derived server-side for messages, reactions, and profiles', () => {
  assert.match(send, /wallet_address: session\.walletAddress/);
  assert.match(react, /wallet_address: session\.walletAddress/);
  assert.match(profile, /\.eq\('wallet_address', session\.walletAddress\)/);
  assert.doesNotMatch(send, /payload\?\.walletAddress/);
  assert.doesNotMatch(react, /payload\?\.walletAddress/);
  assert.doesNotMatch(profile, /payload\?\.walletAddress/);
});

test('avatar persistence verifies raster MIME, canonical bytes, magic signatures, and decoded size', () => {
  assert.match(common, /MAX_AVATAR_BYTES = 180 \* 1024/);
  assert.match(common, /data:image\\\/\(png\|jpeg\|webp\);base64/);
  assert.match(common, /0x89, 0x50, 0x4e, 0x47/);
  assert.match(common, /0xff, 0xd8, 0xff/);
  assert.match(common, /0x52, 0x49, 0x46, 0x46/);
  assert.match(common, /decodeCanonicalBase64/);
  assert.match(profile, /validateAvatarDataUrl/);
});
