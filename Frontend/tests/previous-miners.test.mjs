import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  confirmedMinerRoundKey,
  previousConfirmedRoundId,
  previousRoundMinerRoster,
  shouldRefreshConfirmedMiners,
} from '../src/chain/previous-miners.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('the numeric previous-round helper handles the first and later rounds', () => {
  assert.equal(previousConfirmedRoundId(0n), null);
  assert.equal(previousConfirmedRoundId(1n), 0n);
  assert.equal(previousConfirmedRoundId(42n), 41n);
});

test('only a settled previous round can replace the confirmed miners panel', () => {
  assert.equal(confirmedMinerRoundKey(null), null);
  assert.equal(confirmedMinerRoundKey({ roundId: 8n, resolved: false }), null);
  assert.equal(confirmedMinerRoundKey({ roundId: 8n, resolved: true }), '8');
});

test('the same confirmed miner roster remains stable while the live round changes', () => {
  const previous = { roundId: 8n, resolved: true };
  assert.equal(shouldRefreshConfirmedMiners(previous, '', ''), true);
  assert.equal(shouldRefreshConfirmedMiners(previous, '8', ''), false);
  assert.equal(shouldRefreshConfirmedMiners(previous, '', '8'), false);

  // Live-round fields are intentionally ignored. Only a newer settled result may replace it.
  assert.equal(shouldRefreshConfirmedMiners({ ...previous, liveRoundId: 99n, totalWager: 1_000_000_000n }, '8', ''), false);
  assert.equal(shouldRefreshConfirmedMiners({ roundId: 9n, resolved: true }, '8', ''), true);
});

test('the latest played round remains eligible across empty numeric rounds', () => {
  const refresh = main.slice(
    main.indexOf('const scheduleRoundMinersRefresh'),
    main.indexOf('const renderPagination'),
  );

  // A played round such as 341 can still be the authoritative latest result when the live clock
  // has advanced through empty rounds. Staleness is determined by lastResolved changing, not by
  // requiring the result id to equal currentRound - 1.
  assert.doesNotMatch(refresh, /previousConfirmedRoundId\(chain\.state\.roundId\)/);
  assert.equal(
    refresh.match(/String\(chain\.state\.lastResolved\?\.roundId\) !== String\(requestedRound\)/g)?.length,
    3,
  );
});

test('the previous-round roster includes every miner, not only winners', () => {
  const winner = { address: 'winner', won: true };
  const otherMiner = { address: 'other-miner', won: false };
  const result = { winners: [winner], miners: [winner, otherMiner] };

  assert.deepEqual(previousRoundMinerRoster(result), [winner, otherMiner]);
  assert.deepEqual(previousRoundMinerRoster({ winners: [winner] }), []);
});
