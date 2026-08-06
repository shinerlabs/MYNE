/*
 * One-shot Switchboard round keeper for local/devnet rehearsal.
 *
 * Flow: create randomness account -> commit + open + bind -> deploys happen
 * externally -> reveal + verified settlement in the same transaction slot.
 * The production Supabase worker should use the same instruction ordering and
 * store the randomness keypair in a secret manager, never on disk.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import * as sb from '@switchboard-xyz/on-demand';
import { PublicKey, SystemProgram } from '@solana/web3.js';

const { AnchorProvider, Program } = anchor;
const PROGRAM_ID = new PublicKey(process.env.MYNE_PROGRAM_ID || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const ROUND_ID = BigInt(process.env.MYNE_ROUND_ID || '1');
const CONFIRM = process.env.CONFIRM_SWITCHBOARD_KEEPER;
assert.equal(CONFIRM, ROUND_ID.toString(), `Set CONFIRM_SWITCHBOARD_KEEPER=${ROUND_ID} to authorize this keeper`);
assert.ok(process.env.MYNE_LIQUIDITY_POOL, 'Set MYNE_LIQUIDITY_POOL to the registered Meteora pool');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));

const { keypair, connection, program: switchboardProgram } = await sb.AnchorUtils.loadEnv();
const provider = new AnchorProvider(connection, switchboardProgram.provider.wallet, { commitment: 'confirmed' });
const myne = new Program(idl, provider);
const queue = sb.getDefaultQueueAddress(connection.rpcEndpoint.includes('mainnet'));
const commitment = 'confirmed';
const txOpts = { commitment, skipPreflight: false, maxRetries: 3 };

const pda = (seed, ...extra) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), ...extra.map((value) => Buffer.from(value))],
  PROGRAM_ID,
)[0];
const roundSeed = Buffer.alloc(8);
roundSeed.writeBigUInt64LE(ROUND_ID);
const config = pda('config');
const stakePool = pda('stake_pool');
const liquidityGate = pda('liquidity_gate');
const round = pda('round', roundSeed);

const [randomness, randomnessKeypair, [createIx, commitIx]] = await sb.Randomness.createAndCommitIxs(
  switchboardProgram,
  queue,
  keypair,
);
const openIx = await myne.methods
  .openRound(ROUND_ID)
  .accounts({ config, round, payer: keypair.publicKey, systemProgram: SystemProgram.programId })
  .instruction();
const bindIx = await myne.methods
  .bindRoundRandomness(ROUND_ID)
  .accounts({ config, round, randomnessAccount: randomness.pubkey, authority: keypair.publicKey })
  .instruction();

const createTx = await sb.asV0Tx({
  connection,
  ixs: [createIx],
  payer: keypair.publicKey,
  signers: [keypair, randomnessKeypair],
});
const createSig = await connection.sendTransaction(createTx, txOpts);
await connection.confirmTransaction(createSig, commitment);

// Commit must precede the round binding. The bind instruction validates the
// Switchboard account owner/discriminator while it is still unrevealed.
const commitOpenBindTx = await sb.asV0Tx({
  connection,
  ixs: [commitIx, openIx, bindIx],
  payer: keypair.publicKey,
  signers: [keypair],
});
const commitSig = await connection.sendTransaction(commitOpenBindTx, txOpts);
await connection.confirmTransaction(commitSig, commitment);

console.log(JSON.stringify({
  ok: true,
  round: ROUND_ID.toString(),
  randomnessAccount: randomness.pubkey.toBase58(),
  createSignature: createSig,
  commitSignature: commitSig,
  status: 'committed-awaiting-deployments-and-reveal',
}, null, 2));

const configState = await myne.account.protocolConfig.fetch(config);
assert.equal(
  configState.randomnessAuthority.toBase58(),
  keypair.publicKey.toBase58(),
  'Keeper wallet must equal config.randomness_authority',
);

// Wait until the round's settlement window, then reveal and settle atomically.
// The verified instruction requires reveal_slot == the current slot, so the
// reveal and settlement instructions must be in the same transaction.
const roundState = await myne.account.round.fetch(round);
const settlesAt = Number(roundState.settlesAt.toString()) * 1000;
const waitMs = Math.max(0, settlesAt - Date.now() + 500);
if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

const randomnessClient = new sb.Randomness(switchboardProgram, randomness.pubkey);
const revealIx = await randomnessClient.revealIx(keypair.publicKey);
const gateState = await myne.account.liquidityGate.fetch(liquidityGate);
assert.ok(gateState.verified, 'Liquidity gate is not verified');
assert.ok(gateState.myneVault && gateState.solVault, 'Liquidity gate has no verified token vaults');
const settleIx = await myne.methods
  .settleRoundVerified()
  .accounts({
    config,
    stakePool,
    round,
    liquidityGate,
    liquidityPool: gateState.pool,
    myneVault: gateState.myneVault,
    solVault: gateState.solVault,
    randomnessAccount: randomness.pubkey,
    buybackWallet: configState.buybackWallet,
  })
  .instruction();
const settleTx = await sb.asV0Tx({
  connection,
  ixs: [revealIx, settleIx],
  payer: keypair.publicKey,
  signers: [keypair],
});
const settleSig = await connection.sendTransaction(settleTx, txOpts);
await connection.confirmTransaction(settleSig, commitment);
console.log(JSON.stringify({
  ok: true,
  round: ROUND_ID.toString(),
  randomnessAccount: randomness.pubkey.toBase58(),
  settlementSignature: settleSig,
  status: 'settled',
}, null, 2));
