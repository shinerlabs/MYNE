import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  currentRoundHistoryEntry, ROUND_PAGE_SIZE, roundHistoryPageWindow,
} from '../src/chain/rounds-page.js';

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

test('Rounds route reads live chain data and exposes 50-round navigation', async () => {
  const [main, index] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/rounds-index.js', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /includeLive:\s*document\.body\.dataset\.route === 'rounds'/);
  assert.match(main, />Previous 50<[^]*>Next 50</);
  assert.match(main, /chain\.format\.ethSmart\(r\.totalWager\)/);
  assert.match(index, /currentRoundId[^]*\.lte\('round_id', String\(currentRoundId\)\)/);
  assert.match(index, /excludeRoundId[^]*\.neq\('round_id', String\(excludeRoundId\)\)/);
});
