import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';

import {
  commitmentHexFromAccount,
  decodeServerRandomnessSlot,
  describeRandomnessRound,
  isServerRandomnessProgram,
  SERVER_RANDOMNESS_PENDING,
  SERVER_RANDOMNESS_SLOT_FLAG,
} from '../src/chain/randomness-mode.js';
import { deriveServerEntropyProof } from '../src/chain/randomness-proof.js';

const u64le = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};

test('server round tags distinguish pending, locked and legacy Switchboard rounds', () => {
  assert.deepEqual(describeRandomnessRound({ commitSlot: SERVER_RANDOMNESS_PENDING }), {
    mode: 'server', state: 'commitment-bound', encodedSlot: SERVER_RANDOMNESS_PENDING, slot: null,
  });
  const encoded = SERVER_RANDOMNESS_SLOT_FLAG | 123_456n;
  assert.equal(decodeServerRandomnessSlot(encoded), 123_456n);
  assert.equal(describeRandomnessRound({ commitSlot: encoded }).state, 'entropy-locked');
  assert.equal(describeRandomnessRound({ commitSlot: encoded, resolved: true }).state, 'settled');
  assert.equal(describeRandomnessRound({ commitSlot: 42n, resolved: true }).mode, 'switchboard');
});

test('server commitment bytes remain data and hashes mirror the protocol domains', async () => {
  const programId = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
  const mint = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
  const reveal = Uint8Array.from({ length: 32 }, (_, index) => index * 3);
  const slotHash = Uint8Array.from({ length: 32 }, (_, index) => index * 7 % 256);
  const roundId = 77n;
  const entropySlot = 987_654n;
  const hash = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((part) => Buffer.from(part)))).digest('hex');
  const commitment = hash(
    Buffer.from('MYNE_SERVER_COMMIT_V1'), programId.toBytes(), mint.toBytes(), u64le(roundId), reveal,
  );
  const output = hash(
    Buffer.from('MYNE_SERVER_OUTPUT_V1'), programId.toBytes(), mint.toBytes(), u64le(roundId), reveal,
    u64le(entropySlot), slotHash,
  );
  const proof = await deriveServerEntropyProof({
    programId, mint, roundId, reveal, entropySlot, slotHash, commitment, randomness: output,
  });
  assert.equal(proof.commitmentMatches, true);
  assert.equal(proof.randomnessMatches, true);
  assert.equal(commitmentHexFromAccount(new PublicKey(Buffer.from(commitment, 'hex'))), commitment);
  assert.equal(isServerRandomnessProgram(programId, programId), true);
});

test('server deploy omits the optional account and proof UI never Explorer-links commitment data', async () => {
  const [lottery, main] = await Promise.all([
    readFile(new URL('../src/chain/lottery.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);
  const serverBranch = lottery.slice(
    lottery.indexOf("if (randomnessMeta.mode === 'server')"),
    lottery.indexOf('} else if (hasBoundRandomness)', lottery.indexOf("if (randomnessMeta.mode === 'server')")),
  );
  assert.match(serverBranch, /randomnessAccount = null/);
  assert.match(main, /The commitment is data, not a Solana account/);
  assert.match(main, /<dt>Commitment<\/dt><dd>\$\{proofHash\(commitment\)\}<\/dd>/);
  assert.match(main, /randomnessAccount \? `<a href="\$\{explorerAddress\(randomnessAccount\)\}/);
  assert.doesNotMatch(main, /explorerAddress\(commitment\)/);
});
