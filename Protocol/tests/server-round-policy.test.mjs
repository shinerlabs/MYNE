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

test('server keeper binds before start, preserves the future-slot mix, and settles empty rounds', async () => {
  const source = await readFile(
    new URL('../scripts/server-round-keeper.mjs', import.meta.url),
    'utf8',
  );
  const persist = source.indexOf('const reveal = await loadOrCreateServerReveal');
  const open = source.indexOf('.openRound(ROUND_ID_BN)');
  const bind = source.indexOf('.bindRoundServerCommitment(ROUND_ID_BN');
  const atomicBind = source.indexOf('sendKeeperInstructions([openIx, bindIx])');
  const bettingStart = source.indexOf('waitForChainTimestamp(openedAt)');
  const auto = source.indexOf('.executeAutoPlan(ROUND_ID_BN');
  const bettingClose = source.indexOf('waitForChainTimestamp(bettingEndsAt)');
  const lock = source.indexOf('.lockRoundServerEntropy(ROUND_ID_BN)');
  const futureSlot = source.indexOf('connection.getSlot(commitment)) <= targetSlot + 1n');
  const settle = source.indexOf('.settleRoundServer(Array.from(reveal))');

  for (const [label, index] of Object.entries({
    persist, open, bind, atomicBind, bettingStart, auto, bettingClose, lock, futureSlot, settle,
  })) assert.ok(index >= 0, `Missing ${label} phase`);
  assert.ok(persist < open && open < bind && bind < atomicBind, 'Commitment was not durably bound atomically');
  assert.ok(atomicBind < bettingStart && bettingStart < auto, 'Auto plans must wait for scheduled opened_at');
  assert.ok(auto < bettingClose && bettingClose < lock, 'Entropy must be locked only after betting closes');
  assert.ok(lock < futureSlot && futureSlot < settle, 'Reveal must mix a future SlotHashes entry');
  assert.match(source, /slotHashes: SYSVAR_SLOT_HASHES_PUBKEY/);
  assert.match(source, /replaceRecentBlockhash:\s*true/);
  assert.match(source, /reason: 'protocol-paused'[\s\S]*ROUND_KEEPER_DEFERRED_EXIT_CODE/);
  assert.match(source, /scheduledOpenedAt[\s\S]*ROUND_KEEPER_MISSED_EXIT_CODE/);
  assert.doesNotMatch(source, /roundState\.(?:totalReceipts|grossDeployedLamports)\s*[!<>=]/);
  assert.doesNotMatch(source, /@switchboard-xyz/);
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

test('generated keeper IDL includes every server commit-reveal instruction', async () => {
  const idl = JSON.parse(await readFile(
    new URL('../target/idl/myne_protocol.json', import.meta.url),
    'utf8',
  ));
  const instructions = new Set(idl.instructions.map(({ name }) => name));
  for (const name of [
    'bind_round_server_commitment',
    'lock_round_server_entropy',
    'settle_round_server',
  ]) assert.ok(instructions.has(name), `IDL is missing ${name}`);
});
