import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  currentRoundHistoryEntry, mergeAuthoritativeRecentRounds, mergeAuthoritativeRoundSummary, mergeSettledClaimRounds,
  ROUND_PAGE_SIZE, roundHistoryPageWindow,
} from '../src/chain/rounds-page.js';

test('confirmed recent rows replace stale finalized summary contributions immediately', () => {
  const baseline = { count: 100, mined: 10, deployed: 1_000n, minted: 10n, jackpots: 0 };
  const indexed = [{
    roundId: 100n, resolved: false, totalWager: 0n, bullionForWinners: 0n, jackpotHit: false,
  }];
  const direct = [{
    roundId: 100n, resolved: true, totalWager: 250n, bullionForWinners: 1n, jackpotHit: true,
  }];
  assert.deepEqual(
    mergeAuthoritativeRoundSummary(baseline, indexed, direct, 100),
    { count: 100, mined: 11, deployed: 1_250n, minted: 11n, jackpots: 1 },
  );
});

test('round history is paged in exact batches of 50', () => {
  assert.equal(ROUND_PAGE_SIZE, 50);
  assert.deepEqual(roundHistoryPageWindow(0, ROUND_PAGE_SIZE, true), {
    offset: 0,
    pageSize: 49,
  });
  assert.deepEqual(roundHistoryPageWindow(1, ROUND_PAGE_SIZE, true), {
    offset: 49,
    pageSize: 50,
  });
  assert.deepEqual(roundHistoryPageWindow(2, ROUND_PAGE_SIZE, true), {
    offset: 99,
    pageSize: 50,
  });
  assert.deepEqual(roundHistoryPageWindow(1, ROUND_PAGE_SIZE, false), {
    offset: 50,
    pageSize: 50,
  });
  assert.deepEqual(roundHistoryPageWindow(0, ROUND_PAGE_SIZE, 4), {
    offset: 0,
    pageSize: 46,
  });
  assert.deepEqual(roundHistoryPageWindow(1, ROUND_PAGE_SIZE, 4), {
    offset: 46,
    pageSize: 50,
  });
  assert.deepEqual(roundHistoryPageWindow(2, ROUND_PAGE_SIZE, 4), {
    offset: 96,
    pageSize: 50,
  });
});

test('the active Round PDA becomes an exact live ledger row', () => {
  const row = currentRoundHistoryEntry({
    roundId: 817n,
    round: {
      id: 817n,
      requestedAt: 1n,
      resolved: false,
      totalWager: 125_000_000n,
      jackpotHit: false,
      singleMinerRound: false,
    },
    phase: 'betting',
    secondsLeft: 43,
  });
  assert.equal(row.roundId, 817n);
  assert.equal(row.status, 'live');
  assert.equal(row.mode, 'live');
  assert.equal(row.totalWager, 125_000_000n);
  assert.equal(row.secondsLeft, 43);
  assert.equal(row.isLive, true);
});

test('a missing or mismatched Round PDA is never invented as live data', () => {
  assert.equal(currentRoundHistoryEntry({
    roundId: 817n,
    round: { id: 817n, requestedAt: 0n },
    phase: 'betting',
    secondsLeft: 43,
  }), null);
  assert.equal(currentRoundHistoryEntry({
    roundId: 817n,
    round: { id: 818n, requestedAt: 1n },
    phase: 'betting',
    secondsLeft: 43,
  }), null);
});

test('recent direct-chain rows replace stale indexed states without exceeding 50 rows', () => {
  const indexed = Array.from({ length: 50 }, (_, offset) => ({
    roundId: BigInt(100 - offset),
    status: offset === 0 ? 'resolving' : 'settled',
    mode: offset === 0 ? 'resolving' : 'split',
    totalWager: 1n,
    winningSquare: offset === 0 ? 255 : 1,
  }));
  const recent = [
    { ...indexed[0], status: 'settled', mode: 'solo', winningSquare: 7 },
    { roundId: 101n, status: 'settled', mode: 'empty', totalWager: 0n, winningSquare: 9 },
  ];
  const merged = mergeAuthoritativeRecentRounds(indexed, recent);
  assert.equal(merged.length, 50);
  assert.equal(merged[0].roundId, 101n);
  assert.equal(merged[1].roundId, 100n);
  assert.equal(merged[1].status, 'settled');
  assert.equal(merged[1].winningSquare, 7);
});

test('recent direct settlements inherit only matching complete projection metadata', () => {
  const indexed = [{
    roundId: 100n,
    resolved: true,
    status: 'settled',
    mode: 'solo',
    totalWager: 10n,
    projectionComplete: true,
    singleMinerWinner: 'winner-wallet',
  }];
  const direct = [{
    roundId: 100n,
    resolved: true,
    status: 'settled',
    mode: 'solo',
    totalWager: 10n,
    singleMinerWinner: null,
  }];
  const [complete] = mergeAuthoritativeRecentRounds(indexed, direct);
  assert.equal(complete.projectionComplete, true);
  assert.equal(complete.singleMinerWinner, 'winner-wallet');

  const [lagging] = mergeAuthoritativeRecentRounds([
    { ...indexed[0], resolved: false },
  ], direct);
  assert.equal(lagging.projectionComplete, false);
  assert.equal(lagging.singleMinerWinner, null);
});

test('authoritative filter changes delete the stale indexed version before re-addition', () => {
  const indexed = [
    { roundId: 100n, status: 'settled', mode: 'split', totalWager: 10n },
    { roundId: 99n, status: 'settled', mode: 'split', totalWager: 10n },
  ];
  const authoritative = [
    // The index says Split, while the exact PDA proves it is a no-bid result. It must disappear
    // from the Split filter rather than leave the stale row behind.
    { roundId: 100n, status: 'settled', mode: 'empty', totalWager: 0n },
  ];
  const merged = mergeAuthoritativeRecentRounds(indexed, authoritative, {
    filter: 'split',
    pageSize: 50,
  });
  assert.deepEqual(merged.map((row) => row.roundId), [99n]);
});

test('authoritative insertions shift every 50-row boundary without omissions or duplicates', () => {
  const indexed = Array.from({ length: 100 }, (_, offset) => ({
    roundId: BigInt(100 - offset),
    status: 'settled',
    mode: 'split',
    totalWager: 1n,
  }));
  const authoritative = [
    { roundId: 101n, status: 'settled', mode: 'split', totalWager: 1n },
    { roundId: 100n, status: 'settled', mode: 'solo', totalWager: 1n },
  ];
  const excluded = new Set(authoritative.map((row) => String(row.roundId)));
  const indexWithoutReplacements = indexed.filter((row) => !excluded.has(String(row.roundId)));
  const readVirtualPage = (page) => {
    const window = roundHistoryPageWindow(page, ROUND_PAGE_SIZE, authoritative.length);
    const indexRows = indexWithoutReplacements.slice(window.offset, window.offset + window.pageSize);
    return page === 0
      ? mergeAuthoritativeRecentRounds(indexRows, authoritative, { pageSize: ROUND_PAGE_SIZE })
      : indexRows;
  };
  const pages = [readVirtualPage(0), readVirtualPage(1), readVirtualPage(2)];
  assert.deepEqual(pages.map((rows) => rows.length), [50, 50, 1]);
  const ids = pages.flat().map((row) => row.roundId);
  assert.deepEqual(ids, Array.from({ length: 101 }, (_, offset) => BigInt(101 - offset)));
  assert.equal(new Set(ids.map(String)).size, ids.length);
});

test('recent chain settlements remain discoverable for claims on every visible page', async () => {
  const indexed = [{ roundId: 95n, winningSquare: 2, status: 'settled', totalWager: 1n }];
  const recent = [
    { roundId: 100n, winningSquare: 7, status: 'settled', totalWager: 5n },
    { roundId: 99n, winningSquare: 3, status: 'resolving', totalWager: 5n },
  ];
  assert.deepEqual(
    mergeSettledClaimRounds(indexed, recent).map((row) => row.roundId),
    [95n, 100n],
  );
  const source = await readFile(new URL('../src/chain/rounds-page.js', import.meta.url), 'utf8');
  assert.match(source, /const recentChainRows = await readRecentElapsedRounds\(current\)/);
  assert.doesNotMatch(source, /page === 0[^]*readRecentElapsedRounds/);
});

test('Rounds route reads live chain data and exposes 50-round navigation', async () => {
  const [main, index] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/rounds-index.js', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /includeLive:\s*document\.body\.dataset\.route === 'rounds'/);
  assert.match(main, />Previous 50<[^]*>Next 50</);
  assert.match(main, /chain\.format\.ethSmart\(r\.totalWager\)/);
  assert.match(index, /currentRoundId[^]*\.lte\('round_id', String\(currentRoundId\)\)/);
  assert.match(index, /excludeRoundIds[^]*for \(const roundId of excluded\)[^]*\.neq\('round_id', roundId\)/);
});
