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
  assert.match(main, /Claim SOL/);
  assert.match(main, /Withdraw accrued SOL to your wallet/);
  assert.doesNotMatch(main, /SOL auto-paid|Sent when each round settles/);
  assert.match(main, /SOL \+ MYNE · 10% fee/);
  assert.match(main, /Permanent 5× weight · 0% fee/);
});

test('keeper-accrued receipts refresh both the claim index and durable SOL ledger before an action', () => {
  assert.match(main, /Promise\.all\(\[[\s\S]*refreshRoundHistory\(\{ force: true \}\)[\s\S]*chain\.refreshMiner\(\)/);
  assert.match(main, /const claimableSol = \(state\.claimableSol \?\? 0n\) \+ claimableTotals\.eth/);
  assert.doesNotMatch(main, /already been paid to your wallet/);
  assert.match(mine, /if \(state\.account\) void refreshMiner\(\);[\s\S]*\}, 5000\);/);
});

test('result and miners card resolve through independent bounded indexes', () => {
  assert.match(mine, /loadLatestSettledRoundId\(roundId\)/);
  assert.match(mine, /loadLatestPlayedSettledRoundId\(roundId\)/);
  assert.match(mine, /state\.lastResolved = \{ roundId: BigInt\(resolvedRoundId\), \.\.\.round \}/);
  assert.match(mine, /state\.lastPlayedResolved = participantRound/);
});

test('wallet changes clear another wallet\'s actionable receipt state immediately', () => {
  assert.match(main, /if \(accountChanged\) \{[\s\S]*claimableRounds = \[\];[\s\S]*claimableTotals = \{ count: 0, bullion: 0n, eth: 0n \}/);
  assert.match(main, /const requestId = \+\+roundHistoryRefreshId/);
  assert.match(main, /const requestedAccount = chain\.state\.account/);
  assert.match(main, /requestId !== roundHistoryRefreshId \|\| requestedAccount !== chain\.state\.account/);
});

test('Claim All settles receipts before withdrawing MYNE and never aliases SOL-only', () => {
  const claimAll = mine.slice(mine.indexOf('export async function claimAll'), mine.indexOf('/** Settle every selected receipt, then convert'));
  assert.match(claimAll, /await claimMany\(roundIds\)/);
  assert.match(claimAll, /runTx\('Claiming SOL…', withdrawClaimableSol, refreshMiner\)/);
  assert.match(claimAll, /if \(state\.unclaimed > 0n\) return refine\(\)/);
  assert.match(claimAll, /return refine\(\)/);
  assert.doesNotMatch(claimAll, /claimEthOnly/);
  assert.match(main, /rewardAction === 'sol'[\s\S]*claimEthOnly\(ids\)/);
  assert.match(main, /rewardAction === 'all'[\s\S]*claimAll\(ids\)/);
});

test('SOL-only and Stake + Burn actions explicitly withdraw the accrued owner balance', () => {
  const claimSol = mine.slice(mine.indexOf('export async function claimEthOnly'), mine.indexOf('export async function refine'));
  const burn = mine.slice(mine.indexOf('export async function stakeAndBurnRewards'), mine.indexOf('// --- boot'));
  assert.match(claimSol, /await refreshMiner\(\)/);
  assert.match(claimSol, /state\.claimableSol <= 0n/);
  assert.match(claimSol, /if \(processed > 0\)[\s\S]*Claimed SOL to your wallet[\s\S]*return true/);
  assert.match(claimSol, /withdrawClaimableSol/);
  assert.match(burn, /state\.claimableSol > 0n[\s\S]*withdrawClaimableSol[\s\S]*burnUnclaimedMyne/);
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
