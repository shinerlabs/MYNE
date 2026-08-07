import assert from 'node:assert/strict';
import test from 'node:test';

import { demoCoverageBidLamports, demoCoverageBids } from '../scripts/demo-miner-bids.mjs';

test('five local coverage miners commit exactly the same amount to every winning tile', () => {
  const roundId = 13n;
  const cohorts = Array.from({ length: 5 }, (_, index) => demoCoverageBids(roundId, index, false));

  for (let tile = 0; tile < 25; tile += 1) {
    const stakes = cohorts.map((bids) => bids[tile]);
    assert.equal(new Set(stakes).size, 1, `tile ${tile + 1} must have equal cohort bids`);
  }

  const stake = BigInt(cohorts[0][20]);
  const prize = 1_100_000_000n;
  const winningTotal = stake * 5n;
  const rewards = cohorts.map((bids) => (prize * BigInt(bids[20])) / winningTotal);
  assert.deepEqual(rewards, Array(5).fill(220_000_000n));
});

test('coverage amount is restart-safe and remains within the intended 10x-20x range', () => {
  for (let roundId = 0n; roundId < 50n; roundId += 1n) {
    const first = demoCoverageBidLamports(roundId);
    assert.equal(first, demoCoverageBidLamports(roundId));
    assert.ok(first >= 10_000_000 && first <= 20_000_000);
  }
});

test('Devnet coverage miners partition all 25 tiles without changing the shared amount', () => {
  const cohorts = Array.from({ length: 5 }, (_, index) => demoCoverageBids(7n, index, true));
  const entries = cohorts.flatMap((bids) => Object.entries(bids));
  assert.equal(entries.length, 25);
  assert.equal(new Set(entries.map(([tile]) => tile)).size, 25);
  assert.equal(new Set(entries.map(([, amount]) => amount)).size, 1);
});
