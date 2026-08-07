/*
 * Switchboard round keeper for one-shot rehearsals and supervised production runs.
 *
 * Flow: create randomness account -> commit + open + bind -> deploys happen
 * externally -> reveal + verified settlement in the same transaction slot.
 * A production supervisor should run this script once per scheduled round with
 * the same instruction ordering. Keep the randomness keypair and payer in a
 * secret manager, never in the repository.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import * as sb from '@switchboard-xyz/on-demand';
import { ComputeBudgetProgram, PublicKey, SystemProgram } from '@solana/web3.js';

const { AnchorProvider, Program } = anchor;
const PROGRAM_ID = new PublicKey(process.env.MYNE_PROGRAM_ID || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));

const { keypair, connection, program: switchboardProgram } = await sb.AnchorUtils.loadEnv();
const provider = new AnchorProvider(connection, switchboardProgram.provider.wallet, { commitment: 'confirmed' });
const myne = new Program(idl, provider);
const commitment = 'confirmed';
const txOpts = { commitment, skipPreflight: false, maxRetries: 3 };
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS');
assert.ok(serviceRole, 'SUPABASE_SERVICE_ROLE_KEY is required for indexed keeper reads');

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
const LIVE_AUTHORIZED = process.env.SWITCHBOARD_KEEPER_LIVE === PROGRAM_ID.toBase58();
if (!LIVE_AUTHORIZED) {
  assert.equal(CONFIRM, ROUND_ID.toString(), `Set CONFIRM_SWITCHBOARD_KEEPER=${ROUND_ID} for a one-shot rehearsal, or SWITCHBOARD_KEEPER_LIVE=${PROGRAM_ID.toBase58()} under the reviewed production supervisor`);
}
const roundSeed = Buffer.alloc(8);
roundSeed.writeBigUInt64LE(ROUND_ID);
const stakePool = pda('stake_pool');
const liquidityGate = pda('liquidity_gate');
const round = pda('round', roundSeed);

const indexedRows = async (path) => {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
  });
  const text = await response.text();
  assert.ok(response.ok, `Indexed read failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : [];
};

const buildKeeperTransaction = (ixs, extraSigners, units) => sb.asV0Tx({
  connection,
  ixs: [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ...(Number(process.env.KEEPER_PRIORITY_MICROLAMPORTS || 0) > 0
      ? [ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.min(1_000_000, Number(process.env.KEEPER_PRIORITY_MICROLAMPORTS)),
      })]
      : []),
    ...ixs,
  ],
  payer: keypair.publicKey,
  signers: [keypair, ...extraSigners],
});

const sendKeeperInstructions = async (ixs, extraSigners = []) => {
  const simulationTx = await buildKeeperTransaction(ixs, extraSigners, 1_400_000);
  const simulation = await connection.simulateTransaction(simulationTx, {
    commitment,
    sigVerify: false,
  });
  assert.equal(simulation.value.err, null, `Keeper simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).join('\n')}`);
  const measuredUnits = Math.max(50_000, Number(simulation.value.unitsConsumed || 1_400_000));
  const computeLimit = Math.min(1_400_000, Math.ceil(measuredUnits * 1.1));
  const transaction = await buildKeeperTransaction(ixs, extraSigners, computeLimit);
  const signature = await connection.sendTransaction(transaction, txOpts);
  const confirmation = await connection.confirmTransaction(signature, commitment);
  assert.equal(confirmation.value.err, null, `Keeper transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return { signature, measuredUnits, computeLimit };
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

  createSig = (await sendKeeperInstructions([createIx], [randomnessKeypair])).signature;

  // Commit, open and bind are atomic: no deployment can be accepted without
  // the future seed slot already fixed by Switchboard.
  commitSig = (await sendKeeperInstructions([commitIx, openIx, bindIx])).signature;
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
const activePlanIndex = await indexedRows('mine_auto_plans?active=eq.true&select=authority&order=authority.asc');
const executable = [];
for (const indexed of activePlanIndex) {
  const authority = new PublicKey(indexed.authority);
  const autoPlan = pda('auto_plan', authority.toBuffer());
  const plan = await myne.account.autoPlan.fetchNullable(autoPlan);
  if (!plan || !plan.authority.equals(authority)) continue;
  const perRound = plan.amounts.reduce((sum, amount) => sum + BigInt(amount.toString()), 0n);
  if (!plan.active || BigInt(plan.balanceLamports.toString()) < perRound + receiptRent
      || BigInt(plan.lastRound.toString()) === ROUND_ID) continue;
  const nonce = BigInt(plan.nextNonce.toString());
  const nonceSeed = Buffer.alloc(8);
  nonceSeed.writeBigUInt64LE(nonce);
  const miner = pda('miner', authority.toBuffer());
  const receipt = pda('bet', roundSeed, authority.toBuffer(), nonceSeed);
  const ix = await myne.methods.executeAutoPlan(ROUND_ID, new anchor.BN(nonce.toString())).accounts({
    config, autoPlan, miner, round, receipt, executor: keypair.publicKey,
    systemProgram: SystemProgram.programId,
  }).instruction();
  executable.push({ authority: authority.toBase58(), ix });
}
const AUTO_BATCH_SIZE = Math.max(1, Math.min(6, Number(process.env.AUTO_PLAN_BATCH_SIZE || 4)));
for (let offset = 0; offset < executable.length; offset += AUTO_BATCH_SIZE) {
  const batch = executable.slice(offset, offset + AUTO_BATCH_SIZE);
  const sent = await sendKeeperInstructions(batch.map((entry) => entry.ix));
  autoExecutions.push({
    authorities: batch.map((entry) => entry.authority),
    signature: sent.signature,
    measuredUnits: sent.measuredUnits,
    computeLimit: sent.computeLimit,
  });
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
settleSig = (await sendKeeperInstructions([revealIx, settleIx])).signature;
roundState = await myne.account.round.fetch(round);
}
console.log(JSON.stringify({
  ok: true,
  round: ROUND_ID.toString(),
  randomnessAccount: randomnessPubkey.toBase58(),
  settlementSignature: settleSig,
  status: 'settled',
}, null, 2));

// Receipt settlement/refunds, archival and rent recovery run through the
// indexed lifecycle keeper. Keeping those tasks separate prevents the
// reveal-critical transaction from expanding with unrelated account work.
