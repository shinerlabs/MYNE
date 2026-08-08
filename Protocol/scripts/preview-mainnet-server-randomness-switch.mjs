/**
 * Guarded cutover for MYNE server commit–reveal.
 *
 * The default path is read-only and only simulates set_randomness_program.
 * Submission additionally requires SUBMIT_MAINNET_SERVER_RANDOMNESS to equal
 * the exact config PDA, then confirms and reads the paused config back.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  SOLANA_MAINNET_GENESIS_HASH,
  SWITCHBOARD_MAINNET_PROGRAM,
} from './production-network-policy.mjs';
import { PROVIDER_PREPARATION_LEAD_SECONDS } from './round-schedule-policy.mjs';

const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const SWITCHBOARD_PROGRAM_ID = new PublicKey(SWITCHBOARD_MAINNET_PROGRAM);
const COMPUTE_UNIT_LIMIT = 100_000;
const MINIMUM_FIRST_ROUND_PREPARATION_LEAD_SECONDS = 300;

const requiredEnv = (name) => {
  const value = String(process.env[name] || '').trim();
  assert.ok(value, `${name} is required`);
  return value;
};

const requireConfirmation = (name, expected) => {
  assert.equal(process.env[name], expected, `Set ${name}=${expected} after reviewing the cutover`);
};

const readKeypair = async (path) => {
  const secret = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(Array.isArray(secret) && secret.length === 64, 'ANCHOR_WALLET must contain a keypair');
  assert.ok(
    secret.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    'ANCHOR_WALLET contains an invalid byte',
  );
  return Keypair.fromSecretKey(Uint8Array.from(secret));
};

const rpcUrl = requiredEnv('MAINNET_RPC_URL');
const payer = await readKeypair(requiredEnv('ANCHOR_WALLET'));
const randomnessAuthority = new PublicKey(requiredEnv('MAINNET_RANDOMNESS_AUTHORITY'));
const firstServerRoundText = requiredEnv('MAINNET_FIRST_SERVER_ROUND_ID');
assert.match(firstServerRoundText, /^\d+$/, 'MAINNET_FIRST_SERVER_ROUND_ID must be an unsigned integer');
const firstServerRoundId = Number(firstServerRoundText);
assert.ok(Number.isSafeInteger(firstServerRoundId), 'MAINNET_FIRST_SERVER_ROUND_ID is too large');
const supabaseUrl = requiredEnv('SUPABASE_URL').replace(/\/$/, '');
const serviceRole = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
assert.match(rpcUrl, /^https:\/\//, 'MAINNET_RPC_URL must use HTTPS');
assert.match(supabaseUrl, /^https:\/\//, 'SUPABASE_URL must use HTTPS');

const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [liquidityGate] = PublicKey.findProgramAddressSync(
  [Buffer.from('liquidity_gate')],
  PROGRAM_ID,
);
requireConfirmation('CONFIRM_SOLANA_GENESIS_HASH', SOLANA_MAINNET_GENESIS_HASH);
requireConfirmation('CONFIRM_MAINNET_CONFIG', config.toBase58());
requireConfirmation('CONFIRM_SERVER_RANDOMNESS_PROGRAM', PROGRAM_ID.toBase58());
requireConfirmation('CONFIRM_MAINNET_RANDOMNESS_AUTHORITY', randomnessAuthority.toBase58());
requireConfirmation('CONFIRM_MAINNET_FIRST_SERVER_ROUND_ID', firstServerRoundText);
requireConfirmation('CONFIRM_SWITCHBOARD_ROUNDS_DRAINED', 'VERIFIED_NO_UNRESOLVED_ROUNDS');
requireConfirmation('CONFIRM_SERVER_RANDOMNESS_REVIEW', 'APPROVED_EXACT_RELEASE');

const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
assert.equal(await connection.getGenesisHash(), SOLANA_MAINNET_GENESIS_HASH, 'RPC is not Mainnet');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
assert.equal(idl.address, PROGRAM_ID.toBase58(), 'IDL program address differs');
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(payer),
  { commitment: 'confirmed', preflightCommitment: 'confirmed' },
);
const program = new anchor.Program(idl, provider);
const configState = await program.account.protocolConfig.fetch(config, 'finalized');
const liquidityGateState = await program.account.liquidityGate.fetch(liquidityGate, 'finalized');
assert.equal(liquidityGateState.verified, true, 'Mainnet liquidity gate is not verified');
const liquidityPool = liquidityGateState.pool;
const liquidityPoolInfo = await connection.getAccountInfo(liquidityPool, 'finalized');
assert.ok(liquidityPoolInfo, 'Configured liquidity pool account does not exist');
assert.ok(
  liquidityPoolInfo.owner.equals(liquidityGateState.poolProgram),
  'Configured liquidity pool owner differs from the verified gate',
);
assert.equal(Number(configState.version), 6, 'Protocol is not fee schedule v6');
assert.equal(configState.paused, true, 'Protocol must remain paused during the provider switch');
assert.ok(configState.admin.equals(payer.publicKey), 'Signer is not the protocol admin');
assert.ok(
  configState.randomnessAuthority.equals(randomnessAuthority),
  'Configured randomness authority differs from the reviewed server keeper',
);
assert.ok(
  configState.randomnessProgram.equals(SWITCHBOARD_PROGRAM_ID)
    || configState.randomnessProgram.equals(PROGRAM_ID),
  'Current randomness provider is neither reviewed Switchboard nor server commit–reveal',
);

const unresolvedResponse = await fetch(
  `${supabaseUrl}/rest/v1/mine_rounds?resolved=eq.false&closed_signature=is.null&select=round_id,randomness_id,randomness_commit_slot&order=round_id.asc&limit=10`,
  { headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` } },
);
const unresolvedText = await unresolvedResponse.text();
assert.ok(
  unresolvedResponse.ok,
  `Unresolved-round index check failed (${unresolvedResponse.status}): ${unresolvedText}`,
);
const unresolvedRounds = unresolvedText ? JSON.parse(unresolvedText) : [];
assert.deepEqual(unresolvedRounds, [], 'Unresolved Switchboard rounds must be settled/refunded before switching');

const finalizedSlot = await connection.getSlot('finalized');
const chainTime = await connection.getBlockTime(finalizedSlot);
assert.ok(Number.isInteger(chainTime), 'Finalized chain time is unavailable');
const initializedAt = Number(configState.initializedAt.toString());
const roundDurationSeconds = Number(configState.roundDurationSeconds.toString());
const firstPreparationStartsAt = initializedAt
  + firstServerRoundId * roundDurationSeconds
  - PROVIDER_PREPARATION_LEAD_SECONDS;
const firstOpenedAt = initializedAt + firstServerRoundId * roundDurationSeconds;
assert.ok(firstOpenedAt > chainTime, 'First server round must still be in the future');
assert.ok(
  firstPreparationStartsAt >= chainTime + MINIMUM_FIRST_ROUND_PREPARATION_LEAD_SECONDS,
  'First server round must leave at least five minutes before its preparation window',
);

if (configState.randomnessProgram.equals(PROGRAM_ID)) {
  console.log(JSON.stringify({
    ok: true,
    simulationOnly: true,
    alreadyServerRandomness: true,
    config: config.toBase58(),
    randomnessProgram: PROGRAM_ID.toBase58(),
    randomnessAuthority: randomnessAuthority.toBase58(),
    firstServerRoundId,
    firstPreparationStartsAt,
    firstOpenedAt,
  }, null, 2));
  process.exit(0);
}

const switchInstruction = await program.methods
  .setRandomnessProgram(PROGRAM_ID)
  .accounts({ config, liquidityGate, liquidityPool, admin: payer.publicKey })
  .instruction();
const latest = await connection.getLatestBlockhash('finalized');
const message = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: latest.blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    switchInstruction,
  ],
}).compileToV0Message();
const transaction = new VersionedTransaction(message);
transaction.sign([payer]);
const simulation = await connection.simulateTransaction(transaction, {
  commitment: 'confirmed',
  replaceRecentBlockhash: false,
  sigVerify: true,
});
assert.equal(
  simulation.value.err,
  null,
  `Server-randomness switch simulation failed:\n${(simulation.value.logs || []).join('\n')}`,
);

if (process.env.SUBMIT_MAINNET_SERVER_RANDOMNESS !== config.toBase58()) {
  console.log(JSON.stringify({
    ok: true,
    simulationOnly: true,
    submissionSupported: true,
    config: config.toBase58(),
    previousRandomnessProgram: configState.randomnessProgram.toBase58(),
    randomnessProgram: PROGRAM_ID.toBase58(),
    randomnessAuthority: randomnessAuthority.toBase58(),
    firstServerRoundId,
    firstPreparationStartsAt,
    firstOpenedAt,
    unitsConsumed: simulation.value.unitsConsumed ?? null,
    submitWith: `SUBMIT_MAINNET_SERVER_RANDOMNESS=${config.toBase58()}`,
  }, null, 2));
  process.exit(0);
}

const signature = await connection.sendRawTransaction(transaction.serialize(), {
  maxRetries: 3,
  preflightCommitment: 'confirmed',
  skipPreflight: false,
});
const confirmation = await connection.confirmTransaction({
  signature,
  blockhash: latest.blockhash,
  lastValidBlockHeight: latest.lastValidBlockHeight,
}, 'finalized');
assert.equal(confirmation.value.err, null, `Server-randomness switch failed: ${signature}`);

let switchedConfig = null;
for (let attempt = 0; attempt < 5; attempt += 1) {
  switchedConfig = await program.account.protocolConfig.fetch(config, 'finalized');
  if (switchedConfig.randomnessProgram.equals(PROGRAM_ID)) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
assert.equal(switchedConfig?.paused, true, 'Protocol must remain paused after provider switch');
assert.ok(
  switchedConfig?.randomnessProgram.equals(PROGRAM_ID),
  `Randomness provider did not change; transaction ${signature}`,
);
assert.ok(
  switchedConfig?.randomnessAuthority.equals(randomnessAuthority),
  'Randomness authority changed during provider switch',
);

console.log(JSON.stringify({
  ok: true,
  simulationOnly: false,
  submitted: true,
  config: config.toBase58(),
  previousRandomnessProgram: configState.randomnessProgram.toBase58(),
  randomnessProgram: PROGRAM_ID.toBase58(),
  randomnessAuthority: randomnessAuthority.toBase58(),
  firstServerRoundId,
  firstPreparationStartsAt,
  firstOpenedAt,
  unitsConsumed: simulation.value.unitsConsumed ?? null,
  signature,
}, null, 2));
