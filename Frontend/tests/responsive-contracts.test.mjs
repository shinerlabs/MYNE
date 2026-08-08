import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [source, legacyStyles, uniformStyles, fitStyles] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/brand-uniform.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/viewport-fit.css', import.meta.url), 'utf8'),
]);

const phoneAuthorityStart = fitStyles.indexOf('/* Phone shell');
assert.ok(phoneAuthorityStart >= 0, 'viewport-fit.css must retain its final phone authority block');
const phoneAuthority = fitStyles.slice(phoneAuthorityStart);

const tabletMineStart = fitStyles.indexOf('/* Tablet landscape:');
const tabletMineEnd = fitStyles.indexOf('/* Shared tablet typography:', tabletMineStart);
assert.ok(tabletMineStart >= 0 && tabletMineEnd > tabletMineStart,
  'viewport-fit.css must retain its 901–1180px Mine authority block');
const tabletMineAuthority = fitStyles.slice(tabletMineStart, tabletMineEnd);

const compactTouchStart = fitStyles.indexOf('/* Pointer-friendly controls');
const compactTouchEnd = fitStyles.indexOf('@media (min-width: 901px)', compactTouchStart);
assert.ok(compactTouchStart >= 0 && compactTouchEnd > compactTouchStart,
  'viewport-fit.css must retain its compact touch-target authority');
const compactTouchAuthority = fitStyles.slice(compactTouchStart, compactTouchEnd);

const compactAboutStart = fitStyles.indexOf('/* Compact About uses a disclosure overlay');
const compactAboutEnd = fitStyles.indexOf('/* Phone shell', compactAboutStart);
assert.ok(compactAboutStart >= 0 && compactAboutEnd > compactAboutStart,
  'viewport-fit.css must retain its compact About dropdown authority');
const compactAboutAuthority = fitStyles.slice(compactAboutStart, compactAboutEnd);

const finalStakeReferralStart = fitStyles.indexOf('/* Final Stake / Referrals compact sizing authority');
assert.ok(finalStakeReferralStart >= 0,
  'viewport-fit.css must retain its final compact Stake / Referrals authority');
const finalStakeReferralAuthority = fitStyles.slice(finalStakeReferralStart);

test('referral tabs and panels have complete reciprocal ARIA linkage', () => {
  for (const view of ['link', 'network', 'leaders']) {
    assert.match(
      source,
      new RegExp(`<button[^>]*id="referral-${view}-tab"[^>]*role="tab"[^>]*aria-controls="referral-${view}-view"[^>]*>`),
    );
    assert.match(
      source,
      new RegExp(`<(?:div|section)[^>]*id="referral-${view}-view"[^>]*role="tabpanel"[^>]*aria-labelledby="referral-${view}-tab"[^>]*>`),
    );
  }

  assert.match(source, /const panel = document\.getElementById\(candidate\.getAttribute\('aria-controls'\)\)/);
  assert.match(source, /const selected = candidate\.getAttribute\('aria-selected'\) === 'true'/);
  assert.match(source, /panel\.setAttribute\('aria-hidden', String\(!selected\)\)/);
  assert.match(source, /panel\.tabIndex = selected \? 0 : -1/);
  assert.match(source, /panel\.removeAttribute\('aria-hidden'\)/);
  assert.match(source, /panel\.removeAttribute\('tabindex'\)/);
  assert.match(source, /aria-label="MYNE earned for you:/);
  assert.match(source, /aria-label="Referrals:/);
  assert.match(source, /aria-label="Active referrals:/);
  assert.match(source, /aria-label="View \$\{chain\.format\.short\(r\.addr\)\} on Solana Explorer"/);
});

test('the phone tabbar has four destinations and a final four-column authority', () => {
  const tabbarMarkup = source.match(/<nav class="tabbar"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
  const tabs = [...tabbarMarkup.matchAll(/<button class="tab"(?=[\s>])/g)];

  assert.equal(tabs.length, 4);
  assert.match(tabbarMarkup, /data-route="mine"/);
  assert.match(tabbarMarkup, /data-route="stake"/);
  assert.match(tabbarMarkup, /id="tab-chat"/);
  assert.match(tabbarMarkup, /id="tab-more"/);
  assert.match(
    phoneAuthority,
    /\.tabbar\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)\s*!important/,
  );
});

test('Mine owns an explicit two-column tablet-landscape layout from 901px through 1180px', () => {
  assert.match(tabletMineAuthority, /@media \(min-width:\s*901px\) and \(max-width:\s*1180px\)/);
  assert.match(
    tabletMineAuthority,
    /\.workspace\.page-view\.active,[\s\S]*?\.workspace\.page-view\.active\.chat-hidden\s*\{[^}]*grid-template-columns:\s*minmax\(470px,\s*1fr\) clamp\(335px,\s*38vw,\s*400px\)\s*!important;[^}]*grid-template-areas:\s*"board controls"\s*!important/,
  );
  assert.match(tabletMineAuthority, /\.chat-hidden > \.chat-panel\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(tabletMineAuthority, /> \.board-panel\s*\{[^}]*grid-area:\s*board\s*!important/);
  assert.match(tabletMineAuthority, /> \.control-column\s*\{[^}]*grid-area:\s*controls\s*!important/);
});

test('phone Stake uses fixed action tracks and reclaims the hidden tier track on Unstake', () => {
  assert.match(source, /document\.querySelector\('#stake-tier-tabs'\)\.hidden = mode !== 'deposit'/);
  assert.match(
    phoneAuthority,
    /Compact Stake hierarchy:[\s\S]*\.staking-actions \.stake-composer\s*\{[^}]*grid-template-rows:\s*52px 86px 14px 54px 44px 44px\s*!important/,
  );
  assert.match(
    phoneAuthority,
    /\.staking-actions \.stake-composer:has\(#stake-tier-tabs\[hidden\]\)\s*\{[^}]*grid-template-areas:[^}]*"mode mode"[^}]*"label label"[^}]*"amount amount"[^}]*"quick quick"[^}]*"submit submit"/,
  );
  assert.match(
    phoneAuthority,
    /Compact Stake hierarchy:[\s\S]*\.staking-actions \.stake-composer:has\(#stake-tier-tabs\[hidden\]\)\s*\{[^}]*grid-template-rows:\s*52px 14px 54px 44px 44px\s*!important/,
  );
});

test('mobile Rounds removes legacy minimum widths while retaining every record field', () => {
  assert.match(legacyStyles, /\.round-table-head, \.round-list\s*\{\s*min-width:\s*900px/);
  assert.match(
    phoneAuthority,
    /body\[data-route="rounds"\] :is\(\.round-list, \.round-entry, \.round-record\)\s*\{[^}]*min-width:\s*0\s*!important;[^}]*width:\s*100%\s*!important/,
  );
  assert.match(phoneAuthority, /body\[data-route="rounds"\] \.round-table-head\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(
    phoneAuthority,
    /body\[data-route="rounds"\] \.round-record\s*\{[^}]*grid-template-columns:\s*64px minmax\(0,\s*1fr\) 78px 14px\s*!important;[^}]*grid-template-rows:\s*repeat\(2,\s*28px\)\s*!important/,
  );
  assert.match(phoneAuthority, /\.round-record > \*\s*\{[^}]*min-width:\s*0\s*!important/);
  assert.match(phoneAuthority, /\.round-record > :is\(span, time\)\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/);

  for (let field = 1; field <= 7; field += 1) {
    assert.match(
      phoneAuthority,
      new RegExp(`\\.round-record > :nth-child\\(${field}\\)\\s*\\{[^}]*grid-column:[^}]*grid-row:`),
      `mobile round field ${field} must retain an explicit grid placement`,
    );
  }

  assert.match(
    uniformStyles,
    /@media \(min-width:\s*721px\) and \(max-width:\s*1000px\)[\s\S]*?:is\(\.round-table-head, \.round-list\)\s*\{[^}]*min-width:\s*0\s*!important/,
  );
});

test('compact primary controls retain usable interaction floors', () => {
  assert.match(phoneAuthority, /\.tabbar \.tab\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*56px/);
  assert.match(phoneAuthority, /\.staking-share-group \.stake-flex-trigger,[\s\S]*?#claim-stake-rewards\s*\{[^}]*min-height:\s*44px\s*!important/);
  assert.match(finalStakeReferralAuthority, /\.stake-composer :is\([\s\S]*?\.stake-mode-tabs,[\s\S]*?\.stake-mode-tabs button[\s\S]*?\)\s*\{[^}]*min-height:\s*44px\s*!important/);
  assert.match(phoneAuthority, /\.stake-composer \.stake-quick-actions,[\s\S]*?\.stake-submit\s*\{[^}]*min-height:\s*44px\s*!important/);
  assert.match(phoneAuthority, /\.referral-link button\s*\{[^}]*min-width:\s*72px\s*!important;[^}]*min-height:\s*44px\s*!important/);
  assert.match(phoneAuthority, /\.referral-flex-actions,[\s\S]*?\.referral-claim-action\s*\{[^}]*min-height:\s*44px\s*!important/);
  assert.match(phoneAuthority, /\.deploy-panel :is\(\.stepper button, #all, #auto-round\),[\s\S]*?\.miners-page-btn\s*\{[^}]*min-height:\s*44px\s*!important/);
  assert.match(phoneAuthority, /\.round-filters button\s*\{[^}]*min-height:\s*44px\s*!important/);
  assert.match(phoneAuthority, /\.round-pagination button\s*\{[^}]*min-width:\s*44px\s*!important;[^}]*min-height:\s*44px\s*!important/);
});

test('Stake and Referrals keep compact tracks, ledgers and controls usable through 1024px', () => {
  assert.match(finalStakeReferralAuthority, /@media \(min-width:\s*721px\) and \(max-width:\s*1024px\)/);
  assert.match(
    finalStakeReferralAuthority,
    /body:is\(\[data-route="stake"\], \[data-route="referrals"\]\) \.dashboard-view-tabs\s*\{[^}]*min-height:\s*44px\s*!important;[^}]*height:\s*44px\s*!important;[^}]*padding:\s*0\s*!important/,
  );
  assert.match(finalStakeReferralAuthority, /\.dashboard-view-tabs button\s*\{[^}]*min-height:\s*44px\s*!important;[^}]*height:\s*44px\s*!important/);
  assert.match(
    finalStakeReferralAuthority,
    /\.stake-composer :is\([\s\S]*?\.stake-mode-tabs,[\s\S]*?\.stake-quick-actions,[\s\S]*?\.stake-submit[\s\S]*?\)\s*\{[^}]*min-height:\s*44px\s*!important;[^}]*height:\s*44px\s*!important/,
  );
  assert.match(finalStakeReferralAuthority, /@media \(max-width:\s*1024px\)[\s\S]*?\.referrals-dashboard > \.referrals-secondary\s*\{[^}]*overflow-y:\s*hidden\s*!important/);
  assert.match(finalStakeReferralAuthority, /\.referral-pagination button,[\s\S]*?> \.round-explorer\s*\{[^}]*min-width:\s*44px\s*!important;[^}]*min-height:\s*44px\s*!important/);
  assert.match(finalStakeReferralAuthority, /> \.round-explorer\s*\{[^}]*justify-content:\s*center\s*!important;[^}]*padding-inline:\s*4px\s*!important/);
  assert.match(finalStakeReferralAuthority, /:is\(\.my-referral-row, \.referral-row\)\s*\{[^}]*min-height:\s*48px\s*!important;[^}]*height:\s*auto\s*!important/);
  assert.match(finalStakeReferralAuthority, /:is\(\.referrer-identity span, \.referral-status, \.round-explorer\)\s*\{[^}]*font-size:\s*10px\s*!important/);
  assert.match(finalStakeReferralAuthority, /\.referral-row\s*\{[^}]*grid-template-rows:\s*minmax\(24px, auto\) minmax\(18px, auto\)\s*!important/);
});

test('About chapter disclosure has reciprocal IDs, current state and complete keyboard focus handling', () => {
  assert.match(source, /list\.id = 'about-chapter-list'/);
  assert.match(source, /button\.setAttribute\('aria-controls', panelId\)/);
  assert.match(source, /panel\.setAttribute\('aria-labelledby', buttonId\)/);
  assert.match(source, /aboutNavToggle\.setAttribute\('aria-controls', list\.id\)/);
  assert.match(source, /button\.setAttribute\('aria-current', 'page'\)/);
  assert.match(source, /button\.removeAttribute\('aria-current'\)/);
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End', 'Escape']) {
    assert.match(source, new RegExp(`['"]${key}['"]`), `About navigation must handle ${key}`);
  }
  assert.match(source, /closeAboutNav\(\{ restoreFocus: true \}\)/);
  assert.match(source, /if \(restoreFocus && wasOpen\) aboutNavToggle\.focus\(\)/);
});

test('About dropdown overlays the article, stays capped and preserves readable addresses', () => {
  assert.match(compactAboutAuthority, /@media \(max-width:\s*860px\)/);
  assert.match(compactAboutAuthority, /\.about-nav-list\s*\{[^}]*position:\s*absolute\s*!important;[^}]*display:\s*none\s*!important;[^}]*max-height:\s*min\(60dvh,\s*420px\)\s*!important;[^}]*overflow-y:\s*auto\s*!important/);
  assert.match(compactAboutAuthority, /\.about-nav\.open \.about-nav-list\s*\{[^}]*display:\s*flex\s*!important/);
  assert.match(compactAboutAuthority, /\.about-nav button\[data-about-section\]\s*\{[^}]*font-size:\s*11px\s*!important/);
  assert.match(compactAboutAuthority, /\.address-row code\s*\{[^}]*font-size:\s*10\.5px\s*!important;[^}]*line-height:\s*1\.5\s*!important/);
  assert.match(phoneAuthority, /body\[data-route="about"\] \.about-nav\s*\{[^}]*top:\s*calc\(56px \+ var\(--premine-banner-h,\s*0px\)\)\s*!important/);
});

test('About and Rounds reset whichever scroll surface owns the compact viewport', () => {
  assert.match(source, /const resetResponsiveSurfaceScroll = \(scrollRegion\)/);
  assert.match(source, /scrollRegion\.scrollTop = 0/);
  assert.match(source, /if \(!summaryBreakpoint\.matches\) return/);
  assert.match(source, /window\.scrollTo\(\{ top: 0, behavior: 'auto' \}\)/);
  assert.match(source, /resetResponsiveSurfaceScroll\(aboutContent\)/);
  assert.equal((source.match(/resetResponsiveSurfaceScroll\(roundList\)/g) ?? []).length, 2);
});

test('About fees stay a two-column comparison on desktop', () => {
  assert.match(fitStyles, /@media \(min-width:\s*901px\)[\s\S]*?body\[data-route="about"\] \.detailed-fees\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*!important/);
});

test('About and Rounds interactive details retain 44px touch floors through tablet widths', () => {
  assert.match(compactTouchAuthority, /@media \(max-width:\s*1180px\), \(any-pointer:\s*coarse\)/);
  for (const selector of [
    '\\.about-nav button\\[data-about-section\\]',
    '\\.address-actions :is\\(button, a\\)',
    '\\.round-filters button',
    '\\.round-pagination button',
    '\\.round-explorer',
  ]) {
    assert.match(compactTouchAuthority, new RegExp(selector), `${selector} must be in the tablet/coarse target group`);
  }
  assert.match(compactTouchAuthority, /min-height:\s*44px\s*!important/);
});
