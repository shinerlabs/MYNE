import assert from 'node:assert/strict';
import test from 'node:test';

import { displayedMotherlodeSol, settledSolReward, sharedRoundReward } from '../src/chain/round-rewards.js';

test('winning miners share the settled 88% SOL prize pool by winning-tile stake', () => {
  const grossRound = 1_000_000_000n;
  const settledPrize = grossRound * 8_800n / 10_000n;

  assert.equal(settledPrize, 880_000_000n);
  assert.equal(settledSolReward(settledPrize, 25_000_000n, 100_000_000n), 220_000_000n);
  assert.equal(settledSolReward(settledPrize, 75_000_000n, 100_000_000n), 660_000_000n);
  assert.equal(settledSolReward(settledPrize, 0n, 100_000_000n), 0n);
});

test('Motherlode displays exactly 1% of total deployed mining while a round is open', () => {
  assert.equal(displayedMotherlodeSol(10_000_000n, 440_000_000n, false), 14_400_000n);
  assert.equal(displayedMotherlodeSol(10_000_000n, 440_000_099n, false), 14_400_000n);
  assert.equal(displayedMotherlodeSol(14_400_000n, 440_000_000n, true), 14_400_000n);
});

test('Motherlode payout is shared by total round deployment, not the winning tile', () => {
  assert.equal(sharedRoundReward(650_000_000n, 100_000_000n, 1_000_000_000n), 65_000_000n);
  assert.equal(sharedRoundReward(650_000_000n, 900_000_000n, 1_000_000_000n), 585_000_000n);
  assert.equal(sharedRoundReward(650_000_000n, 100_000_000n, 0n), 0n);
});
