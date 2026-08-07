/** Build a Switchboard client from explicit production environment values. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as sb from '@switchboard-xyz/on-demand';
import { Connection, Keypair } from '@solana/web3.js';

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
}

export async function loadExplicitSwitchboardEnv() {
  const rpcUrl = requiredEnv('ANCHOR_PROVIDER_URL');
  const walletPath = requiredEnv('ANCHOR_WALLET');
  const secret = JSON.parse(await readFile(walletPath, 'utf8'));
  assert.ok(Array.isArray(secret) && secret.length === 64, 'ANCHOR_WALLET must contain a keypair');
  assert.ok(
    secret.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    'ANCHOR_WALLET contains an invalid byte',
  );
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  const wallet = sb.AnchorUtils.initWalletFromKeypair(keypair);
  const program = await sb.AnchorUtils.loadProgramFromConnection(connection, wallet);
  return { connection, keypair, program, wallet };
}
