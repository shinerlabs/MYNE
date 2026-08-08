import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  apyPercent,
  formatApyPercent,
  positionApyPercent,
  positionRewardEstimate,
  resolveStakingApyDisplay,
  selectLatestCompleteStakingRewardWindow,
  selectLatestVerifiedStakingRewardWindow,
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
  assert.equal(formatApyPercent(100_000.01), '100,000%');
  assert.equal(formatApyPercent(30_000_000, { compact: true }), '30,000,000%');
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

test('paused Stake/header and About Stats resolve the same standard APY', async () => {
  const snapshot = stakingApySnapshot({
    apyStandardPct: 5_246,
    apyBurnPct: 26_230,
    aprWindowDays: 30 / 1440,
    aprWindowRounds: 27,
    aprAsOf: 1_700_000_000,
  }, 1_700_000_100);
  const pausedRead = {
    protocolPaused: true,
    apyStandardPct: 3_376,
    apyBurnPct: 16_880,
    aprWindowDays: 30 / 1440,
    aprWindowRounds: 27,
    aprAsOf: 1_700_000_000,
  };

  const stakeSurface = resolveStakingApyDisplay(pausedRead, snapshot).metrics;
  const aboutSurface = resolveStakingApyDisplay(pausedRead, snapshot).metrics;
  assert.equal(stakeSurface.apyStandardPct, 5_246);
  assert.equal(aboutSurface.apyStandardPct, stakeSurface.apyStandardPct);
  assert.equal(aboutSurface.apyBurnPct, stakeSurface.apyBurnPct);

  const liveRead = { ...pausedRead, protocolPaused: false };
  assert.strictEqual(resolveStakingApyDisplay(liveRead, snapshot).metrics, liveRead);

  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /const \{ metrics: staking \} = resolveStakingApyDisplay\(currentStaking, previousApy\)/);
  assert.match(main, /const \{ snapshot: captured, metrics: m \} = resolveStakingApyDisplay\(current, previousApy\)/);
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

test('finalized round events invalidate APY caches and bypass About Stats staleness', async () => {
  const [roundsIndex, main] = await Promise.all([
    readFile(new URL('../src/chain/rounds-index.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);
  assert.match(roundsIndex, /export const invalidateStakingRewardWindowCache = \(\) => \{[\s\S]*stakingWindowCache = null/);
  assert.match(main, /subscribeRoundIndexChanges\(\(\) => \{[\s\S]*invalidateStakingRewardWindowCache\(\)/);
  assert.match(main, /data-about-panel="stats"\]\.active[\s\S]*refreshProtocolStats\(true\)/);
  assert.match(main, /if \(force\) protocolStatsDirty = true/);
  assert.match(main, /queueMicrotask\(\(\) => \{ void refreshProtocolStats\(true\); \}\)/);
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

test('APY falls back to the newest verified contiguous period and updates with each fee row', () => {
  const beforeGap = completeRows();
  const latest = [
    { round_id: '30', resolved: true, settles_at: 1_330, staking_net_lamports: '600' },
    { round_id: '31', resolved: true, settles_at: 1_395, staking_net_lamports: '700' },
    { round_id: '32', resolved: true, settles_at: 1_460, staking_net_lamports: '800' },
  ];
  const first = selectLatestVerifiedStakingRewardWindow([...beforeGap, ...latest], {
    windowMinutes: 30,
    roundCadenceSeconds: 65,
    observedAt: 1_500,
  });
  assert.deepEqual(first, {
    complete: true,
    windowMinutes: 3.25,
    requestedWindowMinutes: 30,
    rewardLamports: 2_100n,
    rounds: 3,
    firstSettlesAt: 1_330,
    lastSettlesAt: 1_460,
    isPartial: true,
  });

  const next = selectLatestVerifiedStakingRewardWindow([...beforeGap, ...latest, {
    round_id: '33', resolved: true, settles_at: 1_525, staking_net_lamports: '900',
  }], {
    windowMinutes: 30,
    roundCadenceSeconds: 65,
    observedAt: 1_540,
  });
  assert.equal(next.rounds, 4);
  assert.equal(next.rewardLamports, 3_000n);
  assert.equal(next.lastSettlesAt, 1_525);
  assert.equal(next.windowMinutes, 65 * 4 / 60);
});

test('APY fallback never interprets unresolved or missing-fee rows as zero', () => {
  const rows = [
    { round_id: '40', resolved: true, settles_at: 2_000, staking_net_lamports: '500' },
    { round_id: '41', resolved: false, settles_at: 2_065, staking_net_lamports: null },
    { round_id: '42', resolved: true, settles_at: 2_130, staking_net_lamports: '700' },
  ];
  const selected = selectLatestVerifiedStakingRewardWindow(rows, {
    windowMinutes: 30,
    roundCadenceSeconds: 65,
    observedAt: 2_140,
  });
  assert.equal(selected.rounds, 1);
  assert.equal(selected.rewardLamports, 700n);
  assert.equal(selected.firstSettlesAt, 2_130);
  assert.equal(selected.lastSettlesAt, 2_130);
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
  assert.doesNotMatch(main, /CLAIMED SOL|History not indexed|stake-lifetime-eth/);
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
  assert.doesNotMatch(staking, /100,000%\+/);
  assert.doesNotMatch(main, /m\.aprPct \* 5/);
  assert.doesNotMatch(main, /const projectionRates/);
  assert.match(main, /stakingMetricsState = null;[\s\S]*#header-staking-apr[\s\S]*updateStakeFlexCard\(\)/);
  assert.match(main, /requestId !== stakingMetricsRefreshId/);
  assert.match(main, /const paused = current\.protocolPaused === true/);
  assert.match(main, /PAUSED SNAPSHOT · \$\{observed\}/);
  assert.match(main, /\$\{observed\} · NON-COMPOUNDING EST\./);
  assert.match(main, /aprFallback: !paused/);
  assert.match(main, /resolveStakingApyDisplay\(current, previousApy\)/);
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
  assert.match(rounds, /selectLatestVerifiedStakingRewardWindow/);
  assert.match(rounds, /selectLatestVerifiedStakingRewardWindow\(data \?\? \[\],/);
  assert.match(rounds, /isFallback: selected\.isPartial \|\| selected\.lastSettlesAt !== end \|\| staleLatestRow/);
});
