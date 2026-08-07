import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('provider keeper binds uncommitted randomness, commits after close, then reveals and settles', async () => {
  const source = await readFile(
    new URL('../scripts/switchboard-round-keeper.mjs', import.meta.url),
    'utf8',
  );

  const create = source.indexOf('sb.Randomness.create(');
  const bind = source.indexOf('[createIx, openIx, bindIx]');
  const bettingClose = source.indexOf('waitForChainTimestamp(bettingEndsAt)');
  const commit = source.indexOf('randomnessClient.commitIx(queue, keypair.publicKey)');
  const record = source.indexOf('.recordRoundRandomnessCommit(ROUND_ID)');
  const atomicCommit = source.indexOf('[commitIx, recordIx]');
  const seedWait = source.indexOf('connection.getSlot(commitment)) <= commitSlot');
  const reveal = source.indexOf('randomnessClient.revealIx(keypair.publicKey)');
  const settle = source.indexOf('.settleRoundVerified()');
  const atomicSettle = source.indexOf('[revealIx, settleIx]');

  for (const [label, index] of Object.entries({
    create, bind, bettingClose, commit, record, atomicCommit, seedWait, reveal, settle, atomicSettle,
  })) assert.ok(index >= 0, `Missing ${label} phase`);
  assert.ok(create < bind, 'Randomness must be created before it is bound');
  assert.ok(bind < bettingClose, 'The uncommitted request must be bound before betting');
  assert.ok(bettingClose < commit, 'Switchboard commit must happen only after betting closes');
  assert.ok(commit < record && record < atomicCommit, 'Commit and on-chain record ordering is invalid');
  assert.ok(atomicCommit < seedWait && seedWait < reveal, 'Reveal must wait for the recorded seed slot');
  assert.ok(reveal < settle && settle < atomicSettle, 'Reveal and settlement ordering is invalid');
  assert.doesNotMatch(source, /createAndCommitIxs/);
  assert.match(source, /executeAutoPlan[\s\S]*randomnessAccount: randomnessPubkey/);
});

test('manual and demo clients supply the deploy randomness account explicitly', async () => {
  const [lottery, capabilities, localKeeper, localTest] = await Promise.all([
    readFile(new URL('../../Frontend/src/chain/lottery.js', import.meta.url), 'utf8'),
    readFile(new URL('../../Frontend/src/chain/protocol-capabilities.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/local-keeper.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./local-protocol.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(lottery, /providerRandomness[\s\S]*roundState\?\.randomnessAccount/);
  assert.match(lottery, /\.deploy\([\s\S]*randomnessAccount, authority/);
  assert.match(capabilities, /mining: \[[^\]]*'record_round_randomness_commit'/);
  assert.match(localKeeper, /roundState\.randomnessAccount\.equals\(PublicKey\.default\)[\s\S]*\.deploy\([\s\S]*randomnessAccount,/);
  assert.match(localKeeper, /executeAutoPlan[\s\S]*randomnessAccount: null/);
  assert.match(localTest, /\.deploy\([\s\S]*randomnessAccount: null/);
  assert.match(localTest, /executeAutoPlan[\s\S]*randomnessAccount: null/);
});
