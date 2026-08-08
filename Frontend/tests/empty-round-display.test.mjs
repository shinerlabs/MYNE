import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { classifyRoundLifecycle } from '../src/chain/round-lifecycle.js';

const roundsPage = await readFile(new URL('../src/chain/rounds-page.js', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('resolved zero-bid rounds remain settled outcomes with an empty payout mode', () => {
  const decorate = roundsPage.slice(
    roundsPage.indexOf('const decorate ='),
    roundsPage.indexOf('const matchesFilter'),
  );
  assert.equal(classifyRoundLifecycle({ resolved: true, totalReceipts: 0n }).status, 'settled');
  assert.match(decorate, /classifyRoundLifecycle/);
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
  const lifecycle = classifyRoundLifecycle({
    resolved: false,
    totalReceipts: 0n,
    settlesAt: 100n,
  }, { nowSeconds: 101n });
  assert.equal(lifecycle.status, 'resolving');
  assert.equal(lifecycle.outcomePublished, false);
  const renderStart = main.indexOf('const renderRoundHistory');
  const render = main.slice(
    renderStart,
    main.indexOf('const refreshRoundHistory', renderStart),
  );
  assert.match(render, /r\.status !== 'settled'/);
  assert.match(render, /'Awaiting keeper resolution'/);
  assert.doesNotMatch(render, /No bets — pot carried forward/);
});

test('empty rounds do not inflate mined or Motherlode award statistics', () => {
  const summary = roundsPage.slice(roundsPage.indexOf('export function summarise'));
  assert.match(summary, /r\.status === 'settled' && r\.totalWager > 0n/);
  assert.match(summary, /r\.jackpotHit && r\.totalWager > 0n/);
});
