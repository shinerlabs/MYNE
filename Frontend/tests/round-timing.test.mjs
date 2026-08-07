import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { setGenesisTime } from '../src/chain/config.js';
import { roundPhaseLabel, roundPresentation, roundState } from '../src/chain/round.js';
import { minuteApyPercent } from '../src/chain/staking-apy.js';

test('round timing is 60 seconds betting followed directly by 5 showing the winner', () => {
  setGenesisTime(1_000n);

  assert.deepEqual(
    { phase: roundState(1_059n).phase, secondsLeft: roundState(1_059n).secondsLeft },
    { phase: 'betting', secondsLeft: 1 },
  );
  assert.deepEqual(
    { phase: roundState(1_060n).phase, secondsLeft: roundState(1_060n).secondsLeft },
    { phase: 'result', secondsLeft: 5 },
  );
  assert.deepEqual(
    { phase: roundState(1_064n).phase, secondsLeft: roundState(1_064n).secondsLeft },
    { phase: 'result', secondsLeft: 1 },
  );
  assert.deepEqual(
    { roundId: roundState(1_065n).roundId, phase: roundState(1_065n).phase },
    { roundId: 1n, phase: 'betting' },
  );
});

test('the countdown bar carries bidding before text identifies the result', () => {
  assert.equal(roundPhaseLabel('betting'), 'TIME LEFT');
  assert.equal(roundPhaseLabel('result'), 'RESULT');
});

test('result highlights the winning tile without replacing the mining UI', () => {
  assert.deepEqual(roundPresentation('result'), {
    showWinningTile: true,
    showResultTakeover: false,
  });
});

test('winner tile reuses the branded multi-colour countdown overlay', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const winnerRules = [...css.matchAll(/\.slot\.round-winner\s*\{([^}]+)\}/g)].map((match) => match[1]);

  assert.ok(winnerRules.length >= 1);
  assert.ok(winnerRules.some((rule) => rule.includes('var(--tile-countdown-overlay)')));
  assert.doesNotMatch(winnerRules.join('\n'), /background:\s*#f0f0f0/);
  assert.doesNotMatch(main, /class="winner-state"/);
  assert.match(css, /\.slot\.round-winner\s*\{[\s\S]*?animation:\s*none\s*!important/);
  assert.match(css, /\.round-miner-grid i\.has-bid\s*\{[\s\S]*?var\(--tile-pearl-border\)/);
  assert.match(css, /\.round-miner-grid i\.winning\s*\{[\s\S]*?var\(--tile-countdown-overlay\)/);
});

test('staking APY annualises SOL rewards against the SOL value of MYNE weight', () => {
  // 100 MYNE at 10 MYNE/SOL is 10 SOL of pool weight.
  assert.equal(minuteApyPercent(1, 100, 10), 5_256_000);
  assert.equal(minuteApyPercent(0, 100, 10), 0);
  assert.equal(minuteApyPercent(1, 0, 10), null);
  assert.equal(minuteApyPercent(1, 100, 0), null);
});
