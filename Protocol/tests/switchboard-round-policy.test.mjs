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
  const record = source.indexOf('.recordRoundRandomnessCommit(ROUND_ID_BN)');
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
  assert.match(source, /replaceRecentBlockhash:\s*true/);
  assert.match(source, /blockhashCommitment\s*=\s*'finalized'/);
});

test('Switchboard keeper converts the native round id to BN at every Anchor u64 boundary', async () => {
  const source = await readFile(
    new URL('../scripts/switchboard-round-keeper.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /const ROUND_ID_BN = new anchor\.BN\(ROUND_ID\.toString\(\)\)/);
  assert.match(source, /\.openRound\(ROUND_ID_BN\)/);
  assert.match(source, /\.bindRoundRandomness\(ROUND_ID_BN\)/);
  assert.match(source, /\.executeAutoPlan\(ROUND_ID_BN, new anchor\.BN\(nonce\.toString\(\)\)\)/);
  assert.match(source, /\.recordRoundRandomnessCommit\(ROUND_ID_BN\)/);
  assert.doesNotMatch(source, /\.methods\.(?:openRound|bindRoundRandomness|executeAutoPlan|recordRoundRandomnessCommit)\(ROUND_ID(?:,|\))/);
});

test('Switchboard keeper owns compute-budget construction without SDK duplicates', async () => {
  const source = await readFile(
    new URL('../scripts/switchboard-round-keeper.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /new TransactionMessage\(\{[\s\S]*ComputeBudgetProgram\.setComputeUnitLimit/);
  assert.match(source, /new VersionedTransaction\(message\)/);
  assert.match(source, /confirmTransaction\(\{[\s\S]*lastValidBlockHeight/);
  assert.doesNotMatch(source, /sb\.asV0Tx/);
});

test('Switchboard keeper tolerates confirmed-state RPC propagation lag', async () => {
  const source = await readFile(
    new URL('../scripts/switchboard-round-keeper.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /const fetchRoundWithRetry = async \(predicate, label\)/);
  assert.match(source, /Round creation and randomness binding/);
  assert.match(source, /Randomness commitment recording/);
  assert.match(source, /Verified round settlement/);
  assert.match(source, /Math\.min\(4_000, 250 \* \(2 \*\* attempt\)\)/);
  assert.match(source, /connection\.getSlot\('finalized'\)/);
  assert.match(source, /offset < 32/);
  assert.match(source, /Number\(error\?\.code\) !== -32004/);
  assert.match(source, /Finalized chain time is temporarily unavailable/);
});

test('Switchboard keeper resumes the oldest indexed open round before scheduling another', async () => {
  const source = await readFile(
    new URL('../scripts/switchboard-round-keeper.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /mine_rounds\?resolved=eq\.false&closed_signature=is\.null&opened_at=not\.is\.null&select=round_id&order=round_id\.asc&limit=2/);
  assert.match(source, /const ROUND_ID = BigInt\(explicitRoundId \|\| resumableRounds\[0\]\?\.round_id \|\| scheduledRound\)/);
  assert.match(source, /if \(resumedFromIndex\) \{[\s\S]*round-index-ahead-of-rpc[\s\S]*process\.exit\(0\)/);
  assert.match(source, /round-expired-awaiting-lifecycle/);
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
