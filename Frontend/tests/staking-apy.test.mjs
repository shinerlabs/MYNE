import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  apyPercent,
  summariseStakingRewardWindow,
} from '../src/chain/staking-apy.js';

const context = {
  start: 1_000,
  end: 1_300,
  windowMinutes: 5,
  roundCadenceSeconds: 65,
  maxRows: 1000,
};

const completeRows = () => [
  { round_id: '10', resolved: true, settles_at: 1_005, staking_net_lamports: '100' },
  { round_id: '11', resolved: true, settles_at: 1_070, staking_net_lamports: '200' },
  { round_id: '12', resolved: true, settles_at: 1_135, staking_net_lamports: '0' },
  { round_id: '13', resolved: true, settles_at: 1_200, staking_net_lamports: '300' },
  { round_id: '14', resolved: true, settles_at: 1_265, staking_net_lamports: '400' },
];

test('annualised staking yield is unit-correct and rejects unsafe inputs', () => {
  // 100 MYNE at 10 MYNE/SOL represents 10 SOL of reward weight.
  assert.equal(apyPercent(1, 100, 10), 5_256_000);
  assert.equal(apyPercent(0, 100, 10), 0);
  assert.equal(apyPercent(Number.NaN, 100, 10), null);
  assert.equal(apyPercent(Number.POSITIVE_INFINITY, 100, 10), null);
  assert.equal(apyPercent(1, Number.POSITIVE_INFINITY, 10), null);
  assert.equal(apyPercent(1, 100, Number.POSITIVE_INFINITY), null);
  assert.equal(apyPercent(-1, 100, 10), null);
});

test('staking reward window sums exact indexed lamports only when coverage is complete', () => {
  assert.deepEqual(summariseStakingRewardWindow(completeRows(), context), {
    complete: true,
    windowMinutes: 5,
    rewardLamports: 1_000n,
    rounds: 5,
    firstSettlesAt: 1_005,
    lastSettlesAt: 1_265,
  });
});

test('staking reward window fails closed for a skipped indexed round', () => {
  const rows = completeRows();
  rows.splice(2, 1);
  const result = summariseStakingRewardWindow(rows, context);
  assert.equal(result.complete, false);
  assert.equal(result.rewardLamports, 0n);
});

test('staking reward window fails closed for unresolved or missing fee events', () => {
  const unresolved = completeRows();
  unresolved[2] = { ...unresolved[2], resolved: false };
  assert.equal(summariseStakingRewardWindow(unresolved, context).complete, false);

  const missingFee = completeRows();
  missingFee[2] = { ...missingFee[2], staking_net_lamports: null };
  assert.equal(summariseStakingRewardWindow(missingFee, context).complete, false);
});

test('staking reward window rejects stale edge coverage and malformed amounts', () => {
  const stale = completeRows().slice(1);
  assert.equal(summariseStakingRewardWindow(stale, context).complete, false);

  const malformed = completeRows();
  malformed[1] = { ...malformed[1], staking_net_lamports: '-1' };
  assert.equal(summariseStakingRewardWindow(malformed, context).complete, false);

  const blankAmount = completeRows();
  blankAmount[1] = { ...blankAmount[1], staking_net_lamports: '' };
  assert.equal(summariseStakingRewardWindow(blankAmount, context).complete, false);

  const missingId = completeRows();
  missingId[1] = { ...missingId[1], round_id: null };
  assert.equal(summariseStakingRewardWindow(missingId, context).complete, false);
});

test('staking UI does not invent lifetime claims and pool quotes expire', async () => {
  const [staking, main, price, rounds] = await Promise.all([
    readFile(new URL('../src/chain/staking.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/sol-price.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/rounds-index.js', import.meta.url), 'utf8'),
  ]);

  assert.match(staking, /claimedEth:\s*null,\s*lifetimeEth:\s*null/);
  assert.doesNotMatch(main, /TOTAL SOL EARNED|TOTAL SOL RECEIVED|Claimed \+ available/);
  assert.match(main, /CLAIMED SOL/);
  assert.match(main, /History not indexed/);
  assert.match(main, /earned:\s*chain\.format\.ethSmart\(state\?\.pendingEth/);
  assert.match(main, /const dailyPool = metrics\?\.aprWindowDays > 0 \? metrics\.rewardsToStakersEth : 0/);
  assert.doesNotMatch(main, /rewardsToStakersEth \/ metrics\.aprWindowDays/);
  assert.match(main, /dailyPool \* \(weight \/ metrics\.totalWeight\)/);
  assert.doesNotMatch(main, /dailyPool \* \(\(state\?\.share/);
  assert.match(main, /const marketMyneUsd = getLiveMynePerSol\(\) != null/);
  assert.doesNotMatch(main, /const marketMyneUsd = poolAvailable \?/);

  assert.match(price, /LIVE_MYNE_QUOTE_MAX_AGE_MS/);
  assert.match(price, /getLiveMynePerSol = \(now = Date\.now\(\)\)/);
  assert.match(price, /const currentMyneUsd = getMyneUsd\(\)/);
  assert.doesNotMatch(price, /if \(myneUsd != null && Number\.isFinite\(myneAmount\)\)/);
  assert.match(rounds, /select\('round_id,resolved,settles_at,staking_net_lamports::text'\)/);
  assert.match(rounds, /nowSeconds = Number\(chainNowSeconds\(\)\)/);
  assert.doesNotMatch(rounds, /\.not\('staking_net_lamports',\s*'is',\s*null\)/);
});
