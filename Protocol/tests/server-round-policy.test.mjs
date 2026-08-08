import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  SERVER_RANDOMNESS_PENDING,
  SERVER_RANDOMNESS_SLOT_FLAG,
  decodeServerEntropySlot,
  loadOrCreateServerReveal,
  serverEntropyAvailable,
  serverRandomnessCommitment,
} from '../scripts/server-randomness-policy.mjs';

test('server commitment matches the on-chain domain/order fixture', () => {
  const commitment = serverRandomnessCommitment({
    programId: new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e'),
    mint: PublicKey.default,
    roundId: 41n,
    reveal: Buffer.alloc(32, 7),
  });
  assert.equal(
    commitment.toString('hex'),
    '6a4359e446a0b1776433ff49418831a41001baf3971e2c32107a3eabc9e84ad8',
  );
});

test('a restart recovers the same fsynced reveal instead of changing a bound commitment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'myne-server-randomness-'));
  try {
    const first = await loadOrCreateServerReveal({ stateDir: root, roundId: 52n });
    const second = await loadOrCreateServerReveal({ stateDir: root, roundId: 52n });
    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    const path = join(root, 'round-52.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.roundId, '52');
    assert.equal(saved.revealHex, first.toString('hex'));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server entropy encoding rejects pending and legacy Switchboard slots', () => {
  assert.throws(() => decodeServerEntropySlot(SERVER_RANDOMNESS_PENDING), /not locked/);
  assert.throws(() => decodeServerEntropySlot(42n), /not in server randomness mode/);
  assert.equal(decodeServerEntropySlot(SERVER_RANDOMNESS_SLOT_FLAG | 42n), 42n);
});

test('keeper detects the first retained entropy slot without waiting an extra slot', () => {
  const data = Buffer.alloc(8 + 3 * 40);
  data.writeBigUInt64LE(3n, 0);
  for (const [index, slot] of [105n, 103n, 100n].entries()) {
    data.writeBigUInt64LE(slot, 8 + index * 40);
    data.fill(index + 1, 16 + index * 40, 48 + index * 40);
  }
  assert.equal(serverEntropyAvailable(data, 101n), true);
  assert.equal(serverEntropyAvailable(data, 106n), false);
  assert.throws(() => serverEntropyAvailable(data, 99n), /aged out/);
  assert.throws(() => serverEntropyAvailable(data.subarray(0, -1), 101n), /truncated/);
});

test('server keeper binds before start, preserves the future-slot mix, and settles empty rounds', async () => {
  const source = await readFile(
    new URL('../scripts/server-round-keeper.mjs', import.meta.url),
    'utf8',
  );
  const persist = source.indexOf('const reveal = await loadOrCreateServerReveal');
  const open = source.indexOf('.openRound(ROUND_ID_BN)');
  const bind = source.indexOf('.bindRoundServerCommitment(ROUND_ID_BN');
  const atomicBind = source.indexOf('[openIx, bindIx]');
  const bettingStart = source.indexOf('waitForChainTimestamp(openedAt)');
  const auto = source.indexOf('.executeAutoPlan(ROUND_ID_BN');
  const bettingClose = source.indexOf('waitForChainTimestamp(bettingEndsAt)');
  const lock = source.indexOf('.lockRoundServerEntropy(ROUND_ID_BN)');
  const futureSlot = source.indexOf('serverEntropyAvailable(slotHashes.data, targetSlot)');
  const settlementWindow = source.indexOf('waitForChainTimestamp(settlesAt)');
  const settle = source.indexOf('.settleRoundServer(Array.from(reveal))');

  for (const [label, index] of Object.entries({
    persist, open, bind, atomicBind, bettingStart, auto, bettingClose, lock, futureSlot,
    settlementWindow, settle,
  })) assert.ok(index >= 0, `Missing ${label} phase`);
  assert.ok(persist < open && open < bind && bind < atomicBind, 'Commitment was not durably bound atomically');
  assert.ok(atomicBind < bettingStart && bettingStart < auto, 'Auto plans must wait for scheduled opened_at');
  assert.ok(auto < bettingClose && bettingClose < lock, 'Entropy must be locked only after betting closes');
  assert.ok(
    lock < futureSlot && futureSlot < settlementWindow && settlementWindow < settle,
    'Reveal must mix future entropy and wait for the absolute settlement window',
  );
  assert.match(source, /slotHashes: SYSVAR_SLOT_HASHES_PUBKEY/);
  assert.match(source, /replaceRecentBlockhash:\s*true/);
  assert.match(source, /reason: 'protocol-paused'[\s\S]*ROUND_KEEPER_DEFERRED_EXIT_CODE/);
  assert.match(source, /scheduledOpenedAt[\s\S]*ROUND_KEEPER_MISSED_EXIT_CODE/);
  assert.match(source, /createWorkerHeartbeat\('round-keeper'/);
  assert.match(source, /stage,[\s\S]*deadlines:/);
  assert.match(source, /next-prebind-deadline-missed/);
  assert.match(source, /lock-deadline-missed/);
  assert.match(source, /settlement-deadline-missed/);
  assert.match(source, /withOperationTimeout/);
  assert.match(source, /ROUND_KEEPER_RPC_TIMEOUT_MS/);
  assert.match(source, /ROUND_KEEPER_TRANSACTION_TIMEOUT_MS/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /SERVER_ROUND_PREPARATION_COMPUTE_LIMIT = 60_000/);
  assert.match(source, /SERVER_ENTROPY_LOCK_COMPUTE_LIMIT = 30_000/);
  assert.match(source, /SERVER_SETTLEMENT_COMPUTE_LIMIT = 80_000/);
  assert.match(source, /SERVER_ROUND_PRIORITY_MICROLAMPORTS[\s\S]*50_000/);
  assert.match(
    source,
    /'Atomic round preparation',[\s\S]*fixedComputeLimit: SERVER_ROUND_PREPARATION_COMPUTE_LIMIT,[\s\S]*skipPreflight: true/,
  );
  assert.match(
    source,
    /'Server entropy lock',[\s\S]*fixedComputeLimit: SERVER_ENTROPY_LOCK_COMPUTE_LIMIT,[\s\S]*skipPreflight: true/,
  );
  assert.match(
    source,
    /'Server round settlement',[\s\S]*fixedComputeLimit: SERVER_SETTLEMENT_COMPUTE_LIMIT,[\s\S]*skipPreflight: true/,
  );
  assert.doesNotMatch(source, /roundState\.(?:totalReceipts|grossDeployedLamports)\s*[!<>=]/);
  assert.doesNotMatch(source, /@switchboard-xyz/);
});

test('server keeper uses betting close as the on-chain settlement boundary', async () => {
  const [source, programSource] = await Promise.all([
    readFile(new URL('../scripts/server-round-keeper.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../programs/myne_protocol/src/lib.rs', import.meta.url), 'utf8'),
  ]);
  assert.match(programSource, /RESOLUTION_COUNTDOWN_SECONDS:\s*u64\s*=\s*0;/);
  assert.match(
    source,
    /const scheduledSettlesAt = scheduledBettingEndsAt;/,
    'Settlement must start at 60 seconds so the winner can occupy the five-second result interval',
  );
  assert.doesNotMatch(
    source,
    /const scheduledSettlesAt = scheduledOpenedAt\s*\n\s*\+ Number\(configState\.roundDurationSeconds/,
  );
  assert.match(
    source,
    /if \(lockCompletedAt >= heartbeatDeadlines\.settleAt\)/,
    'The first legal lock second must not be reported as a missed deadline',
  );
  assert.match(
    source,
    /if \(settlementStartedAt >= heartbeatDeadlines\.settleAt\)/,
    'Settlement at the next round boundary is too late for the winner interval',
  );
  assert.match(source, /finalizedTransactionTimeSeconds\(\s*settlementSignature/);
  assert.match(source, /settlementConfirmedWithinResultWindow/);
  assert.equal(
    source.match(/await emitTerminalRoundHeartbeat\('tick-error', 'settlement-deadline-missed', outcome\)/g)?.length,
    2,
    'Both fresh settlement and restart recovery must deliver the deadline incident before exit',
  );
  const deadlineBranchStart = source.indexOf('if (settlementDeadlineMet)');
  const deadlineBranch = source.slice(
    deadlineBranchStart,
    source.indexOf('console.log(JSON.stringify({', deadlineBranchStart),
  );
  assert.doesNotMatch(
    deadlineBranch.slice(deadlineBranch.indexOf('} else {')),
    /emitRoundHeartbeat\('tick-complete'/,
    'A late finalized settlement must retain its tick error',
  );
});

test('server keeper restart proves the exact finalized settlement before reporting success', async () => {
  const source = await readFile(
    new URL('../scripts/server-round-keeper.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /findFinalizedRoundSettlementEvidence/);
  assert.match(source, /classifyFinalizedRoundSettlementEvidence/);
  assert.match(source, /await auditRecoveredSettlement\('already-settled-at-startup'\)/);
  assert.match(source, /await auditRecoveredSettlement\('settled-during-lock-recovery'\)/);
  assert.doesNotMatch(source, /emitRoundHeartbeat\('tick-complete', 'settled', 'already-settled'\)/);
  assert.doesNotMatch(source, /emitRoundHeartbeat\('tick-complete', 'settled', 'settled-during-recovery'\)/);
  assert.match(
    source,
    /await emitTerminalRoundHeartbeat\('tick-error', 'settlement-deadline-missed', outcome\)/,
    'Recovery must deliver the persistent deadline signal before process exit',
  );
});

test('server entropy delay fits inside the five-second winner phase', async () => {
  const source = await readFile(
    new URL('../programs/myne_protocol/src/lib.rs', import.meta.url),
    'utf8',
  );
  assert.match(source, /SERVER_ENTROPY_DELAY_SLOTS:\s*u64\s*=\s*1;/);
  assert.match(
    source,
    /clock\.unix_timestamp\s*>=\s*round\.betting_ends_at[\s\S]*clock\s*\.slot[\s\S]*checked_add\(SERVER_ENTROPY_DELAY_SLOTS\)/,
    'The next-slot target must still be locked only after betting closes',
  );
});

test('committed synchronized IDL includes every server commit-reveal instruction', async () => {
  const idl = JSON.parse(await readFile(
    new URL('../../Frontend/src/generated/myne_protocol.json', import.meta.url),
    'utf8',
  ));
  const instructions = new Set(idl.instructions.map(({ name }) => name));
  for (const name of [
    'bind_round_server_commitment',
    'lock_round_server_entropy',
    'settle_round_server',
  ]) assert.ok(instructions.has(name), `IDL is missing ${name}`);
});
