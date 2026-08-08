/*
 * Server commit–reveal round keeper.
 *
 * One explicit process owns one scheduled round. The production host overlaps
 * these processes and starts each during the bounded provider preparation
 * window, so `open_round` + commitment binding land before `opened_at` while
 * the exact 60-second betting interval remains schedule-anchored on chain.
 *
 * The random preimage is fsynced to mounted durable storage before its
 * commitment can be submitted. Settlement mixes that committed preimage with
 * a future SlotHashes entry fixed permissionlessly only after betting closes.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { requireMatchingSolanaNetwork } from './production-network-policy.mjs';
import {
  ROUND_KEEPER_DEFERRED_EXIT_CODE,
  ROUND_KEEPER_MISSED_EXIT_CODE,
} from './round-schedule-policy.mjs';
import {
  SERVER_RANDOMNESS_PENDING,
  decodeServerEntropySlot,
  loadOrCreateServerReveal,
  serverEntropyAvailable,
  serverRandomnessCommitment,
} from './server-randomness-policy.mjs';
import { executeAutoPlansDuringWindow } from './auto-plan-executor.mjs';

const { AnchorProvider, Program, Wallet } = anchor;
const PROGRAM_ID = new PublicKey(
  process.env.MYNE_PROGRAM_ID || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e',
);
const commitment = 'confirmed';
const txOpts = { commitment, skipPreflight: false, maxRetries: 3 };

const requiredEnv = (name) => {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
};
const rpcUrl = requiredEnv('ANCHOR_PROVIDER_URL');
const walletPath = requiredEnv('ANCHOR_WALLET');
const stateDir = requiredEnv('SERVER_RANDOMNESS_STATE_DIR');
const supabaseUrl = requiredEnv('SUPABASE_URL').replace(/\/$/, '');
const serviceRole = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
assert.match(rpcUrl, /^https:\/\//, 'ANCHOR_PROVIDER_URL must use HTTPS');
assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS');
const secret = JSON.parse(await readFile(walletPath, 'utf8'));
assert.ok(Array.isArray(secret) && secret.length === 64, 'ANCHOR_WALLET must contain a keypair');
assert.ok(
  secret.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
  'ANCHOR_WALLET contains an invalid byte',
);
const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
const connection = new Connection(rpcUrl, { commitment });
const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment });
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const program = new Program(idl, provider);

const pda = (seed, ...extra) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), ...extra.map((value) => Buffer.from(value))],
  PROGRAM_ID,
)[0];
const config = pda('config');
const stakePool = pda('stake_pool');
const liquidityGate = pda('liquidity_gate');
const configState = await program.account.protocolConfig.fetch(config);
assert.equal(Number(configState.version), 6, 'Server round keeper requires protocol fee schedule v6');
if (configState.paused) {
  console.log(JSON.stringify({ event: 'server-round-idle', reason: 'protocol-paused' }));
  process.exit(ROUND_KEEPER_DEFERRED_EXIT_CODE);
}
assert.ok(
  configState.randomnessProgram.equals(PROGRAM_ID),
  'Server keeper requires the MYNE program-id randomness mode',
);
assert.ok(
  configState.randomnessAuthority.equals(keypair.publicKey),
  'Keeper wallet must equal config.randomness_authority',
);
requireMatchingSolanaNetwork({
  genesisHash: await connection.getGenesisHash(),
  randomnessProgram: configState.randomnessProgram.toBase58(),
  serverRandomnessProgram: PROGRAM_ID.toBase58(),
});

const explicitRoundId = requiredEnv('MYNE_ROUND_ID');
assert.match(explicitRoundId, /^\d+$/, 'MYNE_ROUND_ID must be an unsigned integer');
const ROUND_ID = BigInt(explicitRoundId);
const ROUND_ID_BN = new anchor.BN(ROUND_ID.toString());
const LIVE_AUTHORIZED = process.env.SERVER_RANDOMNESS_KEEPER_LIVE === PROGRAM_ID.toBase58();
assert.ok(
  LIVE_AUTHORIZED,
  `Set SERVER_RANDOMNESS_KEEPER_LIVE=${PROGRAM_ID.toBase58()} only after server-mode approval`,
);
const roundSeed = Buffer.alloc(8);
roundSeed.writeBigUInt64LE(ROUND_ID);
const round = pda('round', roundSeed);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const asBigInt = (value) => BigInt(value?.toString?.() ?? value ?? 0);
const chainTimeSeconds = async () => {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const slot = await connection.getSlot('confirmed');
      for (let offset = 0; offset < 16 && slot >= offset; offset += 1) {
        try {
          const blockTime = await connection.getBlockTime(slot - offset);
          if (Number.isInteger(blockTime)) return blockTime;
        } catch (error) {
          lastError = error;
          if (Number(error?.code) !== -32004) break;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(2_000, 200 * (2 ** attempt)));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Confirmed chain time is temporarily unavailable${detail}`);
};
const waitForChainTimestamp = async (target) => {
  for (;;) {
    const remaining = target - await chainTimeSeconds();
    if (remaining <= 0) return;
    await sleep(Math.min(4_000, Math.max(250, remaining * 1_000)));
  }
};
const fetchRoundWithRetry = async (predicate, label) => {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const state = await program.account.round.fetchNullable(round);
      if (state && predicate(state)) return state;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(3_000, 200 * (2 ** attempt)));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${label} did not become visible${detail}`);
};
const indexedRows = async (path) => {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
  });
  const text = await response.text();
  assert.ok(response.ok, `Indexed read failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : [];
};

const buildKeeperTransaction = async (ixs, units, blockhashCommitment = 'finalized') => {
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
  transaction.sign([keypair]);
  return { transaction, blockhash, lastValidBlockHeight };
};
const sendKeeperInstructions = async (ixs) => {
  const simulationBuild = await buildKeeperTransaction(ixs, 1_400_000);
  const simulation = await connection.simulateTransaction(simulationBuild.transaction, {
    commitment,
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  assert.equal(
    simulation.value.err,
    null,
    `Keeper simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs || []).join('\n')}`,
  );
  const measuredUnits = Math.max(50_000, Number(simulation.value.unitsConsumed || 1_400_000));
  const computeLimit = Math.min(1_400_000, Math.ceil(measuredUnits * 1.1));
  const finalBuild = await buildKeeperTransaction(ixs, computeLimit);
  const signature = await connection.sendTransaction(finalBuild.transaction, txOpts);
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: finalBuild.blockhash,
    lastValidBlockHeight: finalBuild.lastValidBlockHeight,
  }, commitment);
  assert.equal(confirmation.value.err, null, `Keeper transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return { signature, measuredUnits, computeLimit };
};

let roundState = await program.account.round.fetchNullable(round);
if (roundState?.settled) {
  console.log(JSON.stringify({ ok: true, event: 'server-round-already-settled', round: ROUND_ID.toString() }));
  process.exit(0);
}

if (!roundState) {
  const scheduledOpenedAt = Number(configState.initializedAt.toString())
    + Number(ROUND_ID) * Number(configState.roundDurationSeconds.toString());
  if ((await chainTimeSeconds()) >= scheduledOpenedAt) {
    console.error(JSON.stringify({
      event: 'server-round-window-missed',
      round: ROUND_ID.toString(),
      scheduledOpenedAt,
    }));
    process.exit(ROUND_KEEPER_MISSED_EXIT_CODE);
  }
}

// Persist before constructing either on-chain instruction. Never print this
// preimage: it remains secret until permissionless settlement publishes it.
const reveal = await loadOrCreateServerReveal({ stateDir, roundId: ROUND_ID });
const roundCommitment = serverRandomnessCommitment({
  programId: PROGRAM_ID,
  mint: configState.mint,
  roundId: ROUND_ID,
  reveal,
});
let bindSignature = null;
if (!roundState) {
  const openIx = await program.methods
    .openRound(ROUND_ID_BN)
    .accounts({ config, round, payer: keypair.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  const bindIx = await program.methods
    .bindRoundServerCommitment(ROUND_ID_BN, Array.from(roundCommitment))
    .accounts({ config, round, authority: keypair.publicKey })
    .instruction();
  bindSignature = (await sendKeeperInstructions([openIx, bindIx])).signature;
  roundState = await fetchRoundWithRetry(
    (state) => Buffer.from(state.randomnessAccount.toBytes()).equals(roundCommitment),
    'Atomic round opening and server commitment binding',
  );
} else {
  assert.ok(
    Buffer.from(roundState.randomnessAccount.toBytes()).equals(roundCommitment),
    'Persisted reveal does not match the round commitment; refusing an unrecoverable settlement',
  );
  assert.ok(
    asBigInt(roundState.randomnessCommitSlot) === SERVER_RANDOMNESS_PENDING
      || asBigInt(roundState.randomnessCommitSlot) > 0n,
    'Existing round is not a bound server commit–reveal round',
  );
}

const openedAt = Number(roundState.openedAt.toString());
const bettingEndsAt = Number(roundState.bettingEndsAt.toString());
const refundAt = Number(roundState.refundAt.toString());
console.log(JSON.stringify({
  ok: true,
  event: 'server-round-commitment-bound',
  round: ROUND_ID.toString(),
  openedAt,
  bettingEndsAt,
  bindSignature,
}));

// A pre-created round exists before betting but the program rejects both
// manual and automated deployments until its scheduled `opened_at`.
await waitForChainTimestamp(openedAt);
if ((await chainTimeSeconds()) < bettingEndsAt) {
  const receiptRent = BigInt(await connection.getMinimumBalanceForRentExemption(468));
  await executeAutoPlansDuringWindow({
    bettingEndsAt,
    nowSeconds: chainTimeSeconds,
    sleep,
    indexedRows,
    buildEntry: async ({ authority: indexedAuthority }) => {
      const authority = new PublicKey(indexedAuthority);
      const autoPlan = pda('auto_plan', authority.toBuffer());
      const plan = await program.account.autoPlan.fetchNullable(autoPlan);
      if (!plan || !plan.authority.equals(authority)) return null;
      const perRound = plan.amounts.reduce((sum, amount) => sum + asBigInt(amount), 0n);
      if (!plan.active || asBigInt(plan.balanceLamports) < perRound + receiptRent
          || asBigInt(plan.lastRound) === ROUND_ID) return null;
      const nonce = asBigInt(plan.nextNonce);
      const nonceSeed = Buffer.alloc(8);
      nonceSeed.writeBigUInt64LE(nonce);
      const miner = pda('miner', authority.toBuffer());
      const receipt = pda('bet', roundSeed, authority.toBuffer(), nonceSeed);
      const ix = await program.methods
        .executeAutoPlan(ROUND_ID_BN, new anchor.BN(nonce.toString()))
        .accounts({
          config, autoPlan, miner, round, receipt, executor: keypair.publicKey,
          randomnessAccount: null, systemProgram: SystemProgram.programId,
        })
        .instruction();
      return { authority: authority.toBase58(), ix };
    },
    sendBatch: (batch) => sendKeeperInstructions(batch.map(({ ix }) => ix)),
    onEvent: (event) => console[event.error ? 'error' : 'log'](JSON.stringify({
      ...event, round: ROUND_ID.toString(),
    })),
  });
}

await waitForChainTimestamp(bettingEndsAt);
roundState = await program.account.round.fetch(round);
if (!roundState.settled && asBigInt(roundState.randomnessCommitSlot) === SERVER_RANDOMNESS_PENDING) {
  const lockIx = await program.methods
    .lockRoundServerEntropy(ROUND_ID_BN)
    .accounts({ config, round, executor: keypair.publicKey })
    .instruction();
  const lockSignature = (await sendKeeperInstructions([lockIx])).signature;
  roundState = await fetchRoundWithRetry(
    (state) => asBigInt(state.randomnessCommitSlot) !== SERVER_RANDOMNESS_PENDING,
    'Future server entropy slot lock',
  );
  console.log(JSON.stringify({
    event: 'server-entropy-locked',
    round: ROUND_ID.toString(),
    signature: lockSignature,
  }));
}
if (roundState.settled) {
  console.log(JSON.stringify({ ok: true, event: 'server-round-settled', round: ROUND_ID.toString() }));
  process.exit(0);
}
assert.ok((await chainTimeSeconds()) < refundAt, 'Round reached its refund window before server settlement');
const targetSlot = decodeServerEntropySlot(roundState.randomnessCommitSlot);
for (;;) {
  assert.ok((await chainTimeSeconds()) < refundAt, 'Future entropy slot was not retained before refund');
  const slotHashes = await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, commitment);
  if (slotHashes && serverEntropyAvailable(slotHashes.data, targetSlot)) break;
  await sleep(150);
}

const gateState = await program.account.liquidityGate.fetch(liquidityGate);
assert.equal(gateState.verified, true, 'Liquidity gate is not verified');
assert.ok(gateState.myneVault && gateState.solVault, 'Liquidity gate has no verified token vaults');
const settleIx = await program.methods
  .settleRoundServer(Array.from(reveal))
  .accounts({
    config,
    stakePool,
    round,
    liquidityGate,
    liquidityPool: gateState.pool,
    myneVault: gateState.myneVault,
    solVault: gateState.solVault,
    slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    buybackWallet: configState.buybackWallet,
    adminFeeWallet: configState.adminFeeWallet,
    executor: keypair.publicKey,
  })
  .instruction();
const settlementSignature = (await sendKeeperInstructions([settleIx])).signature;
roundState = await fetchRoundWithRetry((state) => state.settled, 'Server round settlement');
console.log(JSON.stringify({
  ok: true,
  event: 'server-round-settled',
  round: ROUND_ID.toString(),
  settlementSignature,
}));
