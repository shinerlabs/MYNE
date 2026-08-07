/** Pre-create the single configured admin fallback MYNE token account. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

const { AnchorProvider, Program, setProvider } = anchor;
const PROGRAM_ID = new PublicKey(process.env.MYNE_PROGRAM_ID
  || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
assert.equal(
  process.env.CONFIRM_ADMIN_FALLBACK_ATA,
  PROGRAM_ID.toBase58(),
  `Set CONFIRM_ADMIN_FALLBACK_ATA=${PROGRAM_ID.toBase58()} to authorize account creation`,
);
const provider = AnchorProvider.env();
setProvider(provider);
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed payer is required');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const program = new Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const state = await program.account.protocolConfig.fetch(config);
const expected = getAssociatedTokenAddressSync(
  state.mint,
  state.adminFeeWallet,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
);
const account = await getOrCreateAssociatedTokenAccount(
  provider.connection,
  payer,
  state.mint,
  state.adminFeeWallet,
  false,
  'confirmed',
  undefined,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
);
assert.ok(account.address.equals(expected), 'Created token account is not the canonical admin ATA');
console.log(JSON.stringify({
  ok: true,
  mint: state.mint.toBase58(),
  adminFallbackWallet: state.adminFeeWallet.toBase58(),
  adminFallbackTokenAccount: account.address.toBase58(),
}, null, 2));
