import assert from 'node:assert/strict';
import test from 'node:test';

import {
  displayedMotherlodeSol, intervalReward, motherlodeSolEquivalent, settledSolReward,
  sharedRoundReward, winningTileShareBps,
} from '../src/chain/round-rewards.js';

test('winning miners share the settled 88% SOL prize pool by winning-tile stake', () => {
  const grossRound = 1_000_000_000n;
  const settledPrize = grossRound * 8_800n / 10_000n;

  assert.equal(settledPrize, 880_000_000n);
  assert.equal(settledSolReward(settledPrize, 25_000_000n, 100_000_000n), 220_000_000n);
  assert.equal(settledSolReward(settledPrize, 75_000_000n, 100_000_000n), 660_000_000n);
  assert.equal(settledSolReward(settledPrize, 0n, 100_000_000n), 0n);
});

test('a 90% winning-tile contribution receives exactly 90% of SOL', () => {
  const prize = 880_000_000n;
  const winningTileTotal = 1_000_000_000n;
  assert.equal(settledSolReward(prize, 900_000_000n, winningTileTotal), 792_000_000n);
  assert.equal(settledSolReward(prize, 100_000_000n, winningTileTotal), 88_000_000n);
});

test('five equal winning-tile bids receive five equal SOL rewards', () => {
  const prize = 1_100_000_000n;
  const stake = 15_000_000n;
  const winningTileTotal = stake * 5n;
  const rewards = Array.from({ length: 5 }, () => settledSolReward(prize, stake, winningTileTotal));

  assert.deepEqual(rewards, Array(5).fill(220_000_000n));
  assert.equal(winningTileShareBps(stake, winningTileTotal), 2_000n);
  assert.equal(rewards.reduce((sum, value) => sum + value, 0n), prize);
});

test('losing-tile deployments remain in the prize pool', () => {
  const gross = 2_000_000_000n;
  const prize = gross * 8_800n / 10_000n; // all deployments less the 12% fee
  const winningTileTotal = 100_000_000n;
  assert.equal(prize, 1_760_000_000n);
  assert.equal(settledSolReward(prize, 20_000_000n, winningTileTotal), 352_000_000n);
  assert.equal(settledSolReward(prize, 80_000_000n, winningTileTotal), 1_408_000_000n);
});

test('five-miner round pays only the two winning miners pro rata', () => {
  const prize = 1_760_000_000n;
  const winningTileTotal = 100_000_000n;
  const miners = [0n, 0n, 0n, 30_000_000n, 70_000_000n];
  const rewards = miners.map((stake) => settledSolReward(prize, stake, winningTileTotal));
  assert.deepEqual(rewards, [0n, 0n, 0n, 528_000_000n, 1_232_000_000n]);
  assert.equal(rewards.reduce((sum, value) => sum + value, 0n), prize);
});

test('cumulative intervals assign every integer unit without reward dust', () => {
  const shares = [
    intervalReward(11n, 0n, 1n, 3n),
    intervalReward(11n, 1n, 1n, 3n),
    intervalReward(11n, 2n, 1n, 3n),
  ];
  assert.deepEqual(shares, [3n, 4n, 4n]);
  assert.equal(shares.reduce((sum, value) => sum + value, 0n), 11n);
});

test('Motherlode displays exactly 2% of total deployed mining while a round is open', () => {
  assert.equal(displayedMotherlodeSol(10_000_000n, 440_000_000n, false), 18_800_000n);
  assert.equal(displayedMotherlodeSol(10_000_000n, 440_000_099n, false), 18_800_001n);
  assert.equal(displayedMotherlodeSol(18_800_000n, 440_000_000n, true), 18_800_000n);
});

test('Motherlode market value includes both its SOL and burn-staked MYNE legs', () => {
  assert.equal(motherlodeSolEquivalent(2, 40, 20), 4);
  assert.equal(motherlodeSolEquivalent(2, 0, null), 2);
  assert.equal(motherlodeSolEquivalent(2, 40, null), null);
  assert.equal(motherlodeSolEquivalent(2, 40, 0), null);
  assert.equal(motherlodeSolEquivalent(-1, 40, 20), null);
});

test('Motherlode payout is shared by total round deployment, not the winning tile', () => {
  assert.equal(sharedRoundReward(650_000_000n, 100_000_000n, 1_000_000_000n), 65_000_000n);
  assert.equal(sharedRoundReward(650_000_000n, 900_000_000n, 1_000_000_000n), 585_000_000n);
  assert.equal(sharedRoundReward(650_000_000n, 100_000_000n, 0n), 0n);
});
