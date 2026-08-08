import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const roundsPage = await readFile(new URL('../src/chain/rounds-page.js', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('resolved zero-bid rounds remain settled outcomes with an empty payout mode', () => {
  const decorate = roundsPage.slice(
    roundsPage.indexOf('const decorate ='),
    roundsPage.indexOf('const matchesFilter'),
  );
  assert.match(decorate, /const status = r\.resolved \? 'settled'/);
  assert.match(decorate, /r\.totalWager === 0n \? 'empty'/);
});

test('zero-bid rounds publish their tile while explicitly reporting zero MYNE', () => {
  const renderStart = main.indexOf('const renderRoundHistory');
  const render = main.slice(
    renderStart,
    main.indexOf('const refreshRoundHistory', renderStart),
  );
  assert.match(render, /const emptyRound = r\.totalWager === 0n/);
  assert.match(render, /emptyRound \? `Winning tile #\$\{tile\} · no bids · 0 MYNE rewarded`/);
  assert.match(render, /data-randomness=/);
});

test('an unresolved missing round is not presented as a settled no-bid result', () => {
  const renderStart = main.indexOf('const renderRoundHistory');
  const render = main.slice(
    renderStart,
    main.indexOf('const refreshRoundHistory', renderStart),
  );
  assert.match(render, /empty \? 'unsettled' : 'resolving'/);
  assert.match(render, /No published result — round was not settled/);
  assert.doesNotMatch(render, /No bets — pot carried forward/);
});

test('empty rounds do not inflate mined or Motherlode award statistics', () => {
  const summary = roundsPage.slice(roundsPage.indexOf('export function summarise'));
  assert.match(summary, /r\.status === 'settled' && r\.totalWager > 0n/);
  assert.match(summary, /r\.jackpotHit && r\.totalWager > 0n/);
});
