import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { expectedReceiptMyneReward, expectedReceiptSolReward } from '../src/chain/lottery.js';

const vector = (entries = {}) => Array.from({ length: 25 }, (_, index) => BigInt(entries[index] ?? 0));

test('claimable SOL includes exact winning-tile and round-wide Motherlode intervals', () => {
  const round = {
    winningSquare: 0,
    winnerTotal: 100n,
    potForWinners: 880n,
    jackpotHit: true,
    motherlodePayoutLamports: 100n,
    totalWager: 1_000n,
  };
  const winner = {
    amounts: vector({ 0: 100, 1: 300 }),
    cumulativeStarts: vector(),
    totalLamports: 400n,
  };
  const losingTileParticipant = {
    amounts: vector({ 1: 600 }),
    cumulativeStarts: vector({ 1: 400 }),
    totalLamports: 600n,
  };

  assert.equal(expectedReceiptSolReward(round, [winner]), 920n);
  assert.equal(expectedReceiptSolReward(round, [losingTileParticipant]), 60n);
  assert.equal(expectedReceiptSolReward(round, [winner, losingTileParticipant]), 980n);
});

test('a non-Motherlode losing receipt never fabricates normal prize SOL', () => {
  const round = {
    winningSquare: 0,
    winnerTotal: 100n,
    potForWinners: 880n,
    jackpotHit: false,
    motherlodePayoutLamports: 0n,
    totalWager: 1_000n,
  };
  const losing = {
    amounts: vector({ 1: 600 }),
    cumulativeStarts: vector({ 1: 400 }),
    totalLamports: 600n,
  };
  assert.equal(expectedReceiptSolReward(round, [losing]), 0n);
});

test('claimable MYNE mirrors split, solo and Motherlode receipt intervals', () => {
  const split = {
    winningSquare: 0,
    winnerTotal: 100n,
    bullionForWinners: 1_000n,
    singleMinerRound: false,
    soloSample: 0n,
    jackpotHit: true,
    motherlodeEmission: 500n,
    totalWager: 1_000n,
  };
  const first = {
    amounts: vector({ 0: 40, 1: 160 }),
    cumulativeStarts: vector(),
    totalLamports: 200n,
  };
  const second = {
    amounts: vector({ 0: 60, 1: 740 }),
    cumulativeStarts: vector({ 0: 40, 1: 160 }),
    totalLamports: 800n,
  };
  assert.equal(expectedReceiptMyneReward(split, [first]), 500n);
  assert.equal(expectedReceiptMyneReward(split, [second]), 1_000n);

  const solo = { ...split, singleMinerRound: true, soloSample: 75n, jackpotHit: false };
  assert.equal(expectedReceiptMyneReward(solo, [first]), 0n);
  assert.equal(expectedReceiptMyneReward(solo, [second]), 1_000n);
});

test('pending estimates exclude receipts already accrued into the wallet ledger', async () => {
  const [source, roundsPage] = await Promise.all([
    readFile(new URL('../src/chain/lottery.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/rounds-page.js', import.meta.url), 'utf8'),
  ]);
  const myne = source.slice(
    source.indexOf('export async function readExpectedRewards'),
    source.indexOf('/** Pure exact unprocessed-receipt MYNE accrual'),
  );
  const sol = source.slice(
    source.indexOf('export async function readExpectedSolRewards'),
    source.indexOf('export async function readRoundIndexAtResolve'),
  );
  assert.match(myne, /!account\.claimed && !account\.refunded/);
  assert.match(sol, /!account\.claimed && !account\.refunded/);
  const claimable = roundsPage.slice(
    roundsPage.indexOf('async function buildClaimable'),
    roundsPage.indexOf('async function loadFromIndex'),
  );
  assert.doesNotMatch(claimable, /readWinnerCounts/);
});
