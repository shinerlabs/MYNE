import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const mine = await readFile(new URL('../src/chain/mine-page.js', import.meta.url), 'utf8');
const lottery = await readFile(new URL('../src/chain/lottery.js', import.meta.url), 'utf8');
const surfaces = await readFile(new URL('../src/surface-system.css', import.meta.url), 'utf8');
const idl = JSON.parse(await readFile(new URL('../src/generated/myne_protocol.json', import.meta.url), 'utf8'));

test('reward controls expose three explicit, accessible protocol intents', () => {
  assert.match(main, /data-reward-action="sol"/);
  assert.match(main, /data-reward-action="all"/);
  assert.match(main, /data-reward-action="burn"/);
  assert.match(main, /Keep MYNE accruing/);
  assert.match(main, /SOL \+ MYNE · 10% fee/);
  assert.match(main, /Permanent 5× weight · 0% fee/);
});

test('Claim All settles receipts before withdrawing MYNE and never aliases SOL-only', () => {
  const claimAll = mine.slice(mine.indexOf('export async function claimAll'), mine.indexOf('/** Settle every selected receipt, then convert'));
  assert.match(claimAll, /await claimMany\(roundIds\)/);
  assert.match(claimAll, /return refine\(\)/);
  assert.doesNotMatch(claimAll, /claimEthOnly/);
  assert.match(main, /rewardAction === 'sol'[\s\S]*claimEthOnly\(ids\)/);
  assert.match(main, /rewardAction === 'all'[\s\S]*claimAll\(ids\)/);
});

test('fee-free reward burn is a dedicated simulated on-chain instruction', () => {
  assert.ok(idl.instructions.some(({ name }) => name === 'burn_unclaimed_myne'));
  assert.match(lottery, /program\.methods\.burnUnclaimedMyne\(\)/);
  assert.match(lottery, /return sendInstructions\(\[instruction\]\)/);
  assert.match(main, /rewardAction === 'burn'[\s\S]*stakeAndBurnRewards\(ids\)/);
});

test('reward buttons use the flat current surface hierarchy and branded burn ring', () => {
  assert.match(surfaces, /body\[data-route="mine"\] \.reward-action/);
  assert.match(surfaces, /\.claim-eth-only[\s\S]*var\(--surface-control\)/);
  assert.match(surfaces, /\.claim-all[\s\S]*#f3f3f4/);
  assert.match(surfaces, /\.rewards-stake[\s\S]*var\(--tile-pearl-border\)/);
});
