import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import {
  REFERRAL_CODE_LENGTH, canonicalSolanaAddress, compactReferralLink,
  isReferralCode, referralCodeFor, referralLinkFor,
} from '../src/chain/referral-code.js';

const wallet = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
  .publicKey.toBase58();

test('social referral URLs use a compact deterministic Solana code', () => {
  const code = referralCodeFor(wallet);
  assert.equal(code, wallet.slice(-REFERRAL_CODE_LENGTH));
  assert.equal(code.length, 10);
  assert.equal(isReferralCode(code), true);
  assert.equal(referralLinkFor('https://www.myne.supply/#mine', wallet), `https://www.myne.supply/#mine?ref=${code}`);
  assert.equal(compactReferralLink('https://www.myne.supply/#mine', wallet), `www.myne.supply/#mine?ref=${code}`);
});

test('invalid and non-Solana values cannot create referral codes', () => {
  assert.equal(canonicalSolanaAddress(wallet), wallet);
  assert.equal(canonicalSolanaAddress('0x1234'), null);
  assert.equal(referralCodeFor('not-a-wallet'), null);
  assert.equal(isReferralCode('five5'), false);
});

test('incoming codes resolve by an exact indexed read before on-chain registration', async () => {
  const referralSource = await readFile(new URL('../src/chain/referral.js', import.meta.url), 'utf8');
  const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(referralSource, /from\('mine_referral_codes'\)[\s\S]*\.eq\('code', raw\)/);
  assert.match(referralSource, /referralCodeFor\(address\) === raw/);
  assert.match(mainSource, /resolveReferrerReference\(ref\)/);
  assert.doesNotMatch(mainSource, /\^0x\[0-9a-fA-F\]\{40\}\$/);
});
