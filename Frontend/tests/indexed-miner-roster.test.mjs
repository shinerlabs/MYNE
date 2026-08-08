import assert from 'node:assert/strict';
import test from 'node:test';

import { indexedMinerRoster } from '../src/chain/rounds-index.js';

test('indexed roster includes every miner and preserves interval reward arithmetic', () => {
  const round = {
    roundId: 50n,
    resolved: true,
    winningSquare: 4,
    jackpotHit: false,
    singleMinerRound: false,
    singleMinerWinner: '11111111111111111111111111111111',
    totalWager: 100n,
    winnerTotal: 50n,
    potForWinners: 88n,
    bullionForWinners: 1_000n,
  };
  const rows = [
    { receipt: 'r1', bettor: 'A', square: 4, amount_wei: '20', cumulative_start_wei: '0', reward_mode: 0 },
    { receipt: 'r1', bettor: 'A', square: 2, amount_wei: '10', cumulative_start_wei: '0', reward_mode: 0 },
    { receipt: 'r2', bettor: 'B', square: 4, amount_wei: '30', cumulative_start_wei: '20', reward_mode: 1 },
    { receipt: 'r3', bettor: 'C', square: 1, amount_wei: '40', cumulative_start_wei: '0', reward_mode: 0 },
  ];

  const result = indexedMinerRoster(round, rows);
  assert.deepEqual(result.miners.map(({ address }) => address), ['C', 'A', 'B']);
  assert.deepEqual(result.winners.map(({ address }) => address), ['A', 'B']);
  const a = result.miners.find(({ address }) => address === 'A');
  const b = result.miners.find(({ address }) => address === 'B');
  const c = result.miners.find(({ address }) => address === 'C');
  assert.equal(a.deployed, 30n);
  assert.equal(a.winningStake, 20n);
  assert.equal(a.eth, 35n);
  assert.equal(a.bullion, 400n);
  assert.equal(b.eth, 53n);
  assert.equal(b.bullion, 600n);
  assert.equal(b.autoBurn, true);
  assert.equal(c.won, false);
  assert.equal(c.eth, 0n);
  assert.equal(result.miners.every(({ amountKnown }) => amountKnown), true);
});

test('indexed Motherlode roster is complete but does not fabricate unavailable reward totals', () => {
  const result = indexedMinerRoster({
    roundId: 51n,
    resolved: true,
    winningSquare: 0,
    jackpotHit: true,
    singleMinerRound: false,
    singleMinerWinner: '11111111111111111111111111111111',
    totalWager: 10n,
    winnerTotal: 0n,
    potForWinners: 0n,
    bullionForWinners: 0n,
  }, [{
    receipt: 'r4', bettor: 'D', square: 7, amount_wei: '10', cumulative_start_wei: '0', reward_mode: 0,
  }]);
  assert.equal(result.miners.length, 1);
  assert.equal(result.miners[0].won, true);
  assert.equal(result.miners[0].amountKnown, false);
});
