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
  assert.match(main, /won · in Rewards/);
  assert.match(main, / · in Rewards/);
  assert.doesNotMatch(main, /won · claimed| · claimed/);
});

test('keeper-accrued receipts refresh both the claim index and durable SOL ledger before an action', () => {
  assert.match(main, /Promise\.all\(\[[\s\S]*refreshRoundHistory\(\{ force: true \}\)[\s\S]*chain\.refreshMiner\(\)/);
  assert.match(main, /const claimableSol = \(state\.claimableSol \?\? 0n\) \+ claimableTotals\.eth/);
  assert.doesNotMatch(main, /already been paid to your wallet/);
  assert.match(mine, /if \(state\.account\) void refreshMiner\(\);[\s\S]*\}, 5000\);/);
  const accountStats = main.slice(main.indexOf('const accountStats'), main.indexOf('const renderAccountMenu'));
  assert.match(accountStats, /chain\.state\.claimableSol \?\? 0n/);
  assert.match(accountStats, /claimableRounds\.reduce\(\(sum, r\) => sum \+ r\.userEth/);
});

test('result reads the exact Round PDA first and uses bounded indexes only for older gaps', () => {
  const resolved = mine.slice(mine.indexOf('async function loadResolved'), mine.indexOf('// --- actions'));
  assert.match(resolved, /const directRound = await readRound\(targetId\)/);
  assert.ok(resolved.indexOf('publishDirect()') < resolved.indexOf('loadLatestSettledRound(targetId)'));
  assert.match(resolved, /loadLatestSettledRound\(targetId\)/);
  assert.match(resolved, /loadLatestPlayedSettledRound\(targetId\)/);
  assert.match(resolved, /resolvedLoaders\.has\(key\)/);
  assert.doesNotMatch(resolved, /loadLatestSettledRound[\s\S]*setTimeout[\s\S]*loadLatestSettledRound/);
  assert.match(mine, /applyRoundSnapshot\(round, slot\)/);
  assert.match(mine, /if \(round\.resolved\) publishResolvedRound\(state\.roundId, round\)/);
  assert.match(mine, /state\.lastResolved = \{ roundId: resolvedId, \.\.\.round \}/);
  assert.doesNotMatch(mine, /winnerDisplayUntil/);
  assert.match(mine, /state\.lastPlayedResolved = \{ roundId: resolvedId, \.\.\.round \}/);
});

test('round refreshes cannot publish an old board after the schedule rolls', () => {
  assert.match(mine, /const requestedRoundId = BigInt\(state\.roundId\)/);
  assert.match(mine, /roundRefreshRequest\?\.roundId === requestedRoundId/);
  assert.match(mine, /if \(state\.roundId !== requestedRoundId\) return/);
  assert.match(mine, /state\.roundId !== roundId \|\| state\.account !== account/);
  assert.match(mine, /void refreshWalletBets\(requestedRoundId, requestedAccount\)/);
  assert.match(mine, /if \(roundRefreshRequest === request\) roundRefreshRequest = null/);
});

test('wallet changes clear another wallet\'s actionable receipt state immediately', () => {
  assert.match(main, /if \(accountChanged\) \{[\s\S]*claimableRounds = \[\];[\s\S]*claimableTotals = \{ count: 0, bullion: 0n, eth: 0n \}/);
  assert.match(main, /const requestId = \+\+roundHistoryRefreshId/);
  assert.match(main, /const requestedAccount = chain\.state\.account/);
  assert.match(main, /requestId !== roundHistoryRefreshId \|\| requestedAccount !== chain\.state\.account/);
});

test('reward ledger reads and actions stay bound to the connected wallet', () => {
  assert.match(mine, /const requestId = \+\+minerRefreshId/);
  assert.match(mine, /const requestedAccount = state\.account/);
  assert.match(mine, /if \(requestedAccount !== state\.account\) return null/);
  assert.match(mine, /if \(requestId !== minerRefreshId\) return miner/);
  assert.match(mine, /minerRefreshId \+= 1;[\s\S]*clearMinerState\(\);[\s\S]*void refreshMiner\(\)/);
  const accountCheck = mine.slice(mine.indexOf('async function freshRewardAccount'), mine.indexOf('/** Settle every selected receipt'));
  assert.match(accountCheck, /getAccount\(\) !== account \|\| state\.account !== account/);
  assert.match(accountCheck, /if \(!miner\)/);

  const claimAll = mine.slice(mine.indexOf('export async function claimAll'), mine.indexOf('/** Settle every selected receipt, then convert'));
  const burn = mine.slice(mine.indexOf('export async function stakeAndBurnRewards'), mine.indexOf('// --- boot'));
  for (const action of [claimAll, burn]) {
    assert.match(action, /const account = getAccount\(\)/);
    assert.match(action, /await freshRewardAccount\(account\)/);
    assert.match(action, /!initialMiner\.hasAccount \|\| !initialMiner\.hasPosition/);
  }
  assert.match(burn, /if \(!miner\.hasPosition\)/);
});

test('wallet reward accounts come from one confirmed cross-account snapshot', () => {
  const readMiner = lottery.slice(
    lottery.indexOf('export async function readMiner'),
    lottery.indexOf('// V6 credits a round'),
  );
  assert.match(readMiner, /getMultipleAccountsInfoAndContext\(accountAddresses, 'confirmed'\)/);
  assert.match(readMiner, /accountSnapshot\.value\[0\]/);
  assert.match(readMiner, /accountSnapshot\.value\[3\]/);
  assert.match(readMiner, /info\.owner\.equals\(protocolProgramId\)/);
  assert.doesNotMatch(readMiner, /fetchProtocolAccount/);
});

test('Claim All settles receipts before withdrawing MYNE and never aliases SOL-only', () => {
  const claimAll = mine.slice(mine.indexOf('export async function claimAll'), mine.indexOf('/** Settle every selected receipt, then convert'));
  assert.match(claimAll, /await claimMany\(roundIds\)/);
  assert.match(claimAll, /runTx\('Claiming SOL…', withdrawClaimableSol, refreshMiner\)/);
  assert.match(claimAll, /const refined = await refine\(\)/);
  assert.match(claimAll, /return refined && allReceiptsProcessed/);
  assert.match(claimAll, /Claimed available rewards · some receipts still need processing/);
  assert.doesNotMatch(claimAll, /claimEthOnly/);
  assert.match(main, /rewardAction === 'sol'[\s\S]*claimEthOnly\(ids\)/);
  assert.match(main, /rewardAction === 'all'[\s\S]*claimAll\(ids\)/);
});

test('partial multi-transaction claims invalidate stale receipts and preserve durable progress', () => {
  const lowLevel = lottery.slice(
    lottery.indexOf('export async function claimManyRounds'),
    lottery.indexOf('export const claimManyEthOnly'),
  );
  assert.match(lowLevel, /try \{[\s\S]*sendInstructions[\s\S]*invalidateReceiptCache\(\)[\s\S]*\} finally \{[\s\S]*invalidateReceiptCache\(\)/);

  const batching = mine.slice(mine.indexOf('async function claimBatched'), mine.indexOf('/** Claim every supplied round'));
  assert.match(batching, /error\?\.code === NO_UNCLAIMED_RECEIPTS/);
  assert.match(batching, /reward is already in the durable wallet ledger/);

  const burn = mine.slice(mine.indexOf('export async function stakeAndBurnRewards'), mine.indexOf('// --- boot'));
  assert.match(burn, /let allReceiptsProcessed = true/);
  assert.match(burn, /Staked \+ burned available MYNE · some receipts still need processing/);
  assert.match(burn, /return false/);
});

test('SOL-only and Stake + Burn actions explicitly withdraw the accrued owner balance', () => {
  const claimSol = mine.slice(mine.indexOf('export async function claimEthOnly'), mine.indexOf('export async function refine'));
  const burn = mine.slice(mine.indexOf('export async function stakeAndBurnRewards'), mine.indexOf('// --- boot'));
  assert.match(claimSol, /await refreshMiner\(\)/);
  assert.match(claimSol, /state\.claimableSol <= 0n/);
  assert.match(claimSol, /if \(processed > 0\)[\s\S]*Claimed SOL to your wallet[\s\S]*return true/);
  assert.match(claimSol, /withdrawClaimableSol/);
  assert.match(burn, /miner\.claimableSol > 0n[\s\S]*withdrawClaimableSol[\s\S]*burnUnclaimedMyne/);
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
