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
import bs58 from 'bs58';

const { AnchorProvider, Program } = anchor;
const PROGRAM_ID = new PublicKey(process.env.MYNE_PROGRAM_ID || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));

const { keypair, connection, program: switchboardProgram } = await sb.AnchorUtils.loadEnv();
const provider = new AnchorProvider(connection, switchboardProgram.provider.wallet, { commitment: 'confirmed' });
const myne = new Program(idl, provider);
const commitment = 'confirmed';
const txOpts = { commitment, skipPreflight: false, maxRetries: 3 };

const pda = (seed, ...extra) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), ...extra.map((value) => Buffer.from(value))],
  PROGRAM_ID,
)[0];
const config = pda('config');
const configState = await myne.account.protocolConfig.fetch(config);
assert.equal(
  configState.randomnessAuthority.toBase58(),
  keypair.publicKey.toBase58(),
  'Keeper wallet must equal config.randomness_authority',
);
assert.equal(
  configState.randomnessProgram.toBase58(),
  switchboardProgram.programId.toBase58(),
  'RPC network, configured randomness program, and Switchboard SDK program do not match',
);
const isMainnet = configState.randomnessProgram.toBase58() === sb.ON_DEMAND_MAINNET_PID.toBase58();
const queue = sb.getDefaultQueueAddress(isMainnet);
const scheduledRound = Math.floor(
  (Math.floor(Date.now() / 1000) - Number(configState.initializedAt.toString()))
  / Number(configState.roundDurationSeconds.toString()),
);
assert.ok(scheduledRound >= 0, 'Protocol schedule has not started');
const ROUND_ID = BigInt(process.env.MYNE_ROUND_ID || scheduledRound);
const CONFIRM = process.env.CONFIRM_SWITCHBOARD_KEEPER;
assert.equal(CONFIRM, ROUND_ID.toString(), `Set CONFIRM_SWITCHBOARD_KEEPER=${ROUND_ID} to authorize this keeper`);
const roundSeed = Buffer.alloc(8);
roundSeed.writeBigUInt64LE(ROUND_ID);
const stakePool = pda('stake_pool');
const liquidityGate = pda('liquidity_gate');
const round = pda('round', roundSeed);

const sendKeeperInstructions = async (ixs) => {
  const transaction = await sb.asV0Tx({
    connection,
    ixs,
    payer: keypair.publicKey,
    signers: [keypair],
  });
  const signature = await connection.sendTransaction(transaction, txOpts);
  await connection.confirmTransaction(signature, commitment);
  return signature;
};

let roundState = await myne.account.round.fetchNullable(round);
let randomnessPubkey = roundState?.randomnessAccount ?? null;
let createSig = null;
let commitSig = null;
if (!roundState) {
  const [randomness, randomnessKeypair, [createIx, commitIx]] = await sb.Randomness.createAndCommitIxs(
    switchboardProgram,
    queue,
    keypair.publicKey,
  );
  randomnessPubkey = randomness.pubkey;
  const openIx = await myne.methods
    .openRound(ROUND_ID)
    .accounts({ config, round, payer: keypair.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  const bindIx = await myne.methods
    .bindRoundRandomness(ROUND_ID)
    .accounts({ config, round, randomnessAccount: randomnessPubkey, authority: keypair.publicKey })
    .instruction();

  const createTx = await sb.asV0Tx({
    connection,
    ixs: [createIx],
    payer: keypair.publicKey,
    signers: [keypair, randomnessKeypair],
  });
  createSig = await connection.sendTransaction(createTx, txOpts);
  await connection.confirmTransaction(createSig, commitment);

  // Commit, open and bind are atomic: no deployment can be accepted without
  // the future seed slot already fixed by Switchboard.
  const commitOpenBindTx = await sb.asV0Tx({
    connection,
    ixs: [commitIx, openIx, bindIx],
    payer: keypair.publicKey,
    signers: [keypair],
  });
  commitSig = await connection.sendTransaction(commitOpenBindTx, txOpts);
  await connection.confirmTransaction(commitSig, commitment);
  roundState = await myne.account.round.fetch(round);
} else {
  assert.ok(!randomnessPubkey.equals(PublicKey.default), 'Existing round has no bound randomness account');
}

console.log(JSON.stringify({
  ok: true,
  round: ROUND_ID.toString(),
  randomnessAccount: randomnessPubkey.toBase58(),
  createSignature: createSig,
  commitSignature: commitSig,
  status: 'committed-awaiting-deployments-and-reveal',
}, null, 2));

// Execute every funded active Auto-round plan during the betting window. The
// plan PDA, miner PDA and receipt PDA are all bound to the plan authority, so
// the keeper cannot change tile amounts or redirect funds.
const autoExecutions = [];
const receiptRent = BigInt(await connection.getMinimumBalanceForRentExemption(468));
const activePlans = await myne.account.autoPlan.all([
  { dataSize: 267 },
  { memcmp: { offset: 41, bytes: '2' } },
]);
for (const { publicKey: autoPlan, account: plan } of activePlans) {
  const perRound = plan.amounts.reduce((sum, amount) => sum + BigInt(amount.toString()), 0n);
  if (!plan.active || BigInt(plan.balanceLamports.toString()) < perRound + receiptRent
      || BigInt(plan.lastRound.toString()) === ROUND_ID) continue;
  const authority = plan.authority;
  const nonce = BigInt(plan.nextNonce.toString());
  const nonceSeed = Buffer.alloc(8);
  nonceSeed.writeBigUInt64LE(nonce);
  const miner = pda('miner', authority.toBuffer());
  const receipt = pda('bet', roundSeed, authority.toBuffer(), nonceSeed);
  const ix = await myne.methods.executeAutoPlan(ROUND_ID, new anchor.BN(nonce.toString())).accounts({
    config, autoPlan, miner, round, receipt, executor: keypair.publicKey,
    systemProgram: SystemProgram.programId,
  }).instruction();
  autoExecutions.push({ authority: authority.toBase58(), signature: await sendKeeperInstructions([ix]) });
}
if (autoExecutions.length) console.log(JSON.stringify({ event: 'auto-plans-executed', round: ROUND_ID.toString(), executions: autoExecutions }));

// Wait until the round's settlement window, then reveal and settle atomically.
// The verified instruction requires reveal_slot == the current slot, so the
// reveal and settlement instructions must be in the same transaction.
const settlesAt = Number(roundState.settlesAt.toString()) * 1000;
const waitMs = Math.max(0, settlesAt - Date.now() + 500);
if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

let settleSig = null;
if (!roundState.settled) {
const randomnessClient = new sb.Randomness(switchboardProgram, randomnessPubkey);
const revealIx = await randomnessClient.revealIx(keypair.publicKey);
const devnetNoPool = configState.randomnessProgram.toBase58() === 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2';
const gateState = devnetNoPool ? null : await myne.account.liquidityGate.fetch(liquidityGate);
if (!devnetNoPool) {
  assert.ok(gateState.verified, 'Liquidity gate is not verified');
  assert.ok(gateState.myneVault && gateState.solVault, 'Liquidity gate has no verified token vaults');
}
const settleIx = await myne.methods
  .settleRoundVerified()
  .accounts({
    config,
    stakePool,
    round,
    liquidityGate: devnetNoPool ? null : liquidityGate,
    liquidityPool: devnetNoPool ? null : gateState.pool,
    myneVault: devnetNoPool ? null : gateState.myneVault,
    solVault: devnetNoPool ? null : gateState.solVault,
    randomnessAccount: randomnessPubkey,
    buybackWallet: configState.buybackWallet,
  })
  .instruction();
const settleTx = await sb.asV0Tx({
  connection,
  ixs: [revealIx, settleIx],
  payer: keypair.publicKey,
  signers: [keypair],
});
settleSig = await connection.sendTransaction(settleTx, txOpts);
await connection.confirmTransaction(settleSig, commitment);
roundState = await myne.account.round.fetch(round);
}
console.log(JSON.stringify({
  ok: true,
  round: ROUND_ID.toString(),
  randomnessAccount: randomnessPubkey.toBase58(),
  settlementSignature: settleSig,
  status: 'settled',
}, null, 2));

// Auto-burn receipts are permissionless to finalize after settlement. SOL is
// constrained on-chain to the receipt owner and all MYNE becomes that owner's
// virtual 5x burn stake, with no claim fee or keeper custody.
const autoBurnClaims = [];
const roundReceipts = await myne.account.betReceipt.all([
  { dataSize: 468 },
  { memcmp: { offset: 9, bytes: bs58.encode(roundSeed) } },
]);
for (const { publicKey: receipt, account } of roundReceipts) {
  if (BigInt(account.roundId.toString()) !== ROUND_ID || account.claimed || account.refunded
      || Number(account.rewardMode) !== 1) continue;
  const beneficiary = account.authority;
  const miner = pda('miner', beneficiary.toBuffer());
  const stakePosition = pda('stake_position', beneficiary.toBuffer());
  const ix = await myne.methods.claimAutoBurnReceipt().accounts({
    config, miningPool: pda('mining_pool'), stakePool, miner, stakePosition,
    round, receipt, beneficiary, executor: keypair.publicKey,
  }).instruction();
  autoBurnClaims.push({ authority: beneficiary.toBase58(), signature: await sendKeeperInstructions([ix]) });
}
if (autoBurnClaims.length) console.log(JSON.stringify({ event: 'auto-burn-claimed', round: ROUND_ID.toString(), claims: autoBurnClaims }));
