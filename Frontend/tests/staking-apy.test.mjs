import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  apyPercent,
  formatApyPercent,
  positionApyPercent,
  positionRewardEstimate,
  selectLatestCompleteStakingRewardWindow,
  selectPausedApySnapshot,
  stakingApyVariants,
  stakingApySnapshot,
  summariseStakingRewardWindow,
} from '../src/chain/staking-apy.js';

const context = {
  start: 965,
  end: 1_265,
  windowMinutes: 5,
  roundCadenceSeconds: 65,
  maxRows: 1000,
  observedAt: 1_300,
  watermarkSettlesAt: 1_265,
  maxStalenessSeconds: 195,
  maxSettlementGapSeconds: 70,
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

test('all APY surfaces share one formatter and explicit tier/position variants', () => {
  assert.equal(formatApyPercent(12.34), '12.3%');
  assert.equal(formatApyPercent(1_234), '1,234%');
  assert.equal(formatApyPercent(1_200), '1,200%');
  assert.equal(formatApyPercent(100_000), '100,000%');
  assert.equal(formatApyPercent(100_000, { compact: true }), '100,000%');
  assert.equal(formatApyPercent(100_000.01), '100,000%+');
  assert.equal(formatApyPercent(30_000_000, { compact: true }), '100,000%+');
  assert.equal(formatApyPercent(null), '—');
  assert.deepEqual(stakingApyVariants(12), { standard: 12, burn: 60 });
  assert.deepEqual(stakingApyVariants(null), { standard: null, burn: null });
  assert.equal(positionApyPercent(12, 10, 30), 36);
  assert.equal(positionApyPercent(12, 0, 0), null);
});

test('weekly position estimate uses exact weighted pool share and validated APY', () => {
  const estimate = positionRewardEstimate({
    standardApyPct: 12,
    principalMyne: 10,
    weightMyne: 30,
    totalWeightMyne: 300,
    poolRewardsPerDaySol: 2,
    days: 7,
  });
  assert.equal(estimate.days, 7);
  assert.ok(Math.abs(estimate.rewardSol - 1.4) < Number.EPSILON * 2);
  assert.equal(estimate.poolSharePct, 10);
  assert.equal(estimate.positionApyPct, 36);
  assert.equal(estimate.source, 'pool');
  const fallback = positionRewardEstimate({
    standardApyPct: 12,
    principalMyne: 10,
    weightMyne: 30,
    totalWeightMyne: 300,
    poolRewardsPerDaySol: null,
    mynePerSol: 10,
    days: 7,
  });
  assert.ok(Math.abs(fallback.rewardSol - ((1 * .36 * 7) / 365)) < Number.EPSILON);
  assert.equal(fallback.poolSharePct, 10);
  assert.equal(fallback.positionApyPct, 36);
  assert.equal(fallback.source, 'apy');
  assert.equal(positionRewardEstimate({
    standardApyPct: null, principalMyne: 10, weightMyne: 10,
    totalWeightMyne: 100, poolRewardsPerDaySol: 2,
  }), null);
  assert.equal(positionRewardEstimate({
    standardApyPct: 12, principalMyne: 10, weightMyne: 110,
    totalWeightMyne: 100, poolRewardsPerDaySol: 2,
  }), null);
  assert.equal(positionRewardEstimate({
    standardApyPct: 12, principalMyne: 10, weightMyne: 10,
    totalWeightMyne: 100, poolRewardsPerDaySol: -1, mynePerSol: null,
  }), null);
});

test('a protocol pause retains one validated APY snapshot', () => {
  const snapshot = stakingApySnapshot({
    apyStandardPct: 12.5,
    apyBurnPct: 62.5,
    aprWindowDays: 30 / 1440,
    aprWindowRounds: 27,
    aprAsOf: 1_700_000_000,
    totalWeight: 240,
    rewardsToStakersEth: 1.25,
    mynePerSol: 12,
  }, 1_700_000_100);
  assert.deepEqual(snapshot, {
    apyStandardPct: 12.5,
    apyBurnPct: 62.5,
    aprWindowDays: 30 / 1440,
    aprWindowRounds: 27,
    aprAsOf: 1_700_000_000,
    capturedAt: 1_700_000_100,
    totalWeight: 240,
    rewardsToStakersEth: 1.25,
    mynePerSol: 12,
  });
  assert.equal(stakingApySnapshot({ apyStandardPct: null, apyBurnPct: null }), null);

  const paused = { ...snapshot, protocolPaused: true, apyStandardPct: 9, apyBurnPct: 45 };
  assert.deepEqual(selectPausedApySnapshot(paused, snapshot), snapshot);
  assert.deepEqual(selectPausedApySnapshot({
    protocolPaused: true,
    apyStandardPct: null,
    apyBurnPct: null,
    aprStatus: 'window',
  }, snapshot), snapshot);
  assert.equal(selectPausedApySnapshot({ ...paused, protocolPaused: false }, snapshot), null);
  assert.equal(
    selectPausedApySnapshot({ ...paused, aprAsOf: snapshot.aprAsOf + 65 }, snapshot)?.apyStandardPct,
    9,
  );
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

test('paused APY uses the newest earlier fully verified window across an index gap', () => {
  const olderComplete = completeRows();
  const brokenLatest = [
    { round_id: '40', resolved: true, settles_at: 1_330, staking_net_lamports: '900' },
    { round_id: '41', resolved: true, settles_at: 1_395, staking_net_lamports: '0' },
  ];
  const selected = selectLatestCompleteStakingRewardWindow(
    [...olderComplete, ...brokenLatest],
    {
      windowMinutes: 5,
      roundCadenceSeconds: 65,
      observedAt: 1_500,
      maxRows: 1000,
    },
  );
  assert.deepEqual(selected, {
    complete: true,
    windowMinutes: 5,
    rewardLamports: 1_000n,
    rounds: 5,
    firstSettlesAt: 1_005,
    lastSettlesAt: 1_265,
  });
});

test('staking reward window rejects a missing scheduled id even when timestamps look continuous', () => {
  const rows = completeRows();
  rows[2] = { ...rows[2], round_id: '13' };
  rows[3] = { ...rows[3], round_id: '14' };
  rows[4] = { ...rows[4], round_id: '15' };
  const result = summariseStakingRewardWindow(rows, context);
  assert.equal(result.complete, false);
  assert.equal(result.rewardLamports, 0n);
});

test('staking reward window fails closed when a scheduled fee row is missing', () => {
  const rows = completeRows();
  rows.splice(2, 1);
  const result = summariseStakingRewardWindow(rows, context);
  assert.equal(result.complete, false);
  assert.equal(result.rewardLamports, 0n);
});

test('staking reward window rejects duplicate/out-of-order ids and a stale watermark', () => {
  const duplicate = completeRows();
  duplicate[2] = { ...duplicate[2], round_id: duplicate[1].round_id };
  assert.equal(summariseStakingRewardWindow(duplicate, context).complete, false);

  const stale = { ...context, observedAt: 1_500 };
  assert.equal(summariseStakingRewardWindow(completeRows(), stale).complete, false);
});

test('staking reward window fails closed for unresolved or missing fee events', () => {
  const unresolved = completeRows();
  unresolved[2] = { ...unresolved[2], resolved: false };
  assert.equal(summariseStakingRewardWindow(unresolved, context).complete, false);

  const missingFee = completeRows();
  missingFee[2] = { ...missingFee[2], staking_net_lamports: null };
  assert.equal(summariseStakingRewardWindow(missingFee, context).complete, false);
});

test('staking reward window rejects a missing watermark row and malformed amounts', () => {
  const missingWatermark = completeRows().slice(0, -1);
  assert.equal(summariseStakingRewardWindow(missingWatermark, context).complete, false);

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
  assert.match(staking, /const \[pool, config\] = await Promise\.all/);
  assert.match(staking, /allowStale: protocolPaused/);
  assert.doesNotMatch(main, /TOTAL SOL EARNED|TOTAL SOL RECEIVED|Claimed \+ available/);
  assert.match(main, /CLAIMED SOL/);
  assert.match(main, /History not indexed/);
  assert.match(main, /EST\. WEEKLY/);
  assert.match(main, /EST\. ANNUAL/);
  assert.match(main, /EST\. WEEKLY SOL/);
  assert.match(main, /class="stake-estimate-card" tabindex="0" aria-describedby="stake-estimated-weekly-usd"/);
  assert.match(main, /class="stake-estimate-usd" id="stake-estimated-weekly-usd" role="tooltip"/);
  assert.doesNotMatch(main, /<em id="stake-estimated-weekly-usd">≈ \$—<\/em>/);
  assert.match(main, /positionRewardEstimate\(\{/);
  assert.match(main, /days:\s*7/);
  assert.match(main, /const dailyPool = metrics\?\.aprWindowDays > 0 \? metrics\.rewardsToStakersEth : null/);
  assert.match(main, /poolSharePct:\s*estimate\?\.poolSharePct/);
  assert.match(main, /setMetric\('#header-staking-apr', headerAprText\)/);
  assert.match(main, /<span>BURN APY<\/span><b id="header-staking-apr">/);
  assert.match(main, /const headerAprText = m\.apyBurnPct == null[\s\S]*formatApyPercent\(m\.apyBurnPct\)/);
  assert.match(main, /#header-staking-apr', formatApyPercent\(snapshot\.apyBurnPct\)/);
  assert.doesNotMatch(main, /estimated standard APY/);
  assert.doesNotMatch(main, /formatApyPercent\([^\n]+compact: true/);
  assert.match(main, /setMetric\('#stake-burn-apy', formatApyPercent\(m\.apyBurnPct\)\)/);
  assert.match(main, /add\('staking\.apy', staking\.apyStandardPct, formatApyPercent\(staking\.apyStandardPct\)\)/);
  assert.doesNotMatch(main, /m\.aprPct \* 5/);
  assert.doesNotMatch(main, /const projectionRates/);
  assert.match(main, /stakingMetricsState = null;[\s\S]*#header-staking-apr[\s\S]*updateStakeFlexCard\(\)/);
  assert.match(main, /requestId !== stakingMetricsRefreshId/);
  assert.match(main, /const paused = current\.protocolPaused === true/);
  assert.match(main, /PAUSED SNAPSHOT · LAST VERIFIED 30M/);
  assert.match(main, /LATEST VERIFIED 30M · HISTORICAL/);
  assert.match(main, /aprFallback: !paused/);
  assert.match(main, /selectPausedApySnapshot\(current, previousApy\)/);
  assert.match(main, /ctx\.fillText\('POSITION APY'/);
  assert.match(main, /if \(data\.apy == null\) return null/);
  assert.doesNotMatch(main, /rewardsToStakersEth \/ metrics\.aprWindowDays/);
  assert.match(main, /const weekly = estimate\?\.rewardSol \?\? null/);
  assert.match(main, /const annual = weekly == null \? null : weekly \* \(365 \/ 7\)/);
  assert.doesNotMatch(main, /dailyPool \* \(\(state\?\.share/);
  assert.match(main, /const marketMyneUsd = getLiveMynePerSol\(\) != null/);
  assert.doesNotMatch(main, /const marketMyneUsd = poolAvailable \?/);

  assert.match(price, /LIVE_MYNE_QUOTE_MAX_AGE_MS/);
  assert.match(price, /getLiveMynePerSol = \(now = Date\.now\(\)\)/);
  assert.match(price, /const currentMyneUsd = getMyneUsd\(\)/);
  assert.doesNotMatch(price, /if \(myneUsd != null && Number\.isFinite\(myneAmount\)\)/);
  assert.match(rounds, /select\('round_id,resolved,settles_at,staking_net_lamports::text'\)/);
  assert.match(rounds, /nowSeconds = Number\(chainNowSeconds\(\)\)/);
  assert.match(rounds, /\.eq\('resolved', true\)[\s\S]*\.not\('staking_net_lamports', 'is', null\)/);
  assert.match(rounds, /STAKING_WINDOW_FALLBACK_LOOKBACK_SECONDS/);
  assert.match(rounds, /selectLatestCompleteStakingRewardWindow\(data \?\? \[\],/);
  assert.match(rounds, /isFallback: selected\.lastSettlesAt !== end \|\| staleLatestRow/);
});
