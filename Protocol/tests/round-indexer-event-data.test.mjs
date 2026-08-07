import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeAnchorEventData,
  normalizeAnchorEventName,
} from '../scripts/anchor-event-data.mjs';

test('normalizes Anchor 1.0 snake_case event fields at the index boundary', () => {
  const decoded = normalizeAnchorEventData({
    round_id: 206n,
    rent_payer: 'payer',
    betting_ends_at: 123n,
    randomness_account: 'randomness',
  });
  assert.equal(decoded.roundId, 206n);
  assert.equal(decoded.rentPayer, 'payer');
  assert.equal(decoded.bettingEndsAt, 123n);
  assert.equal(decoded.randomnessAccount, 'randomness');
  assert.equal(decoded.round_id, 206n);
});

test('normalizes Program coder lower-camel event names to projection names', () => {
  assert.equal(normalizeAnchorEventName('roundOpened'), 'RoundOpened');
  assert.equal(normalizeAnchorEventName('claimFeeRoutedV2'), 'ClaimFeeRoutedV2');
  assert.equal(normalizeAnchorEventName('RoundSettled'), 'RoundSettled');
});

test('production indexer replays finalized signatures without moving the cursor', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  assert.match(source, /--replay-signature=/);
  assert.match(source, /processEvent\(event, signature, transaction\.slot\)/);
  const replayBody = source.slice(
    source.indexOf('async function replayTransactions'),
    source.indexOf('async function signaturesSince'),
  );
  assert.doesNotMatch(replayBody, /mine_indexer_state|newest_signature/);
});

test('production indexer acquires an atomic lease before each tick', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  assert.match(source, /acquire_mine_keeper_lease/);
  assert.match(source, /round-indexer-lease-held-by-another-instance/);
  assert.match(source, /if \(!\(await acquireIndexerLease\(\)\)\)/);
});

test('observing RoundArchived never downgrades canonical archive verification', async () => {
  const source = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  const archivedCase = source.slice(
    source.indexOf("case 'RoundArchived'"),
    source.indexOf("case 'RoundClosed'"),
  );
  assert.match(archivedCase, /archive_hash:/);
  assert.doesNotMatch(archivedCase, /archive_verified:\s*false/);
});
