/**
 * One-way v5 -> v6 fee-schedule acknowledgement for an existing deployment.
 *
 * The program must already be upgraded and paused. The script never pauses or
 * unpauses automatically, so an operator must review those state transitions
 * separately. Fresh v6 initializations do not need this migration.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';

const { AnchorProvider, Program, setProvider } = anchor;
const PROGRAM_ID = new PublicKey(process.env.MYNE_PROGRAM_ID
  || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
const payer = provider.wallet.payer;
assert.ok(payer, 'A file-backed protocol admin wallet is required');
const genesisHash = await provider.connection.getGenesisHash();
assert.equal(
  process.env.CONFIRM_SOLANA_GENESIS_HASH,
  genesisHash,
  `Set CONFIRM_SOLANA_GENESIS_HASH=${genesisHash} after independently checking the RPC cluster`,
);
const program = new Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);

const before = await program.account.protocolConfig.fetch(config);
assert.ok(before.admin.equals(payer.publicKey), 'The configured protocol admin must sign the migration');
assert.equal(before.paused, true, 'Pause the protocol and verify settlement is idle before migrating');
assert.equal(Number(before.version), 5, `Expected config v5; found v${Number(before.version)}`);
assert.equal(
  process.env.CONFIRM_FEE_SCHEDULE_V6,
  PROGRAM_ID.toBase58(),
  `Set CONFIRM_FEE_SCHEDULE_V6=${PROGRAM_ID.toBase58()} after reviewing the target cluster`,
);

// This one-time, discriminator-filtered Anchor read is intentionally stricter
// than checking only an "active" round. Any remaining Round PDA represents v5
// economics or unclosed rent/evidence and must be fully processed, archived and
// closed before the global fee semantics can change.
const remainingRounds = await program.account.round.all();
assert.equal(
  remainingRounds.length,
  0,
  `Close every v5 Round account before migrating; remaining: ${remainingRounds
    .slice(0, 10)
    .map(({ publicKey }) => publicKey.toBase58())
    .join(', ')}${remainingRounds.length > 10 ? ` (+${remainingRounds.length - 10} more)` : ''}`,
);

const signature = await program.methods
  .migrateFeeScheduleV6()
  .accounts({
    config,
    liquidityGate: null,
    liquidityPool: null,
    admin: payer.publicKey,
  })
  .rpc();
const after = await program.account.protocolConfig.fetch(config);
assert.equal(Number(after.version), 6, 'Fee schedule migration did not persist config v6');

console.log(JSON.stringify({
  ok: true,
  programId: PROGRAM_ID.toBase58(),
  config: config.toBase58(),
  previousVersion: Number(before.version),
  currentVersion: Number(after.version),
  signature,
  status: 'paused',
}, null, 2));
