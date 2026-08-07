/*
 * Switchboard round keeper for one-shot rehearsals and supervised production runs.
 *
 * Flow: create + open + bind an uncommitted randomness account -> deployments
 * happen externally -> after betting closes, commit + record the commitment in
 * one transaction -> wait for the seed slot -> reveal + verified settlement in
 * the same transaction slot.
 * A production supervisor should run this script once per scheduled round with
 * the same instruction ordering. Keep the randomness keypair and payer in a
 * secret manager, never in the repository.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import * as sb from '@switchboard-xyz/on-demand';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { requireMatchingSolanaNetwork } from './production-network-policy.mjs';
import { loadExplicitSwitchboardEnv } from './production-switchboard-env.mjs';

const { AnchorProvider, Program, Wallet } = anchor;
const PROGRAM_ID = new PublicKey(process.env.MYNE_PROGRAM_ID || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));

const { keypair, connection, program: switchboardProgram } = await loadExplicitSwitchboardEnv();
const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment: 'confirmed' });
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
assert.equal(Number(configState.version), 6, 'Round keeper requires protocol fee schedule v6');
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
const network = requireMatchingSolanaNetwork({
  genesisHash: await connection.getGenesisHash(),
  randomnessProgram: configState.randomnessProgram.toBase58(),
});
const isMainnet = network === 'mainnet-beta';
const queue = sb.getDefaultQueueAddress(isMainnet);
const indexedRows = async (path) => {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
  });
  const text = await response.text();
  assert.ok(response.ok, `Indexed read failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : [];
};
const scheduledRound = Math.floor(
  (Math.floor(Date.now() / 1000) - Number(configState.initializedAt.toString()))
  / Number(configState.roundDurationSeconds.toString()),
);
assert.ok(scheduledRound >= 0, 'Protocol schedule has not started');
const explicitRoundId = String(process.env.MYNE_ROUND_ID || '').trim();
const resumableRounds = explicitRoundId ? [] : await indexedRows(
  'mine_rounds?resolved=eq.false&closed_signature=is.null&opened_at=not.is.null&select=round_id&order=round_id.asc&limit=2',
);
const resumedFromIndex = !explicitRoundId && resumableRounds.length > 0;
const ROUND_ID = BigInt(explicitRoundId || resumableRounds[0]?.round_id || scheduledRound);
// Anchor's u64 instruction coder requires BN values. Keep the native bigint for
// deterministic PDA seeds and arithmetic, and use this BN at every IDL boundary.
const ROUND_ID_BN = new anchor.BN(ROUND_ID.toString());
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

const buildKeeperTransaction = async (ixs, extraSigners, units, blockhashCommitment = 'finalized') => {
  // Production RPCs may load-balance getLatestBlockhash and simulation across
  // different backend nodes. A finalized hash is old enough to be visible to
  // every healthy backend while still leaving ample transaction lifetime.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(blockhashCommitment);
  const message = new TransactionMessage({
    recentBlockhash: blockhash,
    payerKey: keypair.publicKey,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ...(Number(process.env.KEEPER_PRIORITY_MICROLAMPORTS || 0) > 0
        ? [ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: Math.min(1_000_000, Number(process.env.KEEPER_PRIORITY_MICROLAMPORTS)),
        })]
        : []),
      ...ixs,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([keypair, ...extraSigners]);
  return { transaction, blockhash, lastValidBlockHeight };
};

const sendKeeperInstructions = async (ixs, extraSigners = []) => {
  const simulationBuild = await buildKeeperTransaction(ixs, extraSigners, 1_400_000);
  const simulation = await connection.simulateTransaction(simulationBuild.transaction, {
    commitment,
    sigVerify: false,
    // This pass only measures compute and rejects instruction errors. Allow
    // the selected simulation backend to substitute a blockhash it knows so
    // RPC load balancing cannot cause a false BlockhashNotFound failure.
    replaceRecentBlockhash: true,
  });
  assert.equal(simulation.value.err, null, `Keeper simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).join('\n')}`);
  const measuredUnits = Math.max(50_000, Number(simulation.value.unitsConsumed || 1_400_000));
  const computeLimit = Math.min(1_400_000, Math.ceil(measuredUnits * 1.1));
  const finalBuild = await buildKeeperTransaction(ixs, extraSigners, computeLimit);
  const signature = await connection.sendTransaction(finalBuild.transaction, txOpts);
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: finalBuild.blockhash,
    lastValidBlockHeight: finalBuild.lastValidBlockHeight,
  }, commitment);
  assert.equal(confirmation.value.err, null, `Keeper transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return { signature, measuredUnits, computeLimit };
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const chainTimeSeconds = async () => {
  const slot = await connection.getSlot(commitment);
  const blockTime = await connection.getBlockTime(slot);
  assert.ok(Number.isInteger(blockTime), `Confirmed block time is unavailable at slot ${slot}`);
  return blockTime;
};
const waitForChainTimestamp = async (target) => {
  for (;;) {
    const remaining = target - await chainTimeSeconds();
    if (remaining <= 0) return;
    await sleep(Math.min(5_000, Math.max(400, remaining * 1_000)));
  }
};
const fetchRoundWithRetry = async (predicate, label) => {
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const state = await myne.account.round.fetchNullable(round);
      if (state && predicate(state)) return state;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(4_000, 250 * (2 ** attempt)));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${label} was confirmed but the expected round state did not become visible${detail}`);
};

let roundState = await myne.account.round.fetchNullable(round);
let randomnessPubkey = roundState?.randomnessAccount ?? null;
let bindSig = null;
let commitSig = null;
if (!roundState) {
  if (resumedFromIndex) {
    console.log(JSON.stringify({
      event: 'round-index-ahead-of-rpc',
      round: ROUND_ID.toString(),
      status: 'waiting-for-index-reconciliation',
    }));
    process.exit(0);
  }
  const randomnessKeypair = Keypair.generate();
  const [randomness, createIx] = await sb.Randomness.create(
    switchboardProgram,
    randomnessKeypair,
    queue,
    keypair.publicKey,
  );
  randomnessPubkey = randomness.pubkey;
  const openIx = await myne.methods
    .openRound(ROUND_ID_BN)
    .accounts({ config, round, payer: keypair.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  const bindIx = await myne.methods
    .bindRoundRandomness(ROUND_ID_BN)
    .accounts({ config, round, randomnessAccount: randomnessPubkey, authority: keypair.publicKey })
    .instruction();

  // The request is created, the scheduled round is opened, and the still-
  // uncommitted request is bound atomically. No deployment can be accepted in
  // the gap, and no future seed slot exists while betting remains open.
  bindSig = (await sendKeeperInstructions(
    [createIx, openIx, bindIx],
    [randomnessKeypair],
  )).signature;
  roundState = await fetchRoundWithRetry(
    (state) => state.randomnessAccount.equals(randomnessPubkey),
    'Round creation and randomness binding',
  );
} else {
  assert.ok(!randomnessPubkey.equals(PublicKey.default), 'Existing round has no bound randomness account');
}

const randomnessClient = new sb.Randomness(switchboardProgram, randomnessPubkey);
const asBigInt = (value) => BigInt(value?.toString?.() ?? value ?? 0);
const bettingEndsAt = Number(roundState.bettingEndsAt.toString());
const refundAt = Number(roundState.refundAt.toString());
if (!roundState.settled && (await chainTimeSeconds()) >= refundAt) {
  console.log(JSON.stringify({
    event: 'round-expired-awaiting-lifecycle',
    round: ROUND_ID.toString(),
    totalReceipts: roundState.totalReceipts.toString(),
  }));
  process.exit(0);
}
const initialRandomness = await randomnessClient.loadData();
if (asBigInt(roundState.randomnessCommitSlot) === 0n) {
  assert.equal(asBigInt(initialRandomness.seedSlot), 0n, 'Bound randomness was committed without an atomic MYNE record');
  assert.equal(asBigInt(initialRandomness.revealSlot), 0n, 'Bound randomness was revealed before betting closed');
} else if (!roundState.settled) {
  assert.equal(
    asBigInt(initialRandomness.seedSlot),
    asBigInt(roundState.randomnessCommitSlot),
    'Switchboard seed slot does not match the MYNE commitment record',
  );
  assert.equal(
    asBigInt(initialRandomness.revealSlot),
    0n,
    'Randomness was revealed without atomic settlement; wait for permissionless refunds',
  );
}

console.log(JSON.stringify({
  ok: true,
  round: ROUND_ID.toString(),
  randomnessAccount: randomnessPubkey.toBase58(),
  bindSignature: bindSig,
  commitSignature: commitSig,
  status: asBigInt(roundState.randomnessCommitSlot) === 0n
    ? 'bound-uncommitted-accepting-deployments'
    : 'committed-awaiting-reveal',
}, null, 2));

// Execute every funded active Auto-round plan during the betting window. The
// plan PDA, miner PDA and receipt PDA are all bound to the plan authority, so
// the keeper cannot change tile amounts or redirect funds.
const autoExecutions = [];
const receiptRent = BigInt(await connection.getMinimumBalanceForRentExemption(468));
let activePlanIndex = [];
if ((await chainTimeSeconds()) < bettingEndsAt && asBigInt(roundState.randomnessCommitSlot) === 0n) {
  try {
    activePlanIndex = await indexedRows('mine_auto_plans?active=eq.true&select=authority&order=authority.asc');
  } catch (error) {
    // Auto-round availability may degrade when the index is unavailable, but
    // the randomness lifecycle must still commit and settle the round.
    console.error(JSON.stringify({
      event: 'auto-plan-index-unavailable',
      round: ROUND_ID.toString(),
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
const executable = [];
for (const indexed of activePlanIndex) {
  try {
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
    const ix = await myne.methods.executeAutoPlan(ROUND_ID_BN, new anchor.BN(nonce.toString())).accounts({
      config, autoPlan, miner, round, receipt, executor: keypair.publicKey,
      randomnessAccount: randomnessPubkey,
      systemProgram: SystemProgram.programId,
    }).instruction();
    executable.push({ authority: authority.toBase58(), ix });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'auto-plan-invalid-index-entry',
      round: ROUND_ID.toString(),
      authority: indexed?.authority ?? null,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
const AUTO_BATCH_SIZE = Math.max(1, Math.min(6, Number(process.env.AUTO_PLAN_BATCH_SIZE || 4)));
for (let offset = 0; offset < executable.length; offset += AUTO_BATCH_SIZE) {
  const batch = executable.slice(offset, offset + AUTO_BATCH_SIZE);
  try {
    const sent = await sendKeeperInstructions(batch.map((entry) => entry.ix));
    autoExecutions.push({
      authorities: batch.map((entry) => entry.authority),
      signature: sent.signature,
      measuredUnits: sent.measuredUnits,
      computeLimit: sent.computeLimit,
    });
  } catch (error) {
    // A user may cancel or reconfigure between the indexed read and execution.
    // That race must not prevent the round's post-close commit and settlement.
    console.error(JSON.stringify({
      event: 'auto-plan-batch-skipped',
      round: ROUND_ID.toString(),
      authorities: batch.map((entry) => entry.authority),
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
if (autoExecutions.length) console.log(JSON.stringify({ event: 'auto-plans-executed', round: ROUND_ID.toString(), executions: autoExecutions }));

// Betting must close before the provider request is committed. Commit and the
// MYNE callback are atomic so the recorded slot can never come from an older
// request selected after the deployment set was known.
await waitForChainTimestamp(bettingEndsAt);

roundState = await myne.account.round.fetch(round);
if (!roundState.settled && asBigInt(roundState.randomnessCommitSlot) === 0n) {
  const latestRandomness = await randomnessClient.loadData();
  assert.equal(asBigInt(latestRandomness.seedSlot), 0n, 'Refusing to record a non-atomic or stale Switchboard commitment');
  assert.equal(asBigInt(latestRandomness.revealSlot), 0n, 'Refusing an already revealed randomness request');
  const commitIx = await randomnessClient.commitIx(queue, keypair.publicKey);
  const recordIx = await myne.methods
    .recordRoundRandomnessCommit(ROUND_ID_BN)
    .accounts({ config, round, randomnessAccount: randomnessPubkey, authority: keypair.publicKey })
    .instruction();
  commitSig = (await sendKeeperInstructions([commitIx, recordIx])).signature;
  roundState = await fetchRoundWithRetry(
    (state) => asBigInt(state.randomnessCommitSlot) > 0n,
    'Randomness commitment recording',
  );
  assert.ok(asBigInt(roundState.randomnessCommitSlot) > 0n, 'MYNE did not record the Switchboard commitment');
  console.log(JSON.stringify({
    event: 'randomness-committed',
    round: ROUND_ID.toString(),
    randomnessAccount: randomnessPubkey.toBase58(),
    randomnessCommitSlot: roundState.randomnessCommitSlot.toString(),
    signature: commitSig,
  }));
}

// Wait until both the scheduled settlement time and the committed seed slot
// have passed, then reveal and settle atomically.
// The verified instruction requires reveal_slot == the current slot, so the
// reveal and settlement instructions must be in the same transaction.
const settlesAt = Number(roundState.settlesAt.toString());
await waitForChainTimestamp(settlesAt);

const commitSlot = Number(roundState.randomnessCommitSlot.toString());
assert.ok(commitSlot > 0, 'Round has no recorded Switchboard commitment');
while ((await connection.getSlot(commitment)) <= commitSlot) {
  assert.ok((await chainTimeSeconds()) < Number(roundState.refundAt.toString()), 'Randomness seed slot was not reached before the refund window');
  await sleep(400);
}

let settleSig = null;
if (!roundState.settled) {
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
    adminFeeWallet: configState.adminFeeWallet,
  })
  .instruction();
settleSig = (await sendKeeperInstructions([revealIx, settleIx])).signature;
roundState = await fetchRoundWithRetry(
  (state) => state.settled,
  'Verified round settlement',
);
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
