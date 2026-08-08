import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AUTO_RECYCLE_SOL_FLAG,
  affordableAutoPlanRounds,
  autoPlanSetupReserve,
  decodeAutoPlanRewardMode,
  encodeAutoPlanRewardMode,
  maxAutoPlanFundingLamports,
  requiredDeposit,
} from '../src/chain/autocommit.js';

test('Auto-round reward mode keeps burn in bit zero and SOL reinvest in bit one', () => {
  assert.equal(AUTO_RECYCLE_SOL_FLAG, 0x02);
  assert.equal(encodeAutoPlanRewardMode(), 0);
  assert.equal(encodeAutoPlanRewardMode({ rewardMode: 'burn' }), 1);
  assert.equal(encodeAutoPlanRewardMode({ autoClaim: true }), 2);
  assert.equal(encodeAutoPlanRewardMode({ rewardMode: 'burn', autoClaim: true }), 3);
  assert.deepEqual(decodeAutoPlanRewardMode(2), { autoClaim: true, rewardMode: 'accumulate' });
  assert.deepEqual(decodeAutoPlanRewardMode(3), { autoClaim: true, rewardMode: 'burn' });
});

test('Auto-round keeps exactly 10% of wallet SOL outside plan funding', () => {
  assert.equal(maxAutoPlanFundingLamports(1_000n), 900n);
  assert.equal(maxAutoPlanFundingLamports(11n), 9n);
  assert.equal(maxAutoPlanFundingLamports(0n), 0n);
  assert.equal(maxAutoPlanFundingLamports(1_000n, 100n), 810n);
});

test('first-wallet setup costs are reserved before the 90% funding ceiling', () => {
  const feeParams = {
    transactionFeeReserve: 5n, autoPlanRent: 20n, minerRent: 30n, stakePositionRent: 40n,
  };
  assert.equal(autoPlanSetupReserve({ hasMiner: false, hasPlan: false, feeParams }), 95n);
  assert.equal(autoPlanSetupReserve({ hasMiner: true, hasPlan: false, feeParams }), 25n);
  assert.equal(autoPlanSetupReserve({ hasMiner: true, hasPlan: true, feeParams }), 5n);
});

test('Auto-round capacity uses the exact wager plus live receipt rent', () => {
  assert.equal(affordableAutoPlanRounds({
    walletBalance: 1_000n,
    amountPerPlay: 100n,
    maxFee: 50n,
    setupReserve: 100n,
  }), 5n);
  assert.equal(requiredDeposit({ amountPerPlay: 100n, maxFee: 50n, fundRounds: 6 }), 900n);
});

test('both initial funding and top-ups enforce the 90% boundary before submission', async () => {
  const [autoCommit, minePage, main] = await Promise.all([
    readFile(new URL('../src/chain/autocommit.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/mine-page.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);
  assert.match(autoCommit, /await assertFundingWithinWalletBudget\(deposit, authority, setupReserve\)/);
  assert.match(autoCommit, /await assertFundingWithinWalletBudget\(value, authority, feeParams\.transactionFeeReserve\)/);
  assert.match(minePage, /deposit > maximumFunding/);
  assert.match(minePage, /value > maximumFunding/);
  assert.match(main, /affordableAutoPlanRounds\(\{/);
  assert.match(main, /state\.autoPlanMaxFee/);
  assert.match(autoCommit, /minerRegistrationInstruction/);
  assert.match(main, /plan\.rewardMode === 'burn'/);
  assert.doesNotMatch(main, /AUTO_FEE_WEI|AUTO_FEE_PER_ROUND|GAS_RESERVE_ETH/);
});

test('Auto-round offers an exact fixed SOL deposit without weakening the live 90% guard', async () => {
  const [autoCommit, minePage, main] = await Promise.all([
    readFile(new URL('../src/chain/autocommit.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/mine-page.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /data-auto-funding="max"[\s\S]*data-auto-funding="fixed"/);
  assert.match(main, /id="auto-funding-amount"[\s\S]*Fixed SOL funding for Auto-round/);
  assert.doesNotMatch(main, /Plan funding|round-helper|Loading live receipt rent/);
  assert.match(main, /fundingMode: autoFundingMode/);
  assert.match(minePage, /fundingMode === 'fixed'[\s\S]*parseEther\(String\(fixedFundingSol\)\)/);
  assert.match(minePage, /deposit < perRoundCost/);
  assert.match(minePage, /deposit > maximumFunding/);
  assert.match(autoCommit, /await assertFundingWithinWalletBudget\(deposit, authority, setupReserve\)/);
});

test('SOL reinvest is an on-chain plan flag and never falls back to wallet delegation', async () => {
  const [autoCommit, minePage, main, appConfig] = await Promise.all([
    readFile(new URL('../src/chain/autocommit.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/mine-page.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/app-config.js', import.meta.url), 'utf8'),
  ]);
  assert.match(autoCommit, /encodeAutoPlanRewardMode\(\{ rewardMode, autoClaim \}\)/);
  assert.match(autoCommit, /autoClaim: mode\.autoClaim/);
  assert.doesNotMatch(autoCommit, /ClaimDelegate|delegate/i);
  assert.doesNotMatch(minePage, /ClaimDelegate|approveAutoClaim/);
  assert.match(main, /all claimable SOL \(mining \+ staking\)/i);
  assert.match(main, /autoReinvestAvailable[\s\S]*FEATURES\.autoReinvestSol/);
  assert.match(main, /existingPlan\.balance \+ \(existingPlan\.autoClaim \? \(chain\.state\.claimableSol/);
  assert.match(autoCommit, /FEATURES\.autoReinvestSol[\s\S]*protocolCapabilities\.autoReinvest/);
  assert.match(appConfig, /VITE_AUTO_REINVEST_SOL === 'true'/);
  assert.doesNotMatch(main, /approve-delegate|needs delegate approval/i);
});

test('an existing auto plan replaces the primary Mine action', async () => {
  const [minePage, main, styles] = await Promise.all([
    readFile(new URL('../src/chain/mine-page.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/viewport-fit.css', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /const planOwnsAction = Boolean\(existingPlan\)/);
  assert.match(main, /deploy\.disabled = !protocolReady \|\| !clockReady \|\| protocolPaused \|\| planOwnsAction/);
  assert.match(main, /deploy\.hidden = planOwnsAction/);
  assert.match(styles, /\.deploy-panel > #deploy\[hidden\] \{[\s\S]*display:\s*none !important/);
  assert.match(main, /id="auto-plan-topup-amount"[\s\S]*id="topup-plan">Top up<[\s\S]*id="cancel-plan">Cancel &amp; withdraw/);
  assert.match(main, /chain\.topUpPlan\(input\?\.value \?\? ''\)/);
  assert.match(minePage, /export async function topUpPlan\(amountSol\)[\s\S]*value = parseEther\(amountSol\)/);
  assert.match(minePage, /if \(state\.plan\?\.enabled\)[\s\S]*is already active\. Use the plan controls to top up or cancel it/);
  assert.match(styles, /\.auto-plan-topup-input \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto/);
});

test('Auto-mine controls use the final MYNE surface hierarchy', async () => {
  const [main, styles] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/viewport-fit.css', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /box\.dataset\.planState = stalled \? 'stalled' : 'active'/);
  assert.match(main, /\$\{planModeLabel\} \$\{stalled \? 'PAUSED' : 'ACTIVE'\}/);
  assert.match(styles, /\.deploy-panel > \.auto-plan \{[\s\S]*background:\s*#101012 !important;[\s\S]*box-shadow:/);
  assert.match(styles, /\.auto-plan-actions \.auto-plan-topup,[\s\S]*background:\s*#f3f3f4 !important;[\s\S]*color:\s*#09090b !important/);
  assert.match(styles, /button\[data-auto-reward="burn"\]\.active \{[\s\S]*var\(--gld-spectrum\) border-box !important/);
});
