import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('staking dashboard subviews expose linked tabs and panels', () => {
  assert.match(source, /id="stake-overview-tab"[^>]*aria-controls="stake-overview-view"/);
  assert.match(source, /id="stake-actions-tab"[^>]*aria-controls="stake-actions-view"[^>]*tabindex="-1"/);
  assert.match(source, /id="stake-overview-view" role="tabpanel" aria-labelledby="stake-overview-tab"/);
  assert.match(source, /id="stake-actions-view" role="tabpanel" aria-labelledby="stake-actions-tab"/);
  assert.match(source, /select\(tabs\.find\(\(tab\) => tab\.dataset\.dashboardView === dashboard\.dataset\.mobileView\)/);
});

test('Stake, Unstake, Standard and Burn tabs use one roving keyboard focus', () => {
  assert.match(source, /id="stake-withdraw-tab"[^>]*aria-selected="false" tabindex="-1"/);
  assert.match(source, /id="stake-tier-flex"[^>]*aria-selected="false" tabindex="-1"/);
  assert.match(source, /const syncRovingTabs = \(tabs, activeTab\) =>/);
  assert.match(source, /tab\.tabIndex = selected \? 0 : -1/);
  assert.match(source, /event\.key === 'ArrowRight'/);
  assert.match(source, /event\.key === 'ArrowLeft'/);
  assert.match(source, /event\.key === 'Home'/);
  assert.match(source, /event\.key === 'End'/);
  assert.match(source, /bindRovingTabKeys\(stakeModeTabs/);
  assert.match(source, /bindRovingTabKeys\(stakeTierTabs/);
});

test('mode and tier changes keep labels and available balance safe while staking loads', () => {
  assert.match(source, /heading\.textContent = stakeMode === 'deposit' \? 'Stake' : 'Unstake'/);
  assert.match(source, /Burn staking is permanent and cannot be undone\./);
  assert.match(source, /const available = s \? \(stakeMode === 'deposit' \? s\.walletBullion : s\.flexStaked\) : 0n/);
  assert.match(source, /chain\.format\.solIcon\(available, 2\)/);
  assert.match(source, /stakeAmount\.setAttribute\('aria-label', stakeMode === 'deposit' \? 'MYNE to stake' : 'MYNE to unstake'\)/);
  assert.match(source, /document\.querySelector\('#stake-tier-tabs'\)\.hidden = mode !== 'deposit'/);
});

test('staking actions guard disconnected and empty states before invoking transactions', () => {
  assert.match(source, /claimBtn\.disabled = !chain\.state\.account \|\| !has/);
  assert.match(source, /if \(!chain\.state\.account\) return notify\('Connect wallet to stake'\)/);
  assert.match(source, /if \(!chain\.state\.account\) return notify\('Connect wallet to withdraw unstaked MYNE'\)/);
  assert.match(source, /stakeMode === 'deposit'[\s\S]*stakeTx\(amount, stakeTier\)/);
  assert.match(source, /requestUnstake\(amount\)/);
  assert.match(source, /claimStakingRewards/);
  assert.match(source, /withdrawUnstaked/);
});
