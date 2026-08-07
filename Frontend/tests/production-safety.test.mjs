import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateDeploymentConfig } from '../src/deployment-validation.js';
import { createReceiptNonce } from '../src/chain/receipt-nonce.js';
import { deriveRoundProof, randomnessBytes, randomnessHex } from '../src/chain/randomness-proof.js';

const PROGRAM = 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e';
const MINT = '83LAMprbD2WJV6Yd4gDbxR1ex2dZchjEcPXjhNp9ntHb';

test('mainnet deployment validation rejects incomplete and cross-cluster identities', () => {
  const errors = validateDeploymentConfig({
    network: { cluster: 'mainnet-beta', rpcUrl: 'https://api.devnet.solana.com', explorerUrl: 'http://explorer.solana.com' },
    programs: { protocol: PROGRAM, tokenMint: '', randomness: '' },
    services: { indexerUrl: '' },
    generatedProgramId: PROGRAM,
  });
  assert.ok(errors.includes('Mainnet MYNE mint is not configured'));
  assert.ok(errors.includes('Mainnet frontend is configured with a non-mainnet RPC'));
  assert.ok(errors.includes('Mainnet explorer must use HTTPS'));
  assert.ok(errors.includes('Mainnet round indexer is not configured'));
});

test('deployment validation rejects a client/IDL program mismatch', () => {
  const errors = validateDeploymentConfig({
    network: { cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', explorerUrl: 'https://explorer.solana.com' },
    programs: { protocol: PROGRAM, tokenMint: MINT, randomness: '' },
    generatedProgramId: '11111111111111111111111111111111',
  });
  assert.ok(errors.includes('Configured MYNE program does not match the generated Anchor IDL'));
});

test('deployment validation decodes exact 32-byte Solana public keys', () => {
  const errors = validateDeploymentConfig({
    network: { cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', explorerUrl: 'https://explorer.solana.com' },
    programs: { protocol: '22222222222222222222222222222222', tokenMint: MINT, randomness: '' },
    generatedProgramId: '',
  });
  assert.ok(errors.includes('MYNE program ID is not a valid Solana address'));
});

test('Switchboard proof mirrors the checked-in on-chain domain-separated tile derivation', async () => {
  const randomness = Uint8Array.from({ length: 32 }, (_, index) => index);
  const proof = await deriveRoundProof(42n, randomness);
  assert.equal(proof.winningSquare, 21);
  assert.equal(proof.soloMode, true);
  assert.equal(proof.soloSample, 7615744855884633396n);
  assert.equal(proof.motherlodeHit, false);
  assert.equal(randomnessHex(BigInt(`0x${proof.randomnessHex}`)), proof.randomnessHex);
  assert.deepEqual(randomnessBytes(proof.randomnessHex), randomness);
});

test('receipt nonce uses all 64 CSPRNG bits', () => {
  const fakeCrypto = { getRandomValues(words) { words[0] = 0x12345678; words[1] = 0x90abcdef; return words; } };
  assert.equal(createReceiptNonce(fakeCrypto), 0x1234567890abcdefn);
});

test('production history refuses account-scan fallback and social code preserves base58 case', async () => {
  const rounds = await readFile(new URL('../src/chain/rounds-page.js', import.meta.url), 'utf8');
  const chat = await readFile(new URL('../src/social/chat.js', import.meta.url), 'utf8');
  const profile = await readFile(new URL('../src/social/profile.js', import.meta.url), 'utf8');
  assert.match(rounds, /Production round index is unavailable; on-chain account scans are disabled/);
  assert.doesNotMatch(chat, /wallet_address[^\n]*toLowerCase/);
  assert.doesNotMatch(profile, /walletRaw\)\.toLowerCase|account\.toLowerCase/);
});

test('production social identity is explicit and untrusted avatars are constrained', async () => {
  const config = await readFile(new URL('../src/social/config.js', import.meta.url), 'utf8');
  const profile = await readFile(new URL('../src/social/profile.js', import.meta.url), 'utf8');
  const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /DEFAULT_SUPABASE_(?:URL|ANON_KEY)|sb_publishable_/);
  assert.match(vite, /VITE_SUPABASE_URL \|\| 'http:\/\/127\.0\.0\.1:54321'/);
  assert.doesNotMatch(vite, /new URL\('\.\/local\.html'/);
  assert.ok(profile.includes('data:image\\/(?:png|jpeg|webp);base64'));
  assert.doesNotMatch(profile, /path\.startsWith\('http:\/\/'\)/);
});

test('browser bundle contains no Ethereum adapter or legacy ABI dependency', async () => {
  const swap = await readFile(new URL('../src/chain/swap.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies.viem, undefined);
  assert.doesNotMatch(swap, /Uniswap|Permit2|writeContract|keccak256/);
  assert.match(swap, /fail-closed/i);
});

test('public repository includes baseline disclosure, pinned tooling, and deployment headers', async () => {
  const root = new URL('../../', import.meta.url);
  const [readme, security, contributing, workflow, vercel, pkg] = await Promise.all([
    readFile(new URL('README.md', root), 'utf8'),
    readFile(new URL('SECURITY.md', root), 'utf8'),
    readFile(new URL('CONTRIBUTING.md', root), 'utf8'),
    readFile(new URL('.github/workflows/frontend.yml', root), 'utf8'),
    readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  assert.match(readme, /Pre-launch software/);
  assert.match(readme, /No open-source license is currently granted/);
  assert.match(security, /private vulnerability reporting/);
  assert.match(contributing, /fail-closed/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /version: 11\.9\.0/);
  assert.match(vercel, /X-Content-Type-Options/);
  assert.equal(Object.values({ ...pkg.dependencies, ...pkg.devDependencies }).includes('latest'), false);
});

test('public bundle uses MYNE-named brand assets and omits legacy prototype files', async () => {
  const [sourceFiles, index, manifest, tokenIcon] = await Promise.all([
    Promise.all([
    '../src/main.js',
    '../src/style.css',
    '../src/brand-uniform.css',
    '../src/surface-system.css',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/site.webmanifest', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../public/myne-token-icon.svg', import.meta.url), 'utf8'),
  ]);
  for (const source of sourceFiles) {
    assert.doesNotMatch(source, /\/(?:gld-(?:icon|wordmark)|bullion-logo|token-mark)(?:[^"')\s]*)/i);
  }
  assert.match(sourceFiles[0], /\/myne-token-icon\.svg/);
  assert.doesNotMatch(sourceFiles.join('\n'), /\/myne-mark-ui\.png/);
  assert.match(sourceFiles[0], /\/myne-wordmark-ui\.png/);
  assert.match(tokenIcon, /<circle\b[^>]*fill="url\(#myne-coin\)"/);
  assert.match(tokenIcon, /<path\b[^>]*fill="#f7f7f8"/);
  assert.doesNotMatch(tokenIcon, /<image\b|data:image\//);
  assert.doesNotMatch(index, /(?:og:image|twitter:image|rel="icon"|rel="apple-touch-icon")[^>]*myne-(?:mark-ui|token)\.png/);
  assert.match(index, /rel="icon"[^>]*\/favicon\.ico\?v=myne-2/);
  assert.match(index, /rel="apple-touch-icon"[^>]*\/apple-touch-icon\.png\?v=myne-2/);
  assert.deepEqual(manifest.icons.map(({ src }) => src), [
    '/favicon.ico?v=myne-2',
    '/apple-touch-icon.png?v=myne-2',
  ]);

  for (const path of [
    '../public/.DS_Store',
    '../public/bullion-logo.jpg',
    '../public/token-mark.jpg',
    '../public/gld-icon.png',
    '../public/gld-icon-transparent.png',
    '../public/gld-wordmark.png',
  ]) {
    await assert.rejects(access(new URL(path, import.meta.url)));
  }
});
