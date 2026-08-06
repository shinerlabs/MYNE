import assert from 'node:assert/strict';
import test from 'node:test';

import {
  confirmedMinerRoundKey,
  previousRoundMinerRoster,
  shouldRefreshConfirmedMiners,
} from '../src/chain/previous-miners.js';

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

test('the previous-round roster includes every miner, not only winners', () => {
  const winner = { address: 'winner', won: true };
  const otherMiner = { address: 'other-miner', won: false };
  const result = { winners: [winner], miners: [winner, otherMiner] };

  assert.deepEqual(previousRoundMinerRoster(result), [winner, otherMiner]);
  assert.deepEqual(previousRoundMinerRoster({ winners: [winner] }), []);
});
