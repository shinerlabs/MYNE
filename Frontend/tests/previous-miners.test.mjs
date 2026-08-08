import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  confirmedMinerRoundKey, confirmedMinerSource, isConfirmedEmptyRound,
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

test('zero receipts make an empty settled roster authoritative', () => {
  assert.equal(isConfirmedEmptyRound(null), false);
  assert.equal(isConfirmedEmptyRound({ resolved: false, totalReceipts: 0n }), false);
  assert.equal(isConfirmedEmptyRound({ resolved: true }), false);
  assert.equal(isConfirmedEmptyRound({ resolved: true, totalReceipts: 0n }), true);
  assert.equal(isConfirmedEmptyRound({ resolved: true, totalReceipts: '0' }), true);
  assert.equal(isConfirmedEmptyRound({ resolved: true, totalReceipts: 1n }), false);
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

test('the latest settled round remains authoritative across delayed reads', () => {
  const refresh = main.slice(
    main.indexOf('const scheduleRoundMinersRefresh'),
    main.indexOf('const renderPagination'),
  );

  // Staleness is determined by the selected confirmed source changing, not by
  // a separate current-round arithmetic check.
  assert.doesNotMatch(refresh, /previousConfirmedRoundId\(chain\.state\.roundId\)/);
  assert.equal(
    refresh.match(/String\(confirmedMinerSource\(chain\.state\.lastResolved, chain\.state\.lastPlayedResolved\)\?\.roundId\) !== String\(requestedRound\)/g)?.length,
    3,
  );
});

test('the miners card keeps the latest played round while empty outcomes remain separate', () => {
  const empty = { roundId: 408n, resolved: true, totalWager: 0n, totalReceipts: 0n };
  const played = { roundId: 396n, resolved: true, totalWager: 125_000_000n, totalReceipts: 1n };
  assert.equal(confirmedMinerSource(empty, played), played);
  assert.equal(confirmedMinerSource(empty, null), empty);
  assert.equal(confirmedMinerSource(empty, { ...played, resolved: false }), empty);

  const refresh = main.slice(
    main.indexOf('const renderConfirmedMiners'),
    main.indexOf('const renderPagination'),
  );
  assert.match(refresh, /confirmedMinerSource\(state\.lastResolved, state\.lastPlayedResolved\)/);
  assert.match(refresh, /const confirmedEmpty = isConfirmedEmptyRound\(confirmed\)/);
  assert.match(refresh, /!result\.miners\.length && !confirmedEmpty/);
  assert.match(refresh, /WINNING TILE #\$\{winningSquare \+ 1\} · 0 MINERS · 0 MYNE REWARDED/);
  assert.match(refresh, /winning tile published · 0 MYNE rewarded/);
});

test('the previous-round roster includes every miner, not only winners', () => {
  const winner = { address: 'winner', won: true };
  const otherMiner = { address: 'other-miner', won: false };
  const result = { winners: [winner], miners: [winner, otherMiner] };

  assert.deepEqual(previousRoundMinerRoster(result), [winner, otherMiner]);
  assert.deepEqual(previousRoundMinerRoster({ winners: [winner] }), []);
});
