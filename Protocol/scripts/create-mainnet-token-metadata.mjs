/**
 * Create the canonical Metaplex metadata account for an existing MYNE mint.
 *
 * This script is simulation-only unless SUBMIT_MAINNET_TOKEN_METADATA equals
 * the exact mint address. Run it after minting the 100 MYNE genesis supply and
 * before transferring SPL mint authority to the protocol config PDA.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  TokenStandard,
  createV1,
  fetchMetadataFromSeeds,
  findMetadataPda,
  mplTokenMetadata,
} from '@metaplex-foundation/mpl-token-metadata';
import { keypairIdentity, percentAmount, publicKey } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { SOLANA_MAINNET_GENESIS_HASH } from './production-network-policy.mjs';

const TOKEN_NAME = 'MYNE';
const TOKEN_SYMBOL = 'MYNE';
const TOKEN_DECIMALS = 9;
const GENESIS_BASE_UNITS = 100_000_000_000n;
const METADATA_URI = 'https://www.myne.supply/token-metadata.json';
const WEBSITE = 'https://www.myne.supply';
const X_ACCOUNT = 'https://x.com/myne_solana';
const PNG_URI = `${WEBSITE}/myne-token-icon-1024.png`;
const SVG_URI = `${WEBSITE}/myne-token-icon.svg`;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchExact(url, expectedContentType) {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, `${url} returned HTTP ${response.status}`);
  assert.equal(response.url, url, `${url} redirected to ${response.url}`);
  assert.match(
    response.headers.get('content-type') || '',
    expectedContentType,
    `${url} has the wrong content type`,
  );
  return Buffer.from(await response.arrayBuffer());
}

async function verifyPublishedMetadata() {
  const [remoteJson, remotePng, remoteSvg, localPng, localSvg] = await Promise.all([
    fetchExact(METADATA_URI, /application\/json/i),
    fetchExact(PNG_URI, /image\/png/i),
    fetchExact(SVG_URI, /image\/svg\+xml/i),
    readFile(new URL('../../Frontend/public/myne-token-icon-1024.png', import.meta.url)),
    readFile(new URL('../../Frontend/public/myne-token-icon.svg', import.meta.url)),
  ]);
  const metadata = JSON.parse(remoteJson.toString('utf8'));
  assert.equal(metadata.name, TOKEN_NAME);
  assert.equal(metadata.symbol, TOKEN_SYMBOL);
  assert.equal(metadata.image, PNG_URI);
  assert.equal(metadata.external_url, WEBSITE);
  assert.deepEqual(metadata.properties?.files, [
    { uri: PNG_URI, type: 'image/png' },
    { uri: SVG_URI, type: 'image/svg+xml' },
  ]);
  assert.equal(metadata.properties?.links?.website, WEBSITE);
  assert.equal(metadata.properties?.links?.x, X_ACCOUNT);
  assert.equal(metadata.extensions?.website, WEBSITE);
  assert.equal(metadata.extensions?.twitter, X_ACCOUNT);
  assert.equal(sha256(remotePng), sha256(localPng), 'Published PNG differs from the release asset');
  assert.equal(sha256(remoteSvg), sha256(localSvg), 'Published SVG differs from the release asset');
  return {
    metadataSha256: sha256(remoteJson),
    pngSha256: sha256(remotePng),
    svgSha256: sha256(remoteSvg),
  };
}

const rpcUrl = requiredEnv('MAINNET_RPC_URL');
const walletPath = requiredEnv('ANCHOR_WALLET');
const mintAddress = requiredEnv('MYNE_MINT_ADDRESS');
const mintPublicKey = new PublicKey(mintAddress);
assert.equal(
  process.env.CONFIRM_MAINNET_TOKEN_METADATA,
  mintAddress,
  `Set CONFIRM_MAINNET_TOKEN_METADATA=${mintAddress} after independently verifying the mint`,
);

const secret = JSON.parse(await readFile(walletPath, 'utf8'));
assert.ok(Array.isArray(secret) && secret.length === 64, 'ANCHOR_WALLET must contain a 64-byte keypair');
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(rpcUrl, 'confirmed');
const genesisHash = await connection.getGenesisHash();
assert.equal(genesisHash, SOLANA_MAINNET_GENESIS_HASH, 'RPC is not Solana Mainnet');
assert.equal(
  process.env.CONFIRM_SOLANA_GENESIS_HASH,
  genesisHash,
  `Set CONFIRM_SOLANA_GENESIS_HASH=${genesisHash} after independently checking the RPC`,
);

const mint = await getMint(connection, mintPublicKey, 'confirmed', TOKEN_PROGRAM_ID);
assert.equal(mint.decimals, TOKEN_DECIMALS, 'MYNE mint must use 9 decimals');
assert.equal(mint.supply, GENESIS_BASE_UNITS, 'MYNE genesis supply must be exactly 100 MYNE');
assert.equal(mint.freezeAuthority, null, 'MYNE mint must have no freeze authority');
assert.ok(mint.mintAuthority?.equals(payer.publicKey), 'Signer must still be the SPL mint authority');

const published = await verifyPublishedMetadata();
const umi = createUmi(rpcUrl).use(mplTokenMetadata());
const umiKeypair = umi.eddsa.createKeypairFromSecretKey(payer.secretKey);
umi.use(keypairIdentity(umiKeypair));
assert.equal(String(umi.identity.publicKey), payer.publicKey.toBase58());
const umiMint = publicKey(mintAddress);
const metadataPda = findMetadataPda(umi, { mint: umiMint });

if (await umi.rpc.accountExists(metadataPda[0], { commitment: 'finalized' })) {
  const existing = await fetchMetadataFromSeeds(umi, { mint: umiMint }, { commitment: 'finalized' });
  assert.equal(existing.name, TOKEN_NAME, 'Existing metadata name differs');
  assert.equal(existing.symbol, TOKEN_SYMBOL, 'Existing metadata symbol differs');
  assert.equal(existing.uri, METADATA_URI, 'Existing metadata URI differs');
  console.log(JSON.stringify({
    ok: true,
    alreadyExists: true,
    mint: mintAddress,
    metadata: String(metadataPda[0]),
    ...published,
  }, null, 2));
  process.exit(0);
}

// Use a finalized blockhash so an RPC provider's load-balanced nodes all agree
// that it is valid before we sign and simulate the release transaction.
const latestBlockhash = await umi.rpc.getLatestBlockhash({ commitment: 'finalized' });
const builder = createV1(umi, {
  mint: umiMint,
  authority: umi.identity,
  payer: umi.identity,
  updateAuthority: umi.identity,
  name: TOKEN_NAME,
  symbol: TOKEN_SYMBOL,
  uri: METADATA_URI,
  sellerFeeBasisPoints: percentAmount(0),
  tokenStandard: TokenStandard.Fungible,
  isMutable: true,
}).setBlockhash(latestBlockhash);
const transaction = await builder.buildAndSign(umi);
const simulation = await umi.rpc.simulateTransaction(transaction, {
  commitment: 'confirmed',
  verifySignatures: true,
});
assert.equal(
  simulation.err,
  null,
  `Metadata simulation failed:\n${(simulation.logs || []).join('\n')}`,
);

if (process.env.SUBMIT_MAINNET_TOKEN_METADATA !== mintAddress) {
  console.log(JSON.stringify({
    ok: true,
    simulationOnly: true,
    mint: mintAddress,
    metadata: String(metadataPda[0]),
    updateAuthority: payer.publicKey.toBase58(),
    unitsConsumed: simulation.unitsConsumed ?? null,
    submitWith: `SUBMIT_MAINNET_TOKEN_METADATA=${mintAddress}`,
    ...published,
  }, null, 2));
  process.exit(0);
}

const signature = await umi.rpc.sendTransaction(transaction, {
  skipPreflight: false,
  preflightCommitment: 'confirmed',
  maxRetries: 3,
});
const confirmation = await umi.rpc.confirmTransaction(signature, {
  commitment: 'finalized',
  strategy: { type: 'blockhash', ...latestBlockhash },
});
assert.equal(confirmation.value.err, null, 'Metadata transaction failed confirmation');
const created = await fetchMetadataFromSeeds(umi, { mint: umiMint }, { commitment: 'finalized' });
assert.equal(created.name, TOKEN_NAME);
assert.equal(created.symbol, TOKEN_SYMBOL);
assert.equal(created.uri, METADATA_URI);

console.log(JSON.stringify({
  ok: true,
  submitted: true,
  mint: mintAddress,
  metadata: String(metadataPda[0]),
  signature: base58.deserialize(signature)[0],
  updateAuthority: payer.publicKey.toBase58(),
  ...published,
}, null, 2));
