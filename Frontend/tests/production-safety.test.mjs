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
  const [sourceFiles, index, localViewer, manifest, tokenIcon, brandImages, favicon] = await Promise.all([
    Promise.all([
    '../src/main.js',
    '../src/style.css',
    '../src/brand-uniform.css',
    '../src/surface-system.css',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../local.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/site.webmanifest', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../public/myne-token-icon.svg', import.meta.url), 'utf8'),
    Promise.all([
      '../public/favicon-16x16.png',
      '../public/favicon-32x32.png',
      '../public/apple-touch-icon.png',
      '../public/icon-192.png',
      '../public/icon-512.png',
      '../public/myne-wallet-icon-v1-16.png',
      '../public/myne-wallet-icon-v1-32.png',
      '../public/myne-wallet-icon-v1-180.png',
      '../public/myne-wallet-icon-v1-192.png',
      '../public/myne-wallet-icon-v1-512.png',
      '../public/myne-x-banner.png',
      '../public/myne-social-card.png',
    ].map((path) => readFile(new URL(path, import.meta.url)))),
    readFile(new URL('../public/favicon.ico', import.meta.url)),
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
  assert.doesNotMatch(`${index}\n${localViewer}`, /\/myne-mark-ui\.png/);
  assert.match(index, /property="og:image" content="https:\/\/www\.myne\.supply\/myne-social-card\.png\?v=myne-3"/);
  assert.match(index, /name="twitter:card" content="summary_large_image"/);
  assert.match(index, /name="twitter:image" content="https:\/\/www\.myne\.supply\/myne-social-card\.png\?v=myne-3"/);
  assert.match(index, /rel="icon"[^>]*\/myne-wallet-icon-v1-192\.png/);
  assert.match(index, /rel="icon"[^>]*\/myne-token-icon\.svg\?v=myne-wallet-1/);
  assert.match(index, /rel="shortcut icon"[^>]*\/myne-wallet-icon-v1-32\.png/);
  assert.match(index, /rel="alternate icon"[^>]*\/favicon\.ico\?v=myne-wallet-1/);
  assert.match(index, /rel="apple-touch-icon"[^>]*\/myne-wallet-icon-v1-180\.png/);
  assert.match(localViewer, /rel="icon"[^>]*\/myne-wallet-icon-v1-192\.png/);
  assert.deepEqual(manifest.icons.map(({ src }) => src), [
    '/myne-wallet-icon-v1-16.png',
    '/myne-wallet-icon-v1-32.png',
    '/myne-wallet-icon-v1-192.png',
    '/myne-wallet-icon-v1-512.png',
  ]);
  assert.deepEqual(brandImages.map((image) => [image.readUInt32BE(16), image.readUInt32BE(20)]), [
    [16, 16],
    [32, 32],
    [180, 180],
    [192, 192],
    [512, 512],
    [16, 16],
    [32, 32],
    [180, 180],
    [192, 192],
    [512, 512],
    [1500, 500],
    [1200, 630],
  ]);
  assert.equal(favicon.readUInt16LE(4), 6);

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
