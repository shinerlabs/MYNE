import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [source, wideStyles, fitStyles] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/wide-dashboards.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/viewport-fit.css', import.meta.url), 'utf8'),
]);
const styles = `${wideStyles}\n${fitStyles}`;

test('Stake and Referrals use explicit two-column dashboard wrappers', () => {
  assert.match(source, /class="staking-dashboard"/);
  assert.match(source, /class="referrals-dashboard"/);
  assert.match(styles, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /width:\s*min\(1320px, calc\(100% - 48px\)\)/);
});

test('tablet and short-screen dashboards use readable subviews instead of page scrolling', () => {
  assert.match(source, /class="dashboard-view-tabs stake-dashboard-tabs"/);
  assert.match(source, /class="dashboard-view-tabs referral-dashboard-tabs"/);
  assert.match(fitStyles, /@media \(max-width: 1024px\), \(max-height: 650px\)/);
  assert.match(fitStyles, /\.staking-dashboard\[data-mobile-view="overview"\][\s\S]*\.staking-actions[\s\S]*display:\s*none !important/);
  assert.match(fitStyles, /\.referrals-dashboard\[data-mobile-view="leaders"\] #referral-leaders-view[\s\S]*display:\s*grid !important/);
});

test('stake metrics remain one compact rail on phones', () => {
  assert.match(fitStyles, /@media \(max-width: 720px\)[\s\S]*\.staking-metrics \{[\s\S]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\) !important/);
  assert.match(fitStyles, /\.staking-metrics article:nth-child\(3\) \{[\s\S]*border-top:\s*0 !important/);
});

test('large staker counts are formatted before entering the constrained metric cell', () => {
  assert.match(source, /setMetric\('#metric-stakers', Number\(m\.stakers\)\.toLocaleString\(\)\)/);
});

test('staking cards cannot escape their dashboard column', () => {
  assert.match(styles, /\.staking-overview > \*,[\s\S]*max-width:\s*100% !important/);
  assert.match(styles, /\.staking-dashboard \.eth-claim-hero \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) !important/);
  assert.match(styles, /\.staking-metrics strong \{[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis/);
});

test('stake shell uses scrollbar-safe gutters and clears retired reward-card offsets', () => {
  assert.match(styles, /width:\s*min\(1320px, calc\(100% - 48px\)\) !important/);
  assert.match(styles, /\.staking-dashboard \.eth-claim-main \{[\s\S]*margin:\s*0 !important;[\s\S]*padding:\s*0 !important/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*width:\s*calc\(100% - 20px\) !important/);
});

test('stake claim, FLEX and calculator actions share one compact row on mobile', () => {
  assert.match(fitStyles, /@media \(max-width: 720px\)[\s\S]*\.staking-overview > \.stake-rewards > \.eth-claim-actions \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(86px, auto\) !important;[\s\S]*grid-template-rows:\s*44px !important/);
  assert.match(fitStyles, /\.eth-claim-actions > #claim-stake-rewards \{[\s\S]*grid-column:\s*1 !important;[\s\S]*grid-row:\s*1 !important/);
  assert.match(fitStyles, /\.eth-claim-actions > \.staking-share-group \{[\s\S]*grid-column:\s*2 !important;[\s\S]*grid-row:\s*1 !important/);
  assert.match(fitStyles, /\.eth-claim-actions > \.stake-calculator-trigger \{[\s\S]*grid-column:\s*3 !important;[\s\S]*grid-row:\s*1 !important/);
});

test('compact Stake keeps rewards bounded and APY metadata readable', () => {
  assert.match(fitStyles, /@media \(max-width: 1024px\), \(max-height: 650px\)[\s\S]*\.staking-overview \{[\s\S]*height:\s*min\(100%, clamp\(240px, 45dvh, 310px\)\) !important/);
  assert.match(fitStyles, /@media \(max-width: 720px\)[\s\S]*\.staking-yield-metric > small \{[\s\S]*display:\s*none !important/);
  assert.match(fitStyles, /@media \(max-width: 720px\)[\s\S]*\.staking-overview \{[\s\S]*height:\s*min\(100%, 320px\) !important/);
  assert.match(fitStyles, /@media \(max-width: 720px\)[\s\S]*#claim-stake-rewards \{[\s\S]*white-space:\s*nowrap !important/);
});

test('tablet and scaled-desktop Stake use one compact rail without stretching reward cards', () => {
  assert.match(fitStyles, /@media \(min-width: 721px\) and \(max-width: 1024px\)[\s\S]*\.staking-metrics \{[\s\S]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\) !important/);
  assert.match(fitStyles, /@media \(min-width: 721px\) and \(max-width: 1024px\)[\s\S]*\.staking-dashboard \{[\s\S]*height:\s*min\(100%, 348px\) !important;[\s\S]*align-self:\s*start !important/);
  assert.match(fitStyles, /@media \(min-width: 721px\) and \(max-width: 1024px\)[\s\S]*\.staking-overview \{[\s\S]*grid-template-rows:\s*224px 68px !important/);
  assert.match(fitStyles, /@media \(min-width: 721px\) and \(max-width: 1024px\)[\s\S]*\.staking-actions \.stake-composer \{[\s\S]*grid-template-areas:[\s\S]*"mode tier tier"[\s\S]*"amount amount quick"[\s\S]*"submit submit submit"/);
});

test('short desktop Stake reclaims the full frame instead of squeezing into the first column', () => {
  assert.match(fitStyles, /@media \(min-width: 901px\) and \(max-height: 650px\)[\s\S]*\.staking-dashboard \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) !important;[\s\S]*"tabs"[\s\S]*"active"/);
  assert.match(fitStyles, /@media \(min-width: 901px\) and \(max-height: 650px\)[\s\S]*\.staking-actions \.stake-composer \{[\s\S]*"mode tier"[\s\S]*"amount quick"[\s\S]*"submit submit"/);
  assert.match(fitStyles, /@media \(min-width: 901px\) and \(max-height: 650px\)[\s\S]*\.staking-position-strip,[\s\S]*height:\s*44px !important/);
});

test('staking history lives only in About while Stake stays operational', () => {
  const dashboardStart = source.indexOf('<div class="staking-dashboard"');
  const dashboardEnd = source.indexOf('</main>', dashboardStart);
  const chartStart = source.indexOf('<section class="staking-history about-staking-history"');
  const actionsStart = source.indexOf('<div class="staking-dashboard-column staking-actions"', dashboardStart);
  assert.ok(dashboardStart >= 0 && actionsStart > dashboardStart && dashboardEnd > actionsStart);
  assert.ok(chartStart > dashboardEnd);
  assert.doesNotMatch(source.slice(dashboardStart, dashboardEnd), /data-staking-chart/);
  assert.match(source, /if \(target === 'staking-model'\) void refreshStakingHistory\(\)/);
  assert.doesNotMatch(source, /const refreshStaking = async \(\) => \{\s*void refreshStakingMetrics\(\);\s*void refreshStakingHistory\(\)/);
  assert.match(styles, /\.staking-dashboard > \.staking-actions \{\s*grid-area:\s*actions !important/);
});

test('claimable SOL actions stack below the primary balance without collisions', () => {
  assert.match(styles, /\.staking-dashboard \.eth-claim-actions \{[\s\S]*grid-template-rows:\s*auto 44px !important/);
  assert.match(fitStyles, /\.eth-claim-actions > #claim-stake-rewards \{[\s\S]*grid-column:\s*2 !important;[\s\S]*grid-row:\s*1 !important/);
  assert.match(fitStyles, /\.eth-claim-actions > \.stake-calculator-trigger \{[\s\S]*grid-column:\s*1 \/ -1 !important;[\s\S]*grid-row:\s*2 !important/);
});

test('staking calculator is a responsive shareable dialog with both staking tiers', () => {
  assert.match(source, /id="open-stake-calculator"[\s\S]*aria-controls="stake-calculator"/);
  assert.match(source, /id="stake-calculator" role="dialog" aria-modal="true"/);
  assert.match(source, /data-calculator-tier="standard"[\s\S]*data-calculator-tier="burn"/);
  assert.match(source, /const share = projectedTotalWeight > 0 \? weight \/ projectedTotalWeight : null/);
  assert.match(source, /rewardsToStakersEth/);
  assert.match(source, /#stake\?\$\{params\.toString\(\)\}/);
  assert.match(fitStyles, /\.staking-calculator-overlay \{[\s\S]*position:\s*fixed;[\s\S]*place-items:\s*center/);
  assert.match(fitStyles, /@media \(max-width: 720px\)[\s\S]*\.staking-calculator-overlay \.projection-card \{[\s\S]*display:\s*none/);
});

test('staking overview and actions finish on the same desktop baseline', () => {
  assert.match(styles, /@media \(min-width: 901px\)[\s\S]*\.staking-dashboard,[\s\S]*align-items:\s*stretch/);
  assert.match(styles, /\.staking-overview \{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(styles, /\.staking-overview > \.staking-position-strip \{[\s\S]*margin:\s*0 !important/);
  assert.match(styles, /\.staking-actions > \.staking-layout,[\s\S]*\.stake-composer \{[\s\S]*height:\s*100% !important/);
});

test('desktop Stake keeps rewards primary and bounds the transaction rail', () => {
  assert.match(source, /class="staking-yield-metric"[\s\S]*id="metric-apr"[\s\S]*LAST 30 MINUTES/);
  assert.match(fitStyles, /body\[data-route="stake"\] \.staking-dashboard \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) clamp\(460px, 36vw, 500px\) !important/);
  assert.match(fitStyles, /body\[data-route="stake"\] \.staking-overview \{[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\) 82px !important/);
  assert.match(fitStyles, /\.staking-yield-metric strong \{[\s\S]*font-size:\s*clamp\(28px, 2\.25vw, 34px\) !important/);
  assert.match(fitStyles, /\.staking-overview > \.stake-rewards \{[\s\S]*align-items:\s*center !important/);
  assert.match(fitStyles, /\.staking-dashboard \.eth-claim-main \{[\s\S]*align-self:\s*center !important/);
  assert.match(fitStyles, /\.staking-dashboard \.eth-claim-actions \{[\s\S]*align-self:\s*center !important/);
  assert.match(fitStyles, /body\[data-route="stake"\] \.stake-composer \.unstake-policy \{[\s\S]*display:\s*grid !important/);
  assert.match(fitStyles, /#claim-stake-rewards:disabled \{[\s\S]*background:\s*var\(--surface-control\) !important/);
  assert.doesNotMatch(source, /<p class="staking-hero-subtitle">/);
});

test('desktop Stake stays top-aligned inside its restrained 1440px frame', () => {
  assert.match(fitStyles, /body\[data-route="stake"\] \.staking-shell\.page-view\.active,[\s\S]*width:\s*min\(1440px, calc\(100% - 48px\)\) !important/);
  assert.match(fitStyles, /body\[data-route="stake"\] \.staking-shell\.page-view\.active \{[\s\S]*align-items:\s*start !important/);
  assert.match(fitStyles, /body\[data-route="stake"\] \.staking-dashboard \{[\s\S]*height:\s*min\(100%, 388px\) !important;[\s\S]*align-self:\s*start !important;[\s\S]*justify-self:\s*stretch !important/);
  assert.match(fitStyles, /body\[data-route="stake"\] \.staking-overview > \.stake-rewards \{[\s\S]*align-items:\s*center !important/);
  assert.match(fitStyles, /body\[data-route="stake"\] \.staking-actions \.stake-composer \{[\s\S]*align-content:\s*start !important/);
  assert.match(fitStyles, /\.stake-composer:has\(#stake-tier-tabs\[hidden\]\) \{[\s\S]*grid-template-areas:[\s\S]*"mode mode"[\s\S]*"label label"[\s\S]*"amount quick"[\s\S]*"policy policy"[\s\S]*"submit submit"/);
  assert.match(fitStyles, /\.stake-composer:has\(#stake-tier-tabs\[hidden\]\) \{[\s\S]*height:\s*auto !important;[\s\S]*align-self:\s*start !important/);
  assert.match(fitStyles, /\.staking-actions > \.staking-layout:has\(#stake-tier-tabs\[hidden\]\) \{[\s\S]*height:\s*auto !important/);
  assert.match(fitStyles, /@media \(min-width: 901px\) and \(max-height: 800px\)[\s\S]*body\[data-route="stake"\] \.staking-dashboard \{[\s\S]*height:\s*min\(100%, 332px\) !important;[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\) !important/);
});

test('stake vertical order and spacing are explicit at every responsive mode', () => {
  assert.match(styles, /\.staking-dashboard \{[\s\S]*grid-template-areas:\s*"overview actions"/);
  assert.match(styles, /\.staking-overview > :is\(\.stake-rewards, \.staking-position-strip\),[\s\S]*\.staking-actions > \.staking-layout \{[\s\S]*grid-area:\s*auto !important/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*grid-template-areas:[\s\S]*"overview"[\s\S]*"actions"/);
  assert.match(styles, /\.staking-dashboard :is\([\s\S]*\.stake-composer[\s\S]*margin:\s*0 !important/);
});

test('staking history keeps its accessible label without a native hover tooltip', () => {
  assert.match(source, /<svg viewBox="0 0 800 120" role="img" aria-label="Staked MYNE over the past 30 days/);
  assert.doesNotMatch(source, /<title>Total MYNE staked over the past 30 days<\/title>/);
});

test('referral cards retain a two-column dashboard without creating a third implicit column', () => {
  assert.match(styles, /\.referrals-primary,[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) !important/);
  assert.match(styles, /\.referrals-primary > \.referral-command,[\s\S]*grid-column:\s*1 !important;[\s\S]*grid-row:\s*auto !important/);
  assert.match(styles, /\.referrals-secondary > \.referral-leaderboard \{[\s\S]*display:\s*block !important/);
});

test('your referral network appears directly above top networks', () => {
  const secondaryStart = source.indexOf('<div class="referrals-column referrals-secondary">');
  const networkStart = source.indexOf('<section class="my-referrals panel"', secondaryStart);
  const leaderboardStart = source.indexOf('<section class="referral-leaderboard panel"', secondaryStart);
  assert.ok(secondaryStart >= 0 && networkStart > secondaryStart && networkStart < leaderboardStart);
  assert.match(styles, /\.referrals-secondary > \.my-referrals,[\s\S]*\.referrals-secondary > \.referral-leaderboard \{[\s\S]*grid-row:\s*auto !important/);
});

test('referral columns remove legacy double spacing and share a desktop baseline', () => {
  assert.match(styles, /\.feature-shell\[data-page="referrals"\] \.referrals-secondary > :is\(\.my-referrals, \.referral-leaderboard\) \{[\s\S]*margin:\s*0 !important/);
  assert.match(styles, /\.referrals-primary > \.referral-command \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) !important;[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\) auto auto;[\s\S]*height:\s*100% !important/);
  assert.match(styles, /\.referral-command > :is\(\.referral-link-block, \.referral-performance, \.referral-flex-actions\) \{[\s\S]*grid-column:\s*1 !important/);
});

test('desktop Referrals uses a compact link card and an aligned explanatory rail', () => {
  assert.match(source, /class="referral-link-note">Share one permanent link/);
  assert.match(source, /class="referral-rules" aria-label="How referrals work"/);
  assert.match(fitStyles, /body\[data-route="referrals"\] \.referral-link \{[\s\S]*height:\s*58px !important/);
  assert.match(fitStyles, /body\[data-route="referrals"\] \.referral-rules \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*grid-auto-flow:\s*row/);
  assert.match(fitStyles, /body\[data-route="referrals"\] \.referrals-dashboard \{[\s\S]*grid-template-columns:\s*clamp\(410px, 32vw, 440px\) minmax\(0, 1fr\) !important/);
  assert.match(source, /copyReferralButton\.disabled = !acct/);
  assert.doesNotMatch(source, /<small>visits<\/small>/);
});

test('desktop Stake and Referrals share a restrained 1440px content frame', () => {
  assert.match(fitStyles, /body\[data-route="stake"\] \.staking-shell\.page-view\.active,[\s\S]*body\[data-route="referrals"\][\s\S]*width:\s*min\(1440px, calc\(100% - 48px\)\) !important/);
  assert.match(fitStyles, /body\[data-route="stake"\] \.staking-dashboard \{[\s\S]*height:\s*min\(100%, 388px\) !important/);
  assert.match(fitStyles, /body\[data-route="referrals"\] \.referrals-dashboard \{[\s\S]*height:\s*min\(100%, 620px\) !important/);
});

test('Stake and Referrals own exactly one viewport and never scale typography globally', () => {
  assert.match(fitStyles, /body:is\(\[data-route="stake"\], \[data-route="referrals"\]\) \{[\s\S]*height:\s*100dvh;[\s\S]*overflow:\s*hidden !important/);
  assert.match(fitStyles, /height:\s*calc\(100dvh - var\(--premine-banner-h, 0px\) - var\(--fit-topbar\) - var\(--fit-footer\) - var\(--fit-tabbar\)\) !important/);
  assert.doesNotMatch(fitStyles, /\b(?:zoom|transform:\s*scale)\s*:/);
  assert.ok(source.indexOf("import './viewport-fit.css';") > source.indexOf("import './surface-system.css';"));
});

test('referral ledgers are paginated rather than hidden or made into another scrollbar', () => {
  assert.match(source, /const referralPageSizeForViewport = \(\) =>/);
  assert.match(source, /height >= 840\) return 6/);
  assert.doesNotMatch(source, /height >= 1000\) return 8/);
  assert.match(source, /myReferralRows\.slice\(start, start \+ referralPageSize\)/);
  assert.match(source, /leaderboardRows\.slice\(start, start \+ referralPageSize\)/);
  assert.match(source, /data-referral-pagination="network"/);
  assert.match(source, /data-referral-pagination="leaders"/);
  assert.match(fitStyles, /:is\(\.my-referrals-list, \.referral-list\)[\s\S]*overflow:\s*hidden !important/);
});

test('desktop Mine uses a stable viewport frame and a bounded control rail', () => {
  assert.match(fitStyles, /\.workspace\.page-view\.active,[\s\S]*--mine-ui-scale:\s*1 !important/);
  assert.match(fitStyles, /height:\s*calc\(100dvh - var\(--premine-banner-h, 0px\) - 76px - 24px - 8px\) !important/);
  assert.match(fitStyles, /\.workspace\.page-view\.active \.control-column \{[\s\S]*overflow-y:\s*auto !important/);
});

test('paused Mine status scales inside the timer column without clipping', () => {
  assert.match(fitStyles, /\.round-summary\.motherlode-inline > \.time-stat\.paused > strong \{[\s\S]*max-width:\s*calc\(100% - 4px\);[\s\S]*font-size:\s*clamp\(20px, 5\.4cqw, 32px\) !important/);
});

test('collapsing Social preserves Mine board and control tracks', () => {
  assert.match(fitStyles, /\.workspace\.page-view\.active\.chat-hidden \{[\s\S]*grid-template-columns:\s*clamp\(240px, 20vw, 360px\) minmax\(480px, 1fr\) clamp\(400px, 29vw, 500px\) !important/);
  assert.match(fitStyles, /\.workspace\.page-view\.active\.chat-hidden \{[\s\S]*margin:\s*8px 18px 0 !important/);
  assert.match(fitStyles, /grid-template-areas:\s*"social board controls" !important/);
  assert.match(fitStyles, /\.workspace\.page-view\.active > \.board-panel \{[\s\S]*grid-column:\s*2 !important/);
  assert.match(fitStyles, /\.workspace\.page-view\.active > \.control-column \{[\s\S]*grid-column:\s*3 !important/);
  assert.match(fitStyles, /\.workspace\.page-view\.active\.chat-hidden > \.chat-panel \{[\s\S]*display:\s*flex !important;[\s\S]*visibility:\s*hidden !important/);
});

test('connected miners get an unmistakable primary Mine action', () => {
  assert.match(source, /const mineAvailable = Boolean\(chain\.state\.account\) && protocolReady && !protocolPaused/);
  assert.match(source, /const ready = mineAvailable && selected\.size > 0 && entered > 0 && autoFundingReady/);
  assert.match(source, /deploy\.classList\.toggle\('mine-available', mineAvailable\)/);
  assert.match(fitStyles, /#deploy\.mine-available:not\(:disabled\)[\s\S]*background:\s*#f3f3f4 !important;[\s\S]*color:\s*#09090b !important/);
  assert.match(fitStyles, /#deploy\.mine-available:not\(:disabled\)[\s\S]*\.mine-button-mark img[\s\S]*filter:\s*none !important/);
});

test('Rounds and About reserve the fixed footer and own their internal overflow', () => {
  assert.match(fitStyles, /\.feature-shell\[data-page="rounds"\]\.page-view\.active \{[\s\S]*grid-template-rows:[\s\S]*minmax\(0, 1fr\) !important/);
  assert.match(fitStyles, /body\[data-route="rounds"\] \.feature-shell\[data-page="rounds"\]\.page-view\.active \{[\s\S]*clamp\(64px, 9dvh, 78px\)[\s\S]*row-gap:\s*12px !important/);
  assert.match(fitStyles, /body\[data-route="rounds"\] \.feature-shell\[data-page="rounds"\] > \.feature-metrics article \{[\s\S]*min-height:\s*0 !important;[\s\S]*height:\s*100% !important/);
  assert.match(fitStyles, /body\[data-route="rounds"\] \.feature-shell\[data-page="rounds"\] > \.feature-metrics\.supply-metrics \{[\s\S]*margin-top:\s*0 !important/);
  assert.match(fitStyles, /body\[data-route="rounds"\] \.round-list \{[\s\S]*overflow-y:\s*auto !important/);
  assert.match(fitStyles, /\.about-shell\.page-view\.active \{[\s\S]*grid-template-rows:[\s\S]*minmax\(0, 1fr\) !important/);
  assert.match(fitStyles, /body\[data-route="about"\] \.about-shell\.page-view\.active \{[\s\S]*grid-template-rows:\s*clamp\(72px, 11dvh, 102px\) minmax\(0, 1fr\) !important/);
  assert.match(fitStyles, /body\[data-route="about"\] \.about-shell\.page-view\.active > \.feature-hero\.route-header \{[\s\S]*grid-row:\s*1 !important/);
  assert.match(fitStyles, /body\[data-route="about"\] \.about-shell\.page-view\.active > \.about-layout \{[\s\S]*grid-row:\s*2 !important/);
  assert.match(fitStyles, /body\[data-route="about"\] \.about-layout \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(210px, 240px\) !important/);
  assert.match(fitStyles, /body\[data-route="about"\] \.about-nav \{[\s\S]*grid-column:\s*2 !important;[\s\S]*grid-row:\s*1 !important/);
  assert.match(fitStyles, /body\[data-route="about"\] \.about-content \{[\s\S]*overflow-y:\s*auto !important/);
  assert.match(fitStyles, /body\[data-route="about"\] \.about-content \{[\s\S]*grid-column:\s*1 !important;[\s\S]*grid-row:\s*1 !important/);
});

test('context-only routes clear the primary navigation indicator', () => {
  assert.match(source, /if \(!active\) \{[\s\S]*--nav-width', '0px'/);
});

test('standard staking describes its real withdrawal queue', () => {
  assert.match(source, /Flexible · 30-day withdrawal queue/);
  assert.doesNotMatch(source, /Flexible · withdraw anytime/);
});
