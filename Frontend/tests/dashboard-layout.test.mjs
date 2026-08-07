import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [source, styles] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wide-dashboards.css', import.meta.url), 'utf8'),
]);

test('Stake and Referrals use explicit two-column dashboard wrappers', () => {
  assert.match(source, /class="staking-dashboard"/);
  assert.match(source, /class="referrals-dashboard"/);
  assert.match(styles, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /width:\s*min\(1320px, calc\(100vw - 48px\)\)/);
});

test('wide dashboards collapse to a single column below the desktop breakpoint', () => {
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*\.staking-dashboard,[\s\S]*\.referrals-dashboard \{ grid-template-columns: 1fr; \}/);
});

test('staking cards cannot escape their dashboard column', () => {
  assert.match(styles, /\.staking-overview > \*,[\s\S]*max-width:\s*100% !important/);
  assert.match(styles, /\.staking-dashboard \.eth-claim-hero \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) !important/);
});

test('staking history spans the dashboard above the stake and unstake controls', () => {
  const dashboardStart = source.indexOf('<div class="staking-dashboard">');
  const chartStart = source.indexOf('<section class="staking-history panel"', dashboardStart);
  const actionsStart = source.indexOf('<div class="staking-dashboard-column staking-actions">', dashboardStart);
  assert.ok(dashboardStart >= 0 && chartStart > dashboardStart && chartStart < actionsStart);
  assert.match(styles, /\.staking-dashboard > \.staking-history \{[\s\S]*grid-column:\s*1 \/ -1;[\s\S]*grid-row:\s*1;/);
  assert.match(styles, /\.staking-dashboard > \.staking-actions \{[\s\S]*grid-row:\s*2;/);
});

test('claimable SOL actions stack below the primary balance without collisions', () => {
  assert.match(styles, /\.staking-dashboard \.eth-claim-actions \{[\s\S]*grid-template-rows:\s*auto 44px !important/);
  assert.match(styles, /#claim-stake-rewards \{[\s\S]*grid-column:\s*1 \/ -1 !important/);
});

test('referral cards retain a two-column dashboard without creating a third implicit column', () => {
  assert.match(styles, /\.referrals-primary,[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) !important/);
  assert.match(styles, /\.referrals-primary > \.referral-command,[\s\S]*grid-column:\s*1 !important;[\s\S]*grid-row:\s*auto !important/);
  assert.match(styles, /\.referrals-secondary > \.referral-leaderboard \{[\s\S]*display:\s*block !important/);
});

test('your referral network appears directly above top networks', () => {
  const secondaryStart = source.indexOf('<div class="referrals-column referrals-secondary">');
  const networkStart = source.indexOf('<section class="my-referrals panel">', secondaryStart);
  const leaderboardStart = source.indexOf('<section class="referral-leaderboard panel">', secondaryStart);
  assert.ok(secondaryStart >= 0 && networkStart > secondaryStart && networkStart < leaderboardStart);
  assert.match(styles, /\.referrals-secondary > \.my-referrals,[\s\S]*\.referrals-secondary > \.referral-leaderboard \{[\s\S]*grid-row:\s*auto !important/);
});
