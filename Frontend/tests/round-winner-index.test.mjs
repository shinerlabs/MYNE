import assert from 'node:assert/strict';
import test from 'node:test';

import { winnerCountsFromIndexedBets } from '../src/chain/rounds-index.js';

test('indexed winner counts distinguish split tiles, motherlode participants and empty rounds', () => {
  const rounds = [
    { roundId: 10n, resolved: true, totalWager: 3n, jackpotHit: false, winningSquare: 4 },
    { roundId: 11n, resolved: true, totalWager: 3n, jackpotHit: true, winningSquare: 8 },
    { roundId: 12n, resolved: true, totalWager: 0n, jackpotHit: false, winningSquare: 2 },
  ];
  const bets = [
    { round_id: 10, bettor: 'A', square: 4 },
    { round_id: 10, bettor: 'A', square: 4 },
    { round_id: 10, bettor: 'B', square: 3 },
    { round_id: 10, bettor: 'C', square: 4 },
    { round_id: 11, bettor: 'A', square: 1 },
    { round_id: 11, bettor: 'B', square: 9 },
    { round_id: 11, bettor: 'B', square: 10 },
    { round_id: 12, bettor: 'Z', square: 2 },
  ];

  assert.deepEqual(winnerCountsFromIndexedBets(rounds, bets), new Map([
    ['10', 2n],
    ['11', 2n],
    ['12', 0n],
  ]));
});
