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
  myneBalance,
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
  load('../_shared/myne-chat-balance.ts'),
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

test('wallet verification returns only a moderator UI hint while deletion rechecks the role', () => {
  assert.match(verify, /from\('chat_admins'\)/);
  assert.match(verify, /isAdmin: Boolean\(admin\)/);
  assert.match(remove, /from\('chat_admins'\)/);
  assert.match(remove, /eq\('wallet_address', session\.walletAddress\)/);
  assert.match(remove, /Admin access required/);
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

test('chat eligibility requires 0.01 MYNE across liquid, mining, and every staking form', () => {
  assert.match(send, /readMyneChatBalance\(session\.walletAddress\)/);
  assert.match(send, /Hold at least 0\.01 MYNE/);
  assert.match(myneBalance, /CHAT_MIN_MYNE_BASE_UNITS = 10_000_000n/);
  assert.match(myneBalance, /liquidBaseUnits/);
  assert.match(myneBalance, /miningRewardsBaseUnits/);
  assert.match(myneBalance, /standardStakeBaseUnits/);
  assert.match(myneBalance, /burnStakeBaseUnits/);
  assert.match(myneBalance, /cooldownStakeBaseUnits/);
  assert.match(myneBalance, /const values = \[liquidBaseUnits, miningRewardsBaseUnits, standardStakeBaseUnits, burnStakeBaseUnits, cooldownStakeBaseUnits\]/);
  assert.match(myneBalance, /totalBaseUnits >= CHAT_MIN_MYNE_BASE_UNITS/);
  assert.doesNotMatch(send, /wallet_mined_round_count/);
  assert.doesNotMatch(send, /MINED_ROUNDS_REQUIRED/);
  assert.doesNotMatch(send, /mine_round_bets/);
  assert.doesNotMatch(send, /limit\(10000\)/);
});

test('MYNE balance verification pins the chain, deployment, account layouts, and one snapshot', () => {
  assert.match(myneBalance, /getGenesisHash/);
  assert.match(myneBalance, /UPGRADEABLE_LOADER_ID/);
  assert.match(myneBalance, /TOKEN_PROGRAM_ID/);
  assert.match(myneBalance, /MYNE deployment overrides are permitted only with a loopback RPC/);
  assert.match(myneBalance, /getTokenAccountsByOwner/);
  assert.match(myneBalance, /getMultipleAccounts/);
  assert.match(myneBalance, /minContextSlot/);
  assert.match(myneBalance, /MINING_POOL_DISCRIMINATOR/);
  assert.match(myneBalance, /MINER_DISCRIMINATOR/);
  assert.match(myneBalance, /STAKE_POSITION_DISCRIMINATOR/);
  assert.match(myneBalance, /assertAuthority/);
  assert.match(myneBalance, /\(totalUnclaimed \* minerShares\) \/ totalShares/);
  assert.match(myneBalance, /standardStakeBaseUnits = readU64\(stakeData, 41\)/);
  assert.match(myneBalance, /burnStakeBaseUnits = readU64\(stakeData, 49\)/);
  assert.match(myneBalance, /cooldownStakeBaseUnits = readU64\(stakeData, 89\)/);
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
