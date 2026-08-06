import './style.css';
import './chat-social.css';
import './stake-compact.css';
import './about-compact.css';
import './brand-uniform.css';
import { LINKS, PRODUCT } from './app-config.js';
import * as chain from './chain/mine-page.js';
import { WALLET_LOGOS } from './wallet-logos.js';
import { loadRoundBets, loadDrandLink, countMyBetRounds } from './chain/rounds-index.js';
import { loadRoundHistory } from './chain/rounds-page.js';
import { readReferralStats, readReferrerOf, setReferrer, claimReferral, readLeaderboard, readMyReferrals } from './chain/referral.js';
import { explorerAddress, dexscreenerUrl, launchAllocation } from './chain/config.js';
import { waitForTx, readSettlementTx, readRoundWinners, verifyRoundFairness, invalidateReceiptCache } from './chain/lottery.js';
import {
  confirmedMinerRoundKey, previousConfirmedRoundId, previousRoundMinerRoster, shouldRefreshConfirmedMiners,
} from './chain/previous-miners.js';
import { displayedMotherlodeSol } from './chain/round-rewards.js';
import { readSupplyStats } from './chain/supply.js';
import { mountSolPrice, usdFor, getSolUsd, getMyneUsd, setMynePerSol, showPremineMynePrice } from './sol-price.js';
import { readSwapState, quote, approveGld, swapSolForGld, swapGldForSol, spotMynePerSol, poolAvailable, withSlippage } from './chain/swap.js';

// Slippage tolerance for swaps, in basis points. 100 = 1%. Enforced on chain.
const SWAP_SLIPPAGE_BPS = 100;
import { isPremine } from './chain/config.js';
import { readableError } from './chain/client.js';
import {
  readStaking, readStakingMetrics, readStakingHistory, readStakeAllowance, approveStake, stake as stakeTx, requestUnstake,
  withdrawUnstaked, claimStakingRewards, toWei, TIER_FLEX, TIER_BURN,
} from './chain/staking.js';
import {
  addresses, solanaNetwork, BETTING_DURATION, WINNER_DISPLAY_DURATION, protocolReady,
} from './chain/config.js';

const BETTING_SECONDS = Number(BETTING_DURATION);
const WINNER_DISPLAY_SECONDS = Number(WINNER_DISPLAY_DURATION);
const LAUNCH_GENESIS_MYNE = launchAllocation.genesisMintMyne;
const LAUNCH_BURN_STAKED_MYNE = launchAllocation.burnStakedMyne;
const LAUNCH_LIQUIDITY_MYNE = launchAllocation.liquidityMyne;
const LAUNCH_MARKET_MYNE = launchAllocation.initialMarketMyne;
const communityLinks = [
  LINKS.telegram && `<a class="header-social" href="${LINKS.telegram}" target="_blank" rel="noreferrer" aria-label="MYNE on Telegram" title="Telegram">${icon('telegram')}</a>`,
  LINKS.x && `<a class="header-social" href="${LINKS.x}" target="_blank" rel="noreferrer" aria-label="MYNE on X" title="X">${icon('x')}</a>`,
].filter(Boolean).join('');

// Social is a secondary surface. Keep Supabase, chat, profiles and stickers out of the entry
// chunk so the protocol UI can paint before that module is requested.
let social = null;
let socialPromise = null;
let scheduleSocialLoad = () => {};

// Tiles render empty and are filled from chain state on the first poll.
const slots = Array.from({ length: 25 }, (_, index) => [index + 1, '0.00']);

// Round history is loaded from chain (see renderRoundHistory); this starts empty.

// Leaderboard is loaded from chain (see renderLeaderboard); starts empty.

/**
 * Copy to clipboard, including over plain HTTP.
 *
 * `navigator.clipboard` exists ONLY in a secure context — https, or localhost. The dev server is
 * reached at http://<vps-ip>:5173, where the entire API is `undefined`, so every copy button
 * failed with "Could not copy". `execCommand('copy')` is deprecated but remains the only path
 * that works in an insecure context, so it stands as the fallback rather than the primary.
 *
 * @returns {Promise<boolean>} whether the text actually reached the clipboard
 */
const copyText = async (text) => {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* permission denied or blocked — fall through to the legacy path */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // readonly stops a mobile keyboard appearing; off-screen keeps the page from scrolling.
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
};

const solIcon = (className = '') => `<img class="sol-icon ${className}" src="/solana-mark.svg" alt="" aria-hidden="true" title="Hover for USD value" />`;

/**
 * Write "<mark> value" into `el` WITHOUT rebuilding the mark.
 *
 * The render loop ticks every second, and these value nodes were each assigned `innerHTML`
 * containing an <img>. That destroys and recreates the image element on every tick — 25 of them
 * across the tile grid alone — and a fresh <img> paints as empty until the browser re-decodes it,
 * so the marks visibly blinked and the whole grid relayouted once a second.
 *
 * The mark is static, so build it once and afterwards touch only the trailing text node. Also
 * skips the write entirely when the text is unchanged, which is the common case: most tiles hold
 * the same value for many consecutive ticks.
 */
const setMarkedValue = (el, markHtml, text) => {
  if (!el) return;
  // HANDS OFF while the USD hover swap owns this element. `showUsd` DETACHES the number's text
  // nodes (it holds them to restore later) and puts a <span class="usd-swap"> in their place, so
  // there is no trailing text node to update. Writing here appended the SOL figure beside the
  // dollar one, and `restoreSol` then re-inserted the held nodes next to it — leaving the tile
  // showing two numbers for good. One hover was enough, and it never cleaned up.
  // The swap repaints from fresh markup on restore, so skipping this tick costs nothing.
  if (el.classList.contains('is-usd')) return;
  const next = ` ${text}`;
  if (el.dataset.mv !== '1' || !el.firstElementChild) {
    el.innerHTML = markHtml;
    el.appendChild(document.createTextNode(next));
    el.dataset.mv = '1';
    return;
  }
  // Exactly ONE text node after the mark, always. Collapsing extras here also repairs any element
  // already stuck with a doubled figure, so it heals on the next tick instead of needing a reload.
  const mark = el.firstElementChild;
  let value = null;
  for (const n of [...el.childNodes]) {
    if (n === mark || n.nodeType !== Node.TEXT_NODE) continue;
    if (!value) value = n;
    else n.remove();
  }
  if (!value) {
    value = document.createTextNode(next);
    mark.after(value);
  } else if (value.nodeValue !== next) {
    value.nodeValue = next;
  }
};

/** classList.toggle / setAttribute on every tick still costs work — only write on a real change. */
const setClass = (el, name, on) => { if (el.classList.contains(name) !== on) el.classList.toggle(name, on); };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };

/**
 * Display number for a round. The contract counts rounds from 0, so the very first round of
 * the protocol renders as "#0" — which reads as a bug, not as a round. Every USER-FACING
 * round number is therefore +1, the same convention the grid already uses for tiles
 * (`tile #${square + 1}`). Anything that feeds a contract call, a `data-round-id`, a cache key
 * or an explorer lookup keeps the RAW id — only the printed label shifts.
 */
const roundNo = (id) => String(BigInt(id) + 1n);
const icon = (name) => ({
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.2 2.4h3.3l-7.2 8.2 8.5 11.2h-6.7l-5.2-6.8-6 6.8H1.6l7.7-8.8L1.3 2.4h6.8l4.7 6.2 5.4-6.2Zm-1.2 17.5h1.8L7.1 4.2H5.2L17 19.9Z"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23.91 3.79 20.3 20.84c-.27 1.2-.98 1.49-1.99.93l-5.5-4.06-2.65 2.55c-.29.29-.54.54-1.11.54l.4-5.59 10.18-9.2c.44-.39-.1-.61-.68-.22L6.37 13.71.95 12.02c-1.18-.37-1.2-1.18.25-1.74L22.37 2.12c.98-.36 1.84.24 1.54 1.67Z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h16v1.5H4zm0 4.75h16v1.5H4zM4 16h16v1.5H4z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.7 5.6 5.3 5.3 5.3-5.3 1.1 1.1-5.3 5.3 5.3 5.3-1.1 1.1-5.3-5.3-5.3 5.3-1.1-1.1 5.3-5.3-5.3-5.3z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14.8a3.2 3.2 0 0 1-3.2 3.2H9l-5 3v-4.1a3.2 3.2 0 0 1-1-2.3V7.2A3.2 3.2 0 0 1 6.2 4h10.6A3.2 3.2 0 0 1 20 7.2v7.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  grid: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h5v5H4V3Zm6 0h5v5h-5V3Zm6 0h4v5h-4V3ZM4 10h5v5H4v-5Zm6 0h5v5h-5v-5Zm6 0h4v5h-4v-5ZM4 17h5v4H4v-4Zm6 0h5v4h-5v-4Zm6 0h4v4h-4v-4Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6 1.4-1.4 7.4 7.4-7.4 7.4L9 18Z"/></svg>',
  'arrow-left': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11H7.83l4.88-4.88L11.3 4.7 4 12l7.3 7.3 1.41-1.42L7.83 13H19v-2Z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13.5a7.7 7.7 0 0 0 .1-1.5 7.7 7.7 0 0 0-.1-1.5l2.1-1.6-2-3.4-2.5 1a8.6 8.6 0 0 0-2.6-1.5L14 2.4h-4L9.6 5a8.6 8.6 0 0 0-2.6 1.5l-2.5-1-2 3.4 2.1 1.6A7.7 7.7 0 0 0 4.5 12c0 .5 0 1 .1 1.5l-2.1 1.6 2 3.4 2.5-1a8.6 8.6 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a8.6 8.6 0 0 0 2.6-1.5l2.5 1 2-3.4-2.1-1.6ZM12 16.2a4.2 4.2 0 1 1 0-8.4 4.2 4.2 0 0 1 0 8.4Z"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11h14v2H5z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v14h-2zM5 11h14v2H5z"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-5.2 0-9 2.5-9 6v2h18v-2c0-3.5-3.8-6-9-6Z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 8 3v6c0 5.1-3.4 9.1-8 11-4.6-1.9-8-5.9-8-11V5l8-3Zm-1.1 13.4 5.7-5.7-1.4-1.4-4.3 4.3-2.1-2.1-1.4 1.4 3.5 3.5Z"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v2h4v4c0 3-2 5-5 5h-.35A6 6 0 0 1 13 16.65V19h4v2H7v-2h4v-2.35A6 6 0 0 1 8.35 14H8c-3 0-5-2-5-5V5h4V3Zm0 4H5v2c0 1.65 1 2.75 2.5 2.95A6 6 0 0 1 7 9.5V7Zm10 0v2.5a6 6 0 0 1-.5 2.45C18 11.75 19 10.65 19 9V7h-2Z"/></svg>',
  // The hammer is artwork, not a glyph: /hammer-icon.png, cropped and centred from the supplied
  // hammer.png (whose subject filled only 69%x77% of its canvas, off-centre, so it rendered small
  // and misaligned at icon sizes). It carries its own colour, so unlike the SVG icons it does not
  // inherit currentColor — see the img.icon-hammer sizing rules in style.css.
  hammer: '<img class="icon-hammer" src="/hammer-icon.png" alt="" aria-hidden="true" />',
  history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 1-8.25 5.4L1.5 10.65V4h6.65L5.32 6.83A7 7 0 1 0 12 5v3l4-4-4-4v3Zm-1 4h2v5.4l3.8 2.2-1 1.73L11 13.55V7Z"/></svg>',
  // Two arrows swapping direction — used by the Swap nav entries.
  swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4 3 8l4 4V9h9V7H7V4Zm10 16 4-4-4-4v3H8v2h9v3Z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5h-2V6.4l-4.7 4.7-1.4-1.4L17.6 5H16V3ZM3 6h4.2l10.4 10.4V15h2v5h-5v-2h1.4L6.4 8H3V6Zm7.3 6.9 1.4 1.4L7.2 19H3v-2h3.4l3.9-4.1Z"/></svg>',
  users: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 13c-4.4 0-7 2.2-7 5v3h14v-3c0-2.8-2.6-5-7-5Zm8.2-.8c-.8 0-1.6.1-2.2.3 1.9 1.2 3 3.1 3 5.5v3h6v-3c0-3.5-2.9-5.8-6.8-5.8Z"/></svg>',
  news: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h13a2 2 0 0 1 2 2v13h1V7h2v12a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Zm2 4v2h9V7H6Zm0 5v1.5h9V12H6Zm0 4v1.5h6V16H6Z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 10h2v8h-2v-8Zm0-4h2v2h-2V6Zm1-4a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v2h4v4c0 3-2 5-5 5h-.35A6 6 0 0 1 13 16.65V19h4v2H7v-2h4v-2.35A6 6 0 0 1 8.35 14H8c-3 0-5-2-5-5V5h4V3Zm0 4H5v2c0 1.65 1 2.75 2.5 2.95A6 6 0 0 1 7 9.5V7Zm10 0v2.5a6 6 0 0 1-.5 2.45C18 11.75 19 10.65 19 9V7h-2Z"/></svg>',
}[name] || '');

const claimPanel = `<section class="claim-panel panel rewards-panel collapsed" aria-label="Rewards">
  <div class="rewards-head"><span class="eyebrow">REWARDS</span><div class="rewards-unclaimed" aria-label="Claimable SOL and MYNE" aria-live="polite"><b><span>${solIcon('rw-eth-mark')} <em id="rw-eth">0.00</em></span><i class="rewards-sep">·</i><span><img src="/gld-icon-transparent.png" alt=""/> <em id="rw-unclaimed-gld">0.00</em></span></b></div><button class="rewards-toggle" id="rewards-toggle" type="button" aria-label="Expand rewards" aria-expanded="false" aria-controls="rewards-body">${icon('chevron')}</button></div>
  <div class="rewards-body" id="rewards-body">
  <div class="rewards-rows">
    <div class="rewards-row"><span>Mined MYNE<small>what your rounds earned</small></span><b><img src="/gld-icon-transparent.png" alt=""/> <em id="rw-mined">0.00</em></b></div>
    <div class="rewards-row"><span>Passive MYNE<small id="rw-passive-note">from other miners’ claim fees · never charged a fee</small></span><b><img src="/gld-icon-transparent.png" alt=""/> <em id="rw-passive">0.00</em></b></div>
  </div>
  <div class="claimable-rounds" id="claimable-rounds" hidden></div>
  <div class="rewards-actions">
    <button class="claim-eth-only" id="claim-eth-only">Claim SOL</button>
    <button class="claim-all" id="claim-all"${isPremine ? ' disabled' : ''}>${isPremine ? 'MYNE locked' : 'Claim All'}</button>
  </div>

  <button class="rewards-stake" id="rewards-stake" data-route="stake">Stake / Burn (0% Fee)</button>
  </div>
</section>`;

const socialPanel = `
  <aside class="chat-panel panel">
    <button class="chat-close-only" id="hide-chat" aria-label="Collapse live chat" title="Collapse chat">${icon('arrow-left')}</button>
    <section class="social-content active" data-social-panel="chat" role="tabpanel">
      <div class="chat-messages" aria-live="polite">
        <div class="chat-empty" id="chat-empty">
          <strong>No messages yet</strong>
          <p>Connect your wallet and say hello to the miners.</p>
        </div>
      </div>
      <div class="chat-compose-shell">
        <div class="chat-compose">
          <button type="button" class="chat-media-btn" id="chat-sticker-btn" aria-label="Open stickers" title="Stickers">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3.2 8.2a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Zm6.4 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4ZM12 17.2c-2.2 0-4-1.2-4.6-2.8h9.2c-.6 1.6-2.4 2.8-4.6 2.8Z"/></svg>
          </button>
          <textarea rows="1" placeholder="Send a message…" autocomplete="off" maxlength="300" aria-label="Chat message"></textarea>
          <button type="button" aria-label="Send message" title="Send" class="chat-send-btn">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.6 21 12 3.4 3.4l-.1 6.8L14 12 3.3 13.8l.1 6.8Z"/></svg>
          </button>
        </div>
        <div class="chat-sticker-panel" id="chat-sticker-panel" hidden>
          <header>
            <b>Stickers</b>
            <button type="button" id="chat-sticker-close" aria-label="Close stickers">✕</button>
          </header>
          <div class="chat-sticker-packs" id="chat-sticker-packs" role="tablist" aria-label="Sticker categories"></div>
          <label class="chat-sticker-search">
            <input id="chat-sticker-search" type="search" placeholder="Search this category…" autocomplete="off"/>
          </label>
          <div class="chat-sticker-grid" id="chat-sticker-grid"></div>
          <button type="button" class="chat-sticker-more" id="chat-sticker-more" hidden>Load more</button>
          <p class="chat-sticker-count" id="chat-sticker-count"></p>
        </div>
        <div class="chat-attach-preview" id="chat-attach-preview" hidden>
          <img alt="Selected sticker preview"/>
          <button type="button" id="chat-attach-clear" aria-label="Remove image">✕</button>
        </div>
        <div class="chat-compose-meta"><small id="chat-hint">Guest chat · connect to unlock your profile</small><span id="chat-char-count">0/300</span></div>
      </div>
    </section>
    <section class="social-content" data-social-panel="news" role="tabpanel">
      <div class="news-admin" id="news-admin" hidden>
        <input id="news-title" type="text" maxlength="120" placeholder="Headline" autocomplete="off"/>
        <textarea id="news-body" rows="2" maxlength="2000" placeholder="News body…"></textarea>
        <div class="news-admin-row">
          <select id="news-category" aria-label="Category">
            <option value="PROTOCOL">PROTOCOL</option>
            <option value="PINNED">PINNED</option>
            <option value="REFERRALS">REFERRALS</option>
            <option value="EDUCATION">EDUCATION</option>
          </select>
          <label class="news-pin"><input id="news-pinned" type="checkbox"/><span>Pin</span></label>
          <button id="news-post" type="button">Post</button>
        </div>
      </div>
      <div class="news-feed" id="news-feed"></div>
    </section>
  </aside>`;

const roundRows = protocolReady
  ? '<div class="round-empty">Loading rounds…</div>'
  : '<div class="round-empty">Round history will appear when the Solana program and indexer are connected.</div>';

const referralRows = ''; // filled from chain by renderLeaderboard()

document.querySelector('#app').innerHTML = `
  <div class="brand-atmosphere" aria-hidden="true"></div>
  <!-- Launch UI is shown while the Solana programs are being connected by the backend team. -->
  <header class="topbar">
    <a class="brand" href="#home" data-route="home" aria-label="MYNE home"><img class="gld-wordmark" src="/myne-wordmark-ui.png" alt="MYNE"/></a>
    <nav class="landing-nav" aria-label="Landing navigation"><button data-route="mine">Mine</button><button data-route="stake">Stake</button>${poolAvailable ? '<button data-route="swap">Swap</button>' : ''}</nav>
    <nav class="main-nav" aria-label="Primary navigation"><button class="nav-item" data-route="mine">Mine</button><button class="nav-item" data-route="stake">Stake</button>${poolAvailable ? '<button class="nav-item" data-route="swap">Swap</button>' : ''}<button class="nav-item" data-route="referrals">Referrals</button><button class="nav-item" data-route="rounds">Rounds</button><button class="nav-item" data-route="about">About</button><div class="menu-wrap"><button class="menu-button" id="menu-button" aria-label="Open menu" aria-expanded="false" aria-controls="site-menu">${icon('menu')}</button></div></nav>
    <div class="header-right"><button class="market-pill header-apr" data-route="stake" aria-label="Open staking, APY loading"><span>APY</span><b id="header-staking-apr">—</b></button><div class="token-menu-host"><button class="market-pill is-menu" id="gld-price-pill" aria-label="MYNE price and token links" aria-haspopup="true" aria-expanded="false"><img src="/gld-icon-transparent.png" alt=""/><b id="gld-price">—</b><i class="token-menu-caret">${icon('chevron')}</i></button><div class="token-menu" id="token-menu" hidden></div></div><div class="market-pill" id="sol-price-pill" aria-label="SOL price">${solIcon('header-sol')}<b id="sol-price">—</b></div>${communityLinks}<div class="header-account"><button class="connect-header" id="connect-wallet">Connect</button><div class="header-account-menu" id="header-account-menu" hidden></div></div></div>
  </header>
  <div class="site-menu" id="site-menu" hidden><span>PROTOCOL</span><button data-route="about" data-about-target="intro"><i>${icon('info')}</i><b>About MYNE</b><small>Scarcity by proof of work</small></button><button data-route="about" data-about-target="mining"><i>${icon('grid')}</i><b>How mining works</b><small>Rounds, tiles and rewards</small></button>${poolAvailable ? `<button data-route="swap"><i>${icon('swap')}</i><b>Swap SOL / MYNE</b><small>Trade on the Solana liquidity pool</small></button>` : ''}<button class="menu-stake" data-route="stake"><i>${icon('shield')}</i><b>Stake MYNE <em class="menu-hot">HOT</em></b><small>Extreme staking rewards</small></button><button data-route="rounds"><i>${icon('history')}</i><b>Round ledger</b><small>Verified historical results</small></button></div>
  <button class="chat-reopen" id="show-chat" aria-label="Show social panel" title="Social">${icon('chat')}</button>

  <main class="landing-page page-view active" data-page="home">
    <section class="landing-hero" aria-labelledby="landing-title">
      <div class="landing-copy">
        <h1 id="landing-title">Value should<br/><span>be earned.</span></h1>
        <p>MYNE is built on a simple belief: digital value should be open to earn, finite by design, and transparent to everyone.</p>
        <div class="landing-actions">
          <button class="landing-primary" data-route="mine">MINE</button>
          <button class="landing-secondary" data-route="about">Read docs</button>
        </div>
      </div>
      <figure class="landing-assay" aria-label="MYNE mark over the twenty-five-tile mining field">
        <span class="landing-ring landing-ring-outer"></span>
        <span class="landing-ring landing-ring-inner"></span>
        <div class="landing-grid" aria-hidden="true">${Array.from({ length: 25 }, (_, index) => `<i${index === 12 ? ' class="core"' : [2, 5, 9].includes(index) ? ' class="selected"' : ''}></i>`).join('')}</div>
        <div class="landing-emblem"><img src="/gld-icon-transparent.png" alt="" aria-hidden="true"/></div>
      </figure>
    </section>
  </main>

  <main class="workspace page-view" data-page="mine">
    ${socialPanel}
    <section class="board-panel panel" aria-label="Mining tiles"><div class="slot-grid">${slots.map(([id, value]) => `<button class="slot" data-slot="${id}" aria-label="Tile ${id}, ${value} SOL deployed" aria-pressed="false"><span>#${id}</span><strong>${value}</strong></button>`).join('')}</div><div class="board-footer"><div class="round-reward" tabindex="0" aria-describedby="round-reward-tip"><span class="round-reward-label"><img src="/gld-icon-transparent.png" alt=""/><b>+${isPremine ? '0.3' : '1'}</b><small>/ ROUND</small></span><aside class="round-reward-tip" id="round-reward-tip" role="tooltip"><strong>Mine ${isPremine ? '0.3' : '1'} MYNE</strong><p>${isPremine ? 'Premine emission is reduced until launch, and mined MYNE stays locked until liquidity opens.' : 'Mine MYNE every round for a chance to receive the Motherlode and staking bonus.'}</p></aside></div><button data-route="about" data-about-target="mining">Details <b>↗</b></button></div></section>
    <aside class="control-column"><section class="round-summary panel"><div class="summary-stat"><span>DEPLOYED</span><strong>${solIcon('summary-eth')} 7.17</strong><small>≈ $24,748</small></div><div class="summary-stat"><span>MOTHERLODE</span><strong><img src="/gld-icon-transparent.png" alt=""/> 4.4</strong><small>MYNE</small></div><div class="summary-stat"><span>TIME LEFT</span><strong>00:34</strong><small>Round #458</small></div></section><section class="deploy-panel panel"><div class="deploy-head"><div><span class="eyebrow">MINT MYNE</span><h2>Configure mine</h2></div><div class="refine-chip" id="mined-chip"><span>${isPremine ? 'MINED · LOCKED' : 'UNCLAIMED'}</span><b><img src="/gld-icon-transparent.png" alt=""/> <em id="mined-chip-value">0.000</em></b></div></div><button class="last-round" data-route="rounds"><span>Last round</span><aside>${icon('grid')} #— <b>—</b> ${icon('chevron')}</aside></button><div class="amount-label-bar"><label class="amount-label" for="amount"><span>SOL per tile</span><small>Balance 2.500 SOL</small></label><button class="mine-currency-toggle" id="mine-currency-toggle" type="button" aria-pressed="false" aria-label="Show mining values in US dollars"><span>SOL</span><i></i><b>USD</b></button></div><div class="amount-display"><i class="extraction-field" aria-hidden="true"></i>${solIcon('amount-eth')}<b class="amount-usd-mark" aria-hidden="true">$</b><input id="amount" value="" placeholder="0.00" inputmode="decimal" aria-label="SOL per tile" autocomplete="off" autocorrect="off" spellcheck="false"/><span>SOL</span></div><div class="quick-amounts"><button data-add="0.0001">+0.0001</button><button data-add="0.001">+0.001</button><button data-add="0.01">+0.01</button><button data-add="0.1">+0.1</button></div><small class="amount-min" hidden></small><div class="configuration"><div class="config-row"><div><b>Tiles</b><small id="tile-helper">No tiles selected</small></div><div class="stepper"><button id="all">ALL</button><button id="tiles-minus" aria-label="Remove tile">${icon('minus')}</button><strong id="tile-count">0</strong><button id="tiles-plus" aria-label="Add tile">${icon('plus')}</button></div></div><div class="config-row auto-row"><div><b>Auto-round</b><small id="auto-helper">Manually enter each round</small></div><button class="auto-toggle" id="auto-round" role="switch" aria-checked="false"><span></span><b>Off</b></button></div><div class="config-row rounds-config"><div><b>Rounds</b><small id="round-helper">Repeat deployment</small></div><div class="stepper compact"><button id="rounds-minus" aria-label="Remove round">${icon('minus')}</button><strong id="round-count">1</strong><button id="rounds-plus" aria-label="Add round">${icon('plus')}</button></div><button class="until-balance-toggle" id="until-balance" role="switch" aria-checked="false" title="Fund as many rounds as your wallet balance allows"><span></span><b>Max</b></button></div><div class="config-row auto-claim-row" hidden><div><b>Auto-claim</b><small>Settle and reclaim after each round</small></div><button class="auto-toggle" id="auto-claim" role="switch" aria-checked="true"><span></span><b>On</b></button></div></div><div class="total-row per-round-row" id="per-round-row" hidden><div><span>Total per round</span></div><strong>${solIcon('total-eth')} <em .00</em> SOL</strong></div><div class="total-row"><div><span>Total deployment</span><small id="total-detail">0 tiles × 0.00 SOL × 1 round</small></div><strong>${solIcon('total-eth')} <em .00</em> SOL</strong></div><div class="auto-plan" id="auto-plan" hidden></div><button class="deploy" id="deploy"><i class="mine-button-mark"><img src="/gld-icon-transparent.png" alt=""/></i><span>MINE</span><b aria-hidden="true">→</b></button><div class="security-note">${icon('shield')} Transactions settle on Solana</div></section><section class="miners round-results panel" hidden aria-live="polite"><div class="miners-head"><div><span class="eyebrow">LIVE THIS ROUND · #458</span><h2>Top miners</h2></div><button data-route="rounds">History</button></div><div class="settlement-result"><span><small>WINNING TILE</small><strong>#13</strong></span><span><small>DEPLOYED</small><strong>${solIcon()} 7.17</strong></span><span><small>REWARD</small><strong><img src="/gld-icon-transparent.png" alt=""/> 1.0</strong></span></div><div class="miner"><i class="bullion-avatar"><img src="/gld-icon-transparent.png" alt=""/></i><b>WILD</b><span>${icon('grid')} 9</span><strong>${solIcon()} 1.250</strong></div><div class="miner"><i>${icon('user')}</i><b>7ykD...B3Ng</b><span>${icon('grid')} 6</span><strong>${solIcon()} 1.111</strong></div><div class="miner"><i>${icon('user')}</i><b>Hm1t...4ENk</b><span>${icon('grid')} 4</span><strong>${solIcon()} 0.780</strong></div><div class="next-round"><span>NEXT ROUND</span><b>00:08</b></div></section></aside>
  </main>

  <main class="feature-shell page-view" data-page="rounds"><header class="feature-hero route-header"><div><span class="eyebrow">ROUNDS</span><h1>History.</h1></div></header><section class="feature-metrics"><article><span>ROUNDS</span><strong>—</strong><small></small></article><article><span>DEPLOYED</span><strong>${solIcon()} 0.00</strong></article><article><span>AVG DEPLOYED</span><strong>${solIcon()} 0.00</strong><small>per mined round</small></article><article><span>MOTHERLODES</span><strong>0</strong></article></section><section class="ledger-panel panel"><div class="ledger-head"><div class="round-filters" role="tablist" aria-label="Filter round history"><button class="active" role="tab" aria-selected="true" data-round-filter="all">All</button><button role="tab" aria-selected="false" data-round-filter="split">Split</button><button role="tab" aria-selected="false" data-round-filter="solo">Solo</button><button role="tab" aria-selected="false" data-round-filter="motherlode">Motherlode</button></div></div><div class="round-table-head"><span>ROUND</span><span>TILE</span><span>MODE</span><span>SOL DEPLOYED</span><span>WINNERS</span><span>TIME</span><span></span></div><div class="round-list">${roundRows}</div></section></main>

  <main class="feature-shell page-view" data-page="referrals">
    <header class="feature-hero route-header referrals-hero"><div><span class="eyebrow">EARN MYNE</span><h1>Referrals.</h1></div></header>
    <section class="feature-metrics referral-metrics"><article><span>CLAIMABLE</span><strong><img src="/gld-icon-transparent.png" alt=""/> 0.000</strong></article><article><span>ACTIVE</span><strong class="referral-active"><b>0</b><small>/ 0</small></strong></article><article><span>EARNED</span><strong><img src="/gld-icon-transparent.png" alt=""/> 0.000</strong></article></section>
    <section class="referral-command panel"><div class="referral-link-block"><span class="eyebrow">YOUR LINK</span><div class="referral-link"><code>Connect wallet for your link</code><button data-copy-ref>Copy</button></div><div class="share-actions"><a id="share-ref-x" href="#" target="_blank" rel="noreferrer" aria-label="Share referral on X" title="Share on X">${icon('x')}</a><a id="share-ref-tg" href="#" target="_blank" rel="noreferrer" aria-label="Share referral on Telegram" title="Share on Telegram">${icon('telegram')}</a></div></div><div class="referral-performance"><span class="eyebrow">30 DAYS</span><strong>1,284 <small>visits</small></strong><strong>94 <small>miners</small></strong><strong class="referral-earned">12.840 <small>earned</small></strong></div></section>
    <section class="my-referrals panel"><div class="ledger-head"><div><span class="eyebrow">YOUR NETWORK</span><h2>People you referred</h2></div></div><div class="my-referrals-head"><span>WALLET</span><span>STATUS</span><span>EARNED FOR YOU</span><span></span></div><div class="my-referrals-list"></div></section>
    <section class="referral-leaderboard panel"><div class="ledger-head"><div><span class="eyebrow">TOP NETWORKS</span><h2>Leaderboard</h2></div></div><div class="referral-table-head"><span>RANK</span><span>CREATOR</span><span>REFERRALS</span><span>ACTIVE</span><span>NETWORK</span><span>EARNED</span><span></span></div><div class="referral-list">${referralRows}</div></section>
  </main>

  <main class="feature-shell staking-shell page-view" data-page="stake">
    <header class="feature-hero route-header staking-hero"><div><span class="eyebrow">SOL REWARDS</span><h1>Stake.</h1><p class="staking-hero-subtitle">8% of mining deployment.</p></div></header>
    <section class="feature-metrics staking-metrics"><article><span>STAKING APY</span><strong id="metric-apr">—</strong></article><article><span>TOTAL STAKED</span><strong><img src="/gld-icon-transparent.png" alt=""/> <b id="metric-staked">—</b></strong></article><article><span>SOL REWARDS POOL</span><strong class="staking-sol-pool">${solIcon()} <b id="metric-pool">—</b></strong></article><article><span>STAKERS</span><strong id="metric-stakers">—</strong></article></section>
    <section class="stake-rewards eth-claim-hero" aria-labelledby="eth-claim-title">
      <div class="eth-claim-main">
        <img class="eth-claim-logo" src="/solana-mark.svg" alt="Solana"/>
        <div><span class="eyebrow" id="eth-claim-title">CLAIMABLE SOL</span><strong id="stake-claimable-eth">0.00</strong><small id="stake-reward-updated">Connect a wallet to see your rewards</small></div>
      </div>
      <div class="eth-claim-actions">
        <div class="eth-lifetime"><span>TOTAL SOL EARNED</span><strong id="stake-lifetime-eth">0.00</strong><small>Claimed + available</small></div>
        <div class="staking-share-group"><div><button id="stake-flex-card" class="stake-flex-trigger" type="button">FLEX</button></div></div>
        <button id="claim-stake-rewards">Connect to claim</button>
      </div>
      <div class="stock-reward-basket" hidden><header><span>LEGACY STOCK REWARDS</span><b></b></header></div>
      <div class="unstake-status" id="unstake-status" hidden></div>
    </section>
    <section class="staking-position-strip" aria-label="Your staking position">
      <article><span>STANDARD STAKE</span><strong id="stake-flex">0.00</strong><small>1× weight</small></article>
      <article><span>BURN STAKE</span><strong id="stake-burn">0.00</strong><small>5× permanent</small></article>
      <article><span>TOTAL WEIGHT</span><strong id="stake-weight">0.00</strong><small>MYNE weight</small></article>
      <article><span>POOL SHARE</span><strong id="stake-share">0.0000%</strong><small>Your SOL share</small></article>
    </section>
    <section class="staking-history panel" data-staking-chart aria-label="Total MYNE staked over time">
      <header><div><span>STAKED MYNE · 30 DAYS</span><strong data-staking-chart-total>—</strong></div><small>PAST 30 DAYS · ON-CHAIN</small></header>
      <div class="staking-history-plot" data-staking-chart-plot><span>Loading staking history…</span></div>
      <footer><span data-staking-chart-start>—</span><span>NOW</span></footer>
    </section>
    <section class="staking-layout">
      <article class="stake-composer panel"><div class="stake-heading"><span class="eyebrow">NEW POSITION</span><h2>Stake</h2></div><label class="stake-amount-label" for="stake-amount"><span>Amount</span><small>2,500 MYNE</small></label><div class="stake-amount"><img src="/gld-icon-transparent.png" alt=""/><input id="stake-amount" value="0" inputmode="decimal" aria-label="MYNE to stake"/><span>MYNE</span><button id="stake-max">MAX</button></div><div class="unstake-policy"><i>30</i><div><span>UNSTAKING</span><b>30-day withdrawal queue</b><p>Request withdrawal at any time. Your MYNE becomes claimable 30 days later.</p></div></div><button class="stake-submit" id="stake-submit">Enter amount</button><small class="stake-caution">Unstaking requests have a 30-day cooldown.</small></article>
    </section>
    <section class="staking-calculator panel" hidden>
      <header class="calculator-head"><div><span class="eyebrow">REWARD CALCULATOR</span><h2>Project your stake.</h2><p>SOL from the 8% mining allocation.</p></div><div class="projection-period" role="group" aria-label="Projection period"><button class="active" data-projection-days="30">30D</button><button data-projection-days="90">90D</button><button data-projection-days="180">180D</button><button data-projection-days="365">1Y</button></div></header>
      <div class="calculator-layout">
        <div class="projection-controls"><label for="calculator-amount"><span>MYNE STAKED</span><small>Revenue-based estimate</small></label><div class="calculator-input"><img src="/gld-icon-transparent.png" alt=""/><input id="calculator-amount" value="150" inputmode="decimal" aria-label="MYNE staking projection amount"/><span>MYNE</span></div><div class="projection-results"><article><span>EST. MINING SOL</span><strong>${solIcon()} <b id="projected-eth">0.300</b></strong><small class="projection-usd" id="projected-eth-usd" aria-label="Estimated mining SOL value in US dollars">$1,035</small></article></div><p class="projection-note">The estimate is based on the 8% mining allocation. Actual rewards follow live round activity.</p></div>
        <article class="projection-card" id="projection-card" aria-label="Shareable staking projection"><header><div><img src="/gld-icon-transparent.png" alt=""/><b>MYNE</b></div><span>STAKING PROJECTION</span></header><div class="projection-card-principal"><small>STAKING</small><strong><b id="card-principal">1,000</b> MYNE</strong><span id="card-period">30 DAYS</span></div><div class="projection-card-rewards"><span><small>MINING SOL</small><strong>${solIcon()} <b id="card-eth">0.300</b></strong></span><span><small>TRADING SOL</small><strong>${solIcon()} <b id="card-gold">0.368</b></strong></span></div><footer><span>Powered by Solana</span><code id="card-link">—</code></footer></article>
      </div>
      <div class="calculator-actions"><button id="share-projection"><span>Share card</span><b>↗</b></button><a id="share-projection-x" href="#" target="_blank" rel="noreferrer">${icon('x')} Share on X</a><button id="copy-projection-link">Copy referral link</button></div>
    </section>
  </main>

  <main class="feature-shell tokenomics-shell simple-tokenomics page-view" data-page="tokenomics">
    <header class="feature-hero route-header tokenomics-hero"><div><span class="eyebrow">SUPPLY</span><h1>Tokenomics.</h1></div></header>
    <section class="value-promises">
      <article class="promise-card promise-mine panel"><span>01</span><div class="promise-icon"><img src="/gld-icon-transparent.png" alt=""/></div><div><small>ROUND</small><h2>+${isPremine ? '0.3' : '1'} MYNE / min</h2><p>Split / solo</p></div></article>
      <article class="promise-card promise-gold panel"><span>02</span><div class="promise-icon gold">M</div><div><small>MOTHERLODE</small><h2>Burn stake + SOL</h2><p>MYNE is burn-staked · SOL is claimable</p></div></article>
      <article class="promise-card promise-stake panel"><span>03</span><div class="promise-icon">10%</div><div><small>REFINE</small><h2>10% / claim</h2><p>9% pool · 1% referrer</p></div></article>
      <article class="promise-card promise-refer panel"><span>04</span><div class="gold-asset-chip"><b>SOL</b><i>${solIcon()}</i></div><div><small>STAKE</small><h2>Earn SOL</h2><p>Mining and trade revenue</p></div></article>
    </section>
    <details class="token-details panel">
      <summary><span><small>DETAILS</small><b>Supply &amp; rewards</b></span><i>+</i></summary>
      <div class="token-details-body">
        <section class="emission-panel"><header><div><span class="eyebrow">SOLANA GENESIS</span><h2>${LAUNCH_GENESIS_MYNE} minted · no pre-existing burn supply</h2></div></header><div class="supply-breakdown genesis-allocation"><span><small>GENESIS MINT</small><b>${LAUNCH_GENESIS_MYNE}</b></span><i>=</i><span><small>LAUNCH LP</small><b>${LAUNCH_LIQUIDITY_MYNE}</b></span><i>→</i><span><small>MARKET SUPPLY</small><b>${LAUNCH_MARKET_MYNE}</b></span><i>→</i><span><small>HARD CAP</small><b>2,000,000</b></span></div></section>
        <section class="simple-flows"><article><span class="eyebrow">MINING</span><h3>Split or solo.</h3><div class="gold-simple-path"><span>Winning tile</span><i>→</i><span>Split winners</span><i>or</i><span>One winner</span></div></article><article><span class="eyebrow">REFINING</span><h3>10% at claim.</h3><div class="gold-simple-path"><span>Claim</span><i>→</i><span>9% unclaimed</span><i>+</i><span>1% referrer</span></div></article></section>
        <p class="asset-footnote"><b>Stakers receive protocol revenue directly in SOL.</b></p>
      </div>
    </details>
  </main>

  <main class="feature-shell about-shell page-view" data-page="about"><header class="feature-hero route-header"><div><span class="eyebrow">PROTOCOL</span><h1>About MYNE.</h1></div></header><div class="about-layout"><aside class="about-nav panel"><span>CONTENTS</span><button class="active" data-about-section="intro">Protocol</button><button data-about-section="mining">Mine</button><button data-about-section="token-flow">Supply</button><button data-about-section="fees">Fees</button><button data-about-section="gold-payouts">Rewards</button><button data-about-section="motherlode">Motherlode</button><button data-about-section="referral-model">Referrals</button><button data-about-section="staking-model">Staking</button></aside><section class="about-content panel">
    <article class="about-section active" data-about-panel="intro"><span class="eyebrow">01 · INTRODUCTION</span><h2>Store of value.</h2><p class="about-lead">MYNE v2 begins with a ${LAUNCH_GENESIS_MYNE} MYNE genesis mint. ${LAUNCH_BURN_STAKED_MYNE} MYNE is permanently burned and staked; only ${LAUNCH_MARKET_MYNE} MYNE enters the market through the initial liquidity pool.</p><div class="about-statline"><span><small>GENESIS MINT</small><strong>${LAUNCH_GENESIS_MYNE}</strong></span><span><small>BURN-STAKED</small><strong>${LAUNCH_BURN_STAKED_MYNE}</strong></span><span><small>MARKET SUPPLY</small><strong>${LAUNCH_MARKET_MYNE}</strong></span><span><small>HARD CAP</small><strong>2,000,000</strong></span></div><div class="principle-grid"><div><b>Public liquidity</b><p>The initial ${LAUNCH_LIQUIDITY_MYNE} MYNE is paired with SOL and forms the entire launch market supply.</p></div><div><b>Genesis burn stake</b><p>${LAUNCH_BURN_STAKED_MYNE} MYNE is permanently removed from liquid supply while retaining protocol staking weight.</p></div><div><b>Mining-only emissions</b><p>After genesis, new MYNE enters supply through competitive mining rounds.</p></div><div><b>Staker yield</b><p>Staked MYNE earns SOL directly from the 8% mining allocation.</p></div></div><div class="protocol-callout"><b>Only ${LAUNCH_MARKET_MYNE} MYNE begins liquid</b><p>The genesis burn stake cannot be sold or withdrawn. At launch, every market-available MYNE originates from the ${LAUNCH_LIQUIDITY_MYNE} MYNE liquidity allocation.</p></div></article>
    <article class="about-section" data-about-panel="mining"><span class="eyebrow">02 · MINING ROUNDS</span><h2>+${isPremine ? '0.3' : '1'} / minute.</h2><p class="about-lead">Miners deploy SOL across a 5×5 grid. Each 60-second round selects one winning tile, followed immediately by a 5-second result window.</p><div class="about-statline"><span><small>TILES</small><strong>25</strong></span><span><small>MINING</small><strong>60 SEC</strong></span><span><small>RESULT</small><strong>5 SEC</strong></span><span><small>REWARD</small><strong>+${isPremine ? '0.3' : '1'}</strong></span></div><div class="steps-list compact-steps"><div><i>1</i><span><b>Select</b><p>Choose tiles manually or set a random tile count.</p></span></div><div><i>2</i><span><b>Deploy</b><p>One SOL amount is applied to every selected tile.</p></span></div><div><i>3</i><span><b>Reveal</b><p>One of the 25 tiles wins at round close.</p></span></div><div><i>4</i><span><b>Settle</b><p>The +${isPremine ? '0.3' : '1'} MYNE reward resolves as Split or Solo.</p></span></div></div><div class="about-split"><div><span>SPLIT · 50%</span><strong>Every miner on the tile</strong><p>The reward is shared in proportion to each miner’s SOL on the winning tile.</p></div><div><span>SOLO · 50%</span><strong>One weighted winner</strong><p>Each miner’s chance equals their share of SOL on the winning tile.</p></div></div><div class="worked-example"><span>EXAMPLE</span><p>A miner supplied <b>0.60 SOL</b> of the tile’s <b>1.00 SOL</b>. They receive 60% in Split mode or have a 60% chance in Solo mode.</p></div><details class="about-disclosure"><summary>Automation rules <i>+</i></summary><p>Auto-round repeats manually selected tiles every round. When Random is active, the chosen number of tiles is randomly reassigned at the start of each automated round.</p></details></article>
    
    <article class="about-section" data-about-panel="token-flow"><span class="eyebrow">03 · TOKEN FLOW</span><h2>${LAUNCH_GENESIS_MYNE} genesis · ${LAUNCH_MARKET_MYNE} market</h2><p class="about-lead">MYNE v2 mints ${LAUNCH_GENESIS_MYNE} at genesis, immediately burn-stakes ${LAUNCH_BURN_STAKED_MYNE}, and pairs the remaining ${LAUNCH_LIQUIDITY_MYNE} with SOL. Mining expands supply until the hard cap.</p><div class="flow-diagram genesis-flow"><div><span>GENESIS MINT</span><strong>${LAUNCH_GENESIS_MYNE} MYNE</strong></div><i>=</i><div><span>PERMANENT BURN STAKE</span><strong>${LAUNCH_BURN_STAKED_MYNE} MYNE</strong></div><i>+</i><div><span>LAUNCH LIQUIDITY</span><strong>${LAUNCH_LIQUIDITY_MYNE} MYNE</strong><small>entire initial market</small></div><i>→</i><div><span>MINING</span><strong>TO 2,000,000</strong></div></div><div class="about-rule-table"><div><span>Genesis allocation</span><strong>${LAUNCH_GENESIS_MYNE} MYNE total</strong><p>${LAUNCH_BURN_STAKED_MYNE} is permanently burn-staked and ${LAUNCH_LIQUIDITY_MYNE} is committed to public liquidity.</p></div><div><span>Initial market supply</span><strong>${LAUNCH_MARKET_MYNE} MYNE</strong><p>No part of the ${LAUNCH_BURN_STAKED_MYNE} MYNE genesis stake can enter the market.</p></div><div><span>Maximum emission</span><strong>${isPremine ? '0.5' : '1.2'} MYNE / round</strong><p>Mining continues until the 2,000,000 MYNE hard cap is reached.</p></div></div><div class="claim-model"><div><span class="eyebrow">UNCLAIMED MYNE</span><strong>Waiting compounds.</strong><p>Mined MYNE first enters an unclaimed balance. Claiming charges 10%: 9% rewards remaining unclaimed balances and 1% pays the claimant’s referrer.</p></div><div class="claim-equation"><span>10.000</span><i>− 10%</i><strong>9.000</strong><small>received</small><em>9% unclaimed · 1% referrer</em></div></div><div class="protocol-callout"><b>Genesis scarcity</b><p>Although ${LAUNCH_GENESIS_MYNE} MYNE is minted, only ${LAUNCH_MARKET_MYNE} is liquid at launch. The ${LAUNCH_BURN_STAKED_MYNE} MYNE burn stake is permanent.</p></div></article>
    <article class="about-section" data-about-panel="fees"><span class="eyebrow">04 · FEES</span><h2>12% · 10%</h2><p class="about-lead">Mining and claiming use separate on-chain fee schedules. No trading fee is enabled in this milestone.</p><div class="fee-grid detailed-fees"><div><strong>12%</strong><b>Mining fee</b><p>Taken in SOL from every round deployment and distributed every minute.</p><small><span>8% of deployment</span>SOL rewards for stakers</small><small><span>2% of deployment</span>Buyback and burn</small><small><span>2% of deployment</span>Motherlode</small></div><div><strong>10%</strong><b>Claim fee</b><p>Charged only when mined MYNE is claimed.</p><small><span>9% of claim</span>Unclaimed balances</small><small><span>1% of claim</span>Permanent referrer</small><small><span>Supply</span>No new mint</small></div></div><div class="worked-example"><span>1.00 SOL DEPLOYED</span><p><b>0.12 SOL</b> is retained: 0.08 staking · 0.02 buyback and burn · 0.02 Motherlode. No admin fee.</p></div><div class="protocol-callout liquidity-callout"><b>Direct SOL yield</b><p>Mining revenue is distributed on-chain. Future trading integrations will be added separately.</p></div></article>
    <article class="about-section" data-about-panel="gold-payouts"><span class="eyebrow">05 · SOL REWARDS</span><h2>Stake MYNE. Earn SOL.</h2><p class="about-lead">Stakers receive 8% of mining deployment in SOL.</p><div class="flow-diagram"><div><span>MINING</span><strong>8% SOL</strong></div></div><div class="about-statline gold-staker-stats"><span><small>REWARD ASSET</small><strong>SOL</strong></span><span><small>MINING SHARE</small><strong>8%</strong></span><span><small>TRADING SHARE</small><strong>0%</strong></span><span><small>ADMIN FEE</small><strong>0%</strong></span></div><div class="about-rule-table"><div><span>Distribution basis</span><strong>Pro rata staking weight</strong><p>Your weight relative to total staking weight determines your share of SOL revenue.</p></div><div><span>Mining source</span><strong>8% of deployed SOL</strong><p>The staking allocation is paid into the SOL reward accumulator every round.</p></div><div><span>Trading source</span><strong>Deferred</strong><p>No pool-trade fee is enabled in this milestone.</p></div></div><div class="protocol-callout"><b>No conversion risk</b><p>Rewards stay in SOL from collection through claim.</p></div></article>
    <article class="about-section" data-about-panel="motherlode"><span class="eyebrow">06 · MOTHERLODE</span><h2>Two assets. Two destinations.</h2><p class="about-lead">The Motherlode grows in SOL from mining deployments, while MYNE accrues every round. On a hit, both assets are shared by every miner in that round in proportion to total deployment.</p><div class="motherlode-grid"><div><strong>+0.2</strong><span>MYNE / round · burn stake</span></div><div><strong>2%</strong><span>Mining SOL</span></div><div><strong>1 / 650</strong><span>Round odds</span></div></div><div class="motherlode-formula"><div><span>BURNT-STAKED MYNE</span><strong>0.2 × rounds since last hit</strong></div><i>+</i><div><span>CLAIMABLE SOL</span><strong>2% deployed SOL</strong></div></div><div class="worked-example"><span>100 ROUNDS WITHOUT A HIT</span><p>Every miner shares the accumulated Motherlode in proportion to total round deployment, including miners who were not on the winning tile.</p></div><div class="protocol-callout"><b>When it hits</b><p>The MYNE is placed directly into each miner’s permanent 5× burn-stake share. The SOL share remains claimable by each miner.</p></div></article>
    <article class="about-section" data-about-panel="referral-model"><span class="eyebrow">07 · REFERRALS</span><h2>Invite. Earn MYNE.</h2><p class="about-lead">A permanent referrer receives 1% whenever a referred miner claims MYNE. It comes from the existing 10% claim fee.</p><div class="about-statline"><span><small>REFERRER</small><strong>1%</strong></span><span><small>UNCLAIMED POOL</small><strong>9%</strong></span><span><small>EXTRA FEE</small><strong>0%</strong></span><span><small>ATTRIBUTION</small><strong>FIRST</strong></span></div><div class="principle-grid"><div><b>Permanent attribution</b><p>The first valid referral attached to a wallet cannot be replaced.</p></div><div><b>Paid at claim</b><p>The referral reward settles only when the referred miner claims MYNE.</p></div><div><b>No additional charge</b><p>The 1% referral payment is carved from the standard 10% claim fee.</p></div><div><b>Public performance</b><p>The leaderboard tracks referrals, active miners and MYNE earned.</p></div></div><div class="worked-example"><span>100 MYNE CLAIMED</span><p>The miner receives <b>90 MYNE</b>, unclaimed miners share <b>9 MYNE</b>, and the permanent referrer receives <b>1 MYNE</b>.</p></div><button class="primary-feature-action" data-route="referrals">Open referral dashboard</button></article>
    <article class="about-section" data-about-panel="staking-model"><span class="eyebrow">08 · STAKING</span><h2>Stake. Earn SOL.</h2><p class="about-lead">Choose standard staking at 1× weight or permanently burn the principal for 5× weight. Motherlode MYNE is awarded directly into the same permanent burn-stake tier.</p><div class="about-statline"><span><small>UNSTAKE QUEUE</small><strong>30 DAYS</strong></span><span><small>MINING SHARE</small><strong>8% SOL</strong></span><span><small>TRADE SOURCE</small><strong>DEFERRED</strong></span><span><small>WEIGHTS</small><strong>1× / 5×</strong></span></div><section class="staking-history about-staking-history" data-staking-chart aria-label="Total MYNE staked over the past 30 days"><header><div><span>STAKED MYNE · 30 DAYS</span><strong data-staking-chart-total>—</strong></div><small>PAST 30 DAYS · ON-CHAIN</small></header><div class="staking-history-plot" data-staking-chart-plot><span>Loading staking history…</span></div><footer><span data-staking-chart-start>—</span><span>NOW</span></footer></section><div class="about-rule-table"><div><span>Standard stake</span><strong>1× pool weight</strong><p>Unstake at any time. The withdrawal request starts a 30-day queue before principal can be claimed.</p></div><div><span>Stake + burn</span><strong>5× pool weight</strong><p>The deposited MYNE is permanently burned and cannot be withdrawn.</p></div><div><span>Motherlode position</span><strong>Automatic 5× burn stake</strong><p>Motherlode MYNE is never liquid: it enters every miner’s permanent burn-staked position automatically when the Motherlode is hit.</p></div><div><span>SOL rewards</span><strong>8% mining allocation</strong><p>Staker SOL rewards accrue by weight and remain claimable.</p></div></div><div class="protocol-callout"><b>SOL stays liquid</b><p>Burn-staked MYNE provides permanent reward weight. SOL earned through staking or a Motherlode remains claimable.</p></div><button class="primary-feature-action" data-route="stake">Open staking</button></article>
  </section></div></main>
  <footer class="network-footer">
    <a href="https://solana.com" target="_blank" rel="noopener noreferrer" aria-label="Powered by Solana">
      <span>POWERED BY</span><img class="solana-word-logo" src="/solana-logo.svg" alt="Solana"/>
    </a>
  </footer>
  <div class="toast" id="toast" role="status"></div>
  <div class="sheet-scrim" id="sheet-scrim" hidden></div>
  <aside class="mobile-sheet" id="chat-drawer" aria-label="Chat"></aside>
  <aside class="mobile-sheet" id="more-sheet" aria-label="More">
    <header><b>MORE</b><button class="sheet-close" data-sheet-close aria-label="Close">${icon('close')}</button></header>
    <div class="sheet-links">
      ${poolAvailable ? `<button data-route="swap">${icon('swap')}<span><b>Swap</b><small>Trade SOL / MYNE</small></span></button>` : ''}
      <button data-route="referrals">${icon('users')}<span><b>Referrals</b><small>Earn from claim fees</small></span></button>
      <button data-route="rounds">${icon('history')}<span><b>Rounds</b><small>Verified round history</small></span></button>
      <button data-route="about">${icon('info')}<span><b>About</b><small>How MYNE works</small></span></button>
    </div>
  </aside>
  <nav class="tabbar" id="tabbar" aria-label="Primary">
    <button class="tab" data-route="mine">${icon('grid')}<b>MINE</b></button>
    <button class="tab" data-route="stake">${icon('shield')}<b>STAKE</b></button>
    <button class="tab" id="tab-chat">${icon('chat')}<b>CHAT</b></button>
    <button class="tab" id="tab-more">${icon('menu')}<b>MORE</b></button>
  </nav>`;

const applyProductIdentity = () => {
  if (PRODUCT.name === 'MYNE' && PRODUCT.tokenSymbol === 'MYNE') return;
  document.title = PRODUCT.name;
  document.querySelectorAll('meta[name="application-name"], meta[name="apple-mobile-web-app-title"], meta[property="og:site_name"], meta[property="og:title"], meta[name="twitter:title"]').forEach((meta) => {
    meta.content = PRODUCT.name;
  });
  const rewrite = (root) => {
    if (root.nodeType === Node.TEXT_NODE) {
      const next = root.nodeValue.replaceAll('MYNE', PRODUCT.tokenSymbol);
      if (next !== root.nodeValue) root.nodeValue = next;
      return;
    }
    if (!(root instanceof Element)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const next = walker.currentNode.nodeValue.replaceAll('MYNE', PRODUCT.tokenSymbol);
      if (next !== walker.currentNode.nodeValue) walker.currentNode.nodeValue = next;
    }
    [root, ...root.querySelectorAll('[aria-label], [title], [alt]')].forEach((element) => {
      for (const attribute of ['aria-label', 'title', 'alt']) {
        if (!element.hasAttribute(attribute)) continue;
        const value = element.getAttribute(attribute);
        if (value.includes('MYNE')) element.setAttribute(attribute, value.replaceAll('MYNE', PRODUCT.tokenSymbol));
      }
    });
  };
  const app = document.querySelector('#app');
  rewrite(app);
  // Several chain-backed panels are rendered after initial paint. Keep branding consistent when
  // those rows arrive without renaming stable internal IDs used by the future backend adapters.
  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'characterData') rewrite(mutation.target);
      mutation.addedNodes.forEach(rewrite);
    });
  }).observe(app, { childList: true, characterData: true, subtree: true });
};
applyProductIdentity();

if (!protocolReady) {
  const protocolActions = [
    '#deploy', '#stake-submit', '#stake-claim',
    '#claim-stake-rewards', '#swap-submit', '#claim-referral', '#claim-referral-rewards',
    '#claim-all', '#claim-eth-only',
  ];
  document.querySelectorAll(protocolActions.join(',')).forEach((control) => {
    control.disabled = true;
    control.setAttribute('aria-disabled', 'true');
    control.title = 'Available when the Solana programs are connected';
  });
}

const selected = new Set();
document.querySelectorAll('.slot').forEach((tile) => {
  // Starts empty and is filled by renderTiles from the chain. It used to seed a mock count
  // derived from the tile id, which rendered plausible-looking miner numbers for a second
  // before the first poll replaced them.
  const minerCount = 0;
  tile.insertAdjacentHTML('beforeend', `<small class="tile-miner-count" aria-label="${minerCount} miners">${icon('users')}<b>${minerCount}</b></small>`);
  tile.setAttribute('aria-label', `${tile.getAttribute('aria-label')}, ${minerCount} miners`);
});
const miningBoard = document.querySelector('.board-panel');
const roundSummary = document.querySelector('.round-summary');
const miningControls = document.querySelector('.control-column');
const summaryBreakpoint = window.matchMedia('(max-width: 900px)');
const placeRoundSummary = () => {
  const host = summaryBreakpoint.matches ? miningBoard : miningControls;
  if (host && roundSummary.parentElement !== host) host.insertBefore(roundSummary, host.firstChild);
};
placeRoundSummary();
summaryBreakpoint.addEventListener?.('change', placeRoundSummary);
const deployedStat = document.querySelector('.summary-stat:nth-child(1)');
const deployedHeading = deployedStat.querySelector(':scope > span');
const deployedTokenValue = deployedStat.querySelector('strong');
const deployedTokenLabel = deployedStat.querySelector('small');
deployedStat.classList.add('deployed-stat');
deployedHeading.dataset.usdLabel = '≈$—';
deployedStat.setAttribute('aria-label', 'Deployed 7.17 SOL, approximately $24,748');
deployedTokenValue.classList.add('deployed-token-value');
deployedTokenValue.insertAdjacentHTML('afterend', '<strong class="deployed-usd-value" aria-hidden="true">$—</strong>');
deployedStat.tabIndex = 0;
deployedTokenLabel.textContent = '';
deployedTokenLabel.setAttribute('aria-hidden', 'true');
deployedTokenLabel.classList.add('deployed-token-label');
const motherlodeStat = document.querySelector('.summary-stat:nth-child(2)');
const motherlodeHeading = motherlodeStat.querySelector(':scope > span');
const motherlodeTokenValue = motherlodeStat.querySelector('strong');
const motherlodeTokenLabel = motherlodeStat.querySelector('small');
motherlodeStat.classList.add('motherlode-stat');
motherlodeHeading.dataset.usdLabel = '≈$—';
motherlodeStat.setAttribute('aria-label', 'Motherlode SOL payment plus staking bonus MYNE, burned and staked at 5× reward weight');
motherlodeTokenValue.classList.add('motherlode-token-value');
motherlodeTokenValue.innerHTML = `<img src="/gld-icon-transparent.png" alt=""/><em class="motherlode-primary-value">4.4</em><b class="motherlode-unit">MYNE</b>`;
motherlodeTokenLabel.innerHTML = `${solIcon('motherlode-eth')}<span class="motherlode-eth-value">0.0072</span><span class="motherlode-eth-usd" aria-hidden="true">$—</span><b>SOL</b>`;
motherlodeTokenLabel.classList.add('motherlode-secondary');
motherlodeStat.tabIndex = 0;
roundSummary.classList.add('motherlode-inline');

// Summary labels are the hover counterpart to the selected headline currency.
// Keep the numbers themselves stable on hover; only the descriptor beneath the
// card changes to the other denomination.
const syncSummaryHoverLabels = () => {
  const selectedUsd = mineDisplayCurrency === 'usd';
  [deployedHeading, motherlodeHeading].forEach((heading) => {
    const alternate = selectedUsd ? heading.dataset.solLabel : heading.dataset.usdLabel;
    if (alternate) heading.dataset.hoverLabel = alternate;
  });
};

document.querySelector('.deploy-panel').insertAdjacentHTML('afterend', claimPanel);
document.querySelector('.rewards-panel')?.insertAdjacentHTML('afterend', `
  <section class="round-miners-panel panel" aria-label="Confirmed miners from the previous round">
    <div class="round-miners-head"><span class="eyebrow miners-round-hint" tabindex="0" aria-label="All confirmed miners from the previous round" title="Previous round miners">MINERS</span><small id="round-miners-label">PREVIOUS ROUND</small></div>
    <div class="round-miners-list" id="round-miners-list"></div>
    <nav class="round-miners-pagination" id="round-miners-pagination" aria-label="Previous round miners pages" hidden>
      <button type="button" data-miners-page="prev" aria-label="Previous 10 miners">${icon('chevron')}</button>
      <span id="round-miners-page-label" aria-live="polite"></span>
      <button type="button" data-miners-page="next" aria-label="Next 10 miners">${icon('chevron')}</button>
    </nav>
  </section>`);
motherlodeStat.querySelector(':scope > span').textContent = 'MOTHERLODE';
document.querySelector('.deploy-head .eyebrow').remove();
document.querySelector('.deploy-head h2').textContent = 'Mine MYNE';
document.querySelector('.amount-label > span').textContent = 'SOL / tile';
document.querySelector('.amount-label small').textContent = '';
document.querySelector('.configuration .config-row:nth-child(2) small').hidden = false;
document.querySelector('#auto-helper').hidden = true;
document.querySelector('.total-row > div > span').textContent = 'Total';
document.querySelector('.security-note').remove();
document.querySelector('.stake-heading').remove();
// The total readout is updated every time the tile selection changes; restore its stable hook
// here for the compact mining template as well as the full composer markup.
const totalAmountElement = document.querySelector('.total-row:not(.per-round-row) strong em');
if (totalAmountElement) totalAmountElement.id = 'total-amount';
const mineButton = document.querySelector('#deploy');
if (mineButton) {
  // Keep the action as a direct grid child. A malformed legacy total-value tag can cause
  // browsers to implicitly wrap the button in an <em>, which makes grid-column and centering
  // rules appear ineffective even when the button's computed styles look correct.
  const accidentalWrapper = mineButton.parentElement;
  if (accidentalWrapper?.tagName === 'EM' && accidentalWrapper.parentElement) {
    const deployPanel = mineButton.closest('.deploy-panel');
    // The legacy malformed value token leaves an implicit <em> around the action. Remove
    // that wrapper entirely; leaving placeholder text here renders a second stray 0.00.
    accidentalWrapper.remove();
    deployPanel?.insertBefore(mineButton, deployPanel.querySelector('.security-note'));
  }
  // Rebuild both total rows after parsing the legacy template. The old `<em .00</em>` token
  // is invalid HTML and can swallow the row contents (and the button) into an implicit wrapper.
  // Normalizing the rows here gives each amount one stable hook and prevents duplicate readouts.
  document.querySelectorAll('.deploy-panel > .total-row').forEach((row) => {
    const perRound = row.id === 'per-round-row';
    row.innerHTML = `<div><span>${perRound ? 'Total per round' : 'Total deployment'}</span>${perRound ? '' : '<small id="total-detail"></small>'}</div><strong>${solIcon(perRound ? 'per-round-eth' : 'total-eth')} <em id="${perRound ? 'per-round-amount' : 'total-amount'}">0.00</em> SOL</strong>`;
  });
  // Mining values stay in SOL; do not advertise or expose the site-wide USD hover affordance here.
  document.querySelectorAll('.deploy-panel img.sol-icon, .round-summary img.sol-icon').forEach((iconNode) => iconNode.removeAttribute('title'));
  mineButton.innerHTML = '<span>MINE</span><i class="mine-button-mark"><img src="/gld-icon-transparent.png" alt="MYNE"/></i>';
  const minePanel = mineButton.closest('.deploy-panel');
  if (minePanel) {
    // The responsive composer can be left in a flex/grid intermediate state during hot reload.
    // Reassert the two-column grid so the action's full-row placement has a real second column.
    minePanel.style.setProperty('display', 'grid', 'important');
    minePanel.style.setProperty('grid-template-columns', 'minmax(0, 1fr) clamp(132px, 31%, 150px)', 'important');
  }
  // Keep the action independent of the composer grid: it is a wide, centered control at every
  // breakpoint rather than a button stretched across the first grid column.
  Object.assign(mineButton.style, {
    width: '80%',
    maxWidth: 'none',
    minWidth: '0',
    height: '40px',
    minHeight: '40px',
    marginLeft: 'auto',
    marginRight: 'auto',
    justifySelf: 'center',
    alignSelf: 'center',
    gridColumn: '1 / -1',
  });
  // Inline-important guards against a stale/late responsive stylesheet stretching the action.
  mineButton.style.setProperty('width', '80%', 'important');
  mineButton.style.setProperty('max-width', 'none', 'important');
  mineButton.style.setProperty('min-width', '0', 'important');
  mineButton.style.setProperty('margin-left', 'auto', 'important');
  mineButton.style.setProperty('margin-right', 'auto', 'important');
  mineButton.style.setProperty('justify-self', 'center', 'important');
  mineButton.style.setProperty('grid-column', '1 / -1', 'important');
  mineButton.style.setProperty('grid-column-start', '1', 'important');
  mineButton.style.setProperty('grid-column-end', '-1', 'important');
}
document.querySelector('#all').insertAdjacentHTML('afterend', `<button id="random-tiles" aria-pressed="false">${icon('shuffle')} Random</button>`);
const autoToggle = document.querySelector('#auto-round');
let repeatRounds = 1;
// Whether the current round still accepts bets. Set from chain state each render and read
// by updateMine() to switch between an immediate deployment and a next-round queue.
let bettingOpen = true;
let autoRound = false;
// "Max": size the plan deposit from the wallet balance instead of a manual round count.
// The plan is still prepaid — this just computes how many rounds the balance can fund.
let fundMaxRounds = false;
const GAS_RESERVE_ETH = 0.002; // keep enough back to pay for the transactions themselves
// Auto-claim settles winnings back into the plan balance each round. NOTE: the contract
// forces playsRemaining = UNLIMITED when this is on, so it can't combine with a finite
// round count — the UI mirrors that by switching Rounds to ∞ (see syncAutoControls).
let autoClaimEnabled = false;
let randomMode = false;
const amount = document.querySelector('#amount');
const mineCurrencyToggle = document.querySelector('#mine-currency-toggle');
let amountSolValue = Math.max(0, Number(amount.value || 0));
let mineDisplayCurrency = (() => {
  try { return window.localStorage.getItem('gld-mine-currency') === 'usd' ? 'usd' : 'eth'; }
  catch { return 'eth'; }
})();
const captureMineAmount = () => {
  const shown = Math.max(0, Number(amount.value || 0));
  if (mineDisplayCurrency === 'usd') {
    const price = getSolUsd();
    if (price) amountSolValue = shown / price;
  } else amountSolValue = shown;
};
const paintMineAmount = () => {
  if (!(amountSolValue > 0)) {
    amount.value = '';
    return;
  }
  if (mineDisplayCurrency === 'usd') {
    const price = getSolUsd();
    amount.value = price ? (amountSolValue * price).toFixed(2) : '';
  } else {
    amount.value = String(Number(amountSolValue.toFixed(18)));
  }
};
const paintMineQuickAmounts = () => {
  const price = getSolUsd();
  document.querySelectorAll('.quick-amounts [data-add]').forEach((button) => {
    const solAmount = Number(button.dataset.add);
    button.textContent = mineDisplayCurrency === 'usd'
      ? (price ? `+$${(solAmount * price).toFixed(2)}` : '+$—')
      : `+${button.dataset.add}`;
  });
};
const setMineUsdValue = (element, solAmount) => {
  if (!element) return;
  element.classList.add('mine-currency-value');
  const label = usdFor(solAmount);
  element.dataset.usd = label ?? '$—';
};
const stripMineSolTooltips = () => {
  document.querySelectorAll('.deploy-panel img.sol-icon, .round-summary img.sol-icon')
    .forEach((iconNode) => iconNode.removeAttribute('title'));
};
const syncMineCurrency = () => {
  const usd = mineDisplayCurrency === 'usd';
  document.body.classList.toggle('mine-display-usd', usd);
  syncSummaryHoverLabels();
  if (!mineCurrencyToggle) return;
  mineCurrencyToggle.classList.toggle('active', usd);
  mineCurrencyToggle.setAttribute('aria-pressed', String(usd));
  mineCurrencyToggle.setAttribute('aria-label', usd ? 'Show mining values in SOL' : 'Show mining values in US dollars');
  document.querySelector('.amount-label > span').textContent = usd ? 'USD / tile' : 'SOL / tile';
  amount.setAttribute('aria-label', usd ? 'US dollars per tile' : 'SOL per tile');
  amount.readOnly = usd && !getSolUsd();
  amount.placeholder = amount.readOnly ? 'Price unavailable' : '0.00';
  paintMineQuickAmounts();
};
syncMineCurrency();
const stakeAmount = document.querySelector('#stake-amount');
const notify = (message) => { const toast = document.querySelector('#toast'); toast.textContent = message; toast.classList.add('show'); window.setTimeout(() => toast.classList.remove('show'), 2000); };

/**
 * In-app confirmation for irreversible actions.
 *
 * `window.confirm` renders chrome we do not control: it is titled with the raw origin
 * ("24.138.55:5173 says"), which reads like a phishing prompt on the one screen where the
 * user is being asked to destroy tokens, and it defaults focus to OK.
 *
 * Built on <dialog> rather than a hand-rolled overlay so the focus trap, Escape handling,
 * inert background and ::backdrop come from the platform. Values go in via textContent —
 * never interpolated markup — because the numbers are formatted from chain state.
 *
 * The cancel button takes focus: for an action with no undo, the safe choice is what a
 * reflexive Enter should hit. Resolves false on Escape, backdrop click and cancel alike.
 */
const confirmAction = ({ eyebrow, title, lead, rows = [], confirmLabel, cancelLabel = 'Cancel' }) =>
  new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm-dialog';

    const panel = document.createElement('form');
    panel.method = 'dialog';
    panel.className = 'confirm-panel';

    const add = (tag, className, text) => {
      const el = document.createElement(tag);
      el.className = className;
      if (text !== undefined) el.textContent = text;
      panel.append(el);
      return el;
    };

    if (eyebrow) add('span', 'confirm-eyebrow', eyebrow);
    add('h2', 'confirm-title', title);
    if (lead) add('p', 'confirm-lead', lead);

    if (rows.length) {
      const list = add('dl', 'confirm-rows');
      for (const [label, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.append(dt, dd);
      }
    }

    const actions = add('div', 'confirm-actions');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'confirm-cancel';
    cancel.textContent = cancelLabel;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'confirm-go';
    go.textContent = confirmLabel;
    actions.append(cancel, go);

    dlg.append(panel);
    document.body.append(dlg);

    let answer = false;
    const close = (value) => { answer = value; dlg.close(); };
    cancel.addEventListener('click', () => close(false));
    go.addEventListener('click', () => close(true));
    // A click that lands on the dialog element itself is outside the panel — dismiss.
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(false); });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(answer); });

    dlg.showModal();
    cancel.focus();
  });

/**
 * Wallets we can offer to INSTALL when the device has none.
 *
 * Deliberately short. A long grid of wallets reads as a menu of equals and pushes the
 * decision back onto someone who has just told us, by having nothing installed, that they
 * do not have one yet. These options support Solana and mobile handoff.
 */
const INSTALLABLE_WALLETS = [
  { name: 'Phantom', icon: WALLET_LOGOS.phantom, url: 'https://phantom.com/download', hint: 'Extension · iOS · Android' },
  { name: 'Solflare', icon: null, url: 'https://www.solflare.com/download', hint: 'Extension · iOS · Android' },
  { name: 'Backpack', icon: null, url: 'https://backpack.app/download', hint: 'Extension · iOS · Android' },
];

const isMobileBrowser = () => /android|iphone|ipad|ipod/i.test(navigator.userAgent);

/** Bundled brand mark for a wallet that reports a name but no artwork of its own. */
const brandLogoFor = (name = '') => {
  const key = name.toLowerCase();
  if (key.includes('phantom')) return WALLET_LOGOS.phantom;
  return null;
};

/**
 * Deep links that reopen MYNE inside a wallet app's own browser.
 *
 * On a phone, installing a wallet does not put a provider into Chrome or Safari — extensions
 * are a desktop concept, and a wallet app cannot inject into a browser it does not own. So a
 * mobile visitor who installs a wallet and returns here still sees "no wallet detected", which
 * reads as a bug in the site rather than as the platform rule it is. Every one of these links
 * hands the current URL to the wallet, which opens it in ITS browser, where the provider does
 * exist and normal Solana provider discovery takes over.
 *
 * The proper fix for staying in your own browser is WalletConnect — a real dependency with a
 * project id and relay. These links need neither, and they work today.
 */
const walletDeepLinks = () => {
  const href = window.location.href;
  return [
    { name: 'Phantom', icon: WALLET_LOGOS.phantom, url: `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(window.location.origin)}`, hint: 'Open in app' },
    { name: 'Solflare', icon: null, url: `https://solflare.com/ul/v1/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(window.location.origin)}`, hint: 'Open in app' },
  ];
};

/**
 * The connect sheet: pick from the wallets actually on this device.
 *
 * Resolves the chosen wallet's rdns, or null when dismissed. Registered on the chain module
 * as its wallet chooser, so every `connectWallet()` call site — the header button, MINE,
 * Deploy, chat sign-in — routes through here without knowing it exists.
 *
 * `name` and `icon` come from browser extensions, so neither is trusted: names go in as
 * textContent and icons are only rendered when client.js has confirmed a `data:image/` URI.
 * A wallet that supplies neither still gets a usable row via a monogram.
 */
const walletPicker = (wallets, lastRdns) => new Promise((resolve) => {
  const dlg = document.createElement('dialog');
  dlg.className = 'confirm-dialog wallet-dialog';

  const panel = document.createElement('div');
  panel.className = 'confirm-panel wallet-panel';

  // Three states, not two: wallets found · a phone with none · a desktop with none. The phone
  // case is NOT "install a wallet" — the wallet may well be installed already and simply
  // invisible to this browser, so telling them to install it again is a dead end.
  const mobileNoWallet = !wallets.length && isMobileBrowser();
  const options = wallets.length ? wallets : mobileNoWallet ? walletDeepLinks() : INSTALLABLE_WALLETS;

  const title = document.createElement('h2');
  title.className = 'confirm-title';
  title.textContent = mobileNoWallet ? 'Open in your wallet' : 'Connect';
  const lead = document.createElement('p');
  lead.className = 'confirm-lead';
  lead.textContent = wallets.length
    ? 'Choose a wallet to continue.'
    : mobileNoWallet
      ? 'Phone browsers cannot see wallet apps directly. Reopen MYNE inside a Solana wallet’s browser to connect.'
      : 'No wallet detected in this browser. Install one to continue.';
  panel.append(title, lead);

  const list = document.createElement('div');
  list.className = 'wallet-list';

  const badge = (wallet) => {
    // Order matters: the wallet's OWN icon first (authoritative for the installed build),
    // then our bundled brand mark by name — which is what rescues the legacy
    // injected-provider path, where a provider may announce no artwork.
    const src = wallet.icon || brandLogoFor(wallet.name);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      return img;
    }
    const mono = document.createElement('i');
    mono.className = 'wallet-monogram';
    mono.textContent = (wallet.name || '?').trim().charAt(0).toUpperCase();
    return mono;
  };

  if (wallets.length) {
    for (const wallet of wallets) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'wallet-row';
      const name = document.createElement('b');
      name.textContent = wallet.name || wallet.rdns;
      row.append(badge(wallet), name);
      if (wallet.rdns === lastRdns) {
        const last = document.createElement('small');
        last.textContent = 'LAST USED';
        row.append(last);
      }
      const chevron = document.createElement('span');
      chevron.className = 'wallet-chevron';
      chevron.textContent = '›';
      row.append(chevron);
      row.addEventListener('click', () => { dlg.dataset.pick = wallet.rdns; dlg.close(); });
      list.append(row);
    }
  } else {
    for (const wallet of options) {
      const row = document.createElement('a');
      row.className = 'wallet-row';
      row.href = wallet.url;
      // A deep link must navigate THIS tab — the wallet app hands control back to whichever
      // view opened it, and a background tab is not somewhere the user returns to.
      if (!mobileNoWallet) { row.target = '_blank'; row.rel = 'noreferrer noopener'; }
      // Same badge() as the discovered rows, so a linked wallet and an installed one are
      // rendered identically — only the trailing hint and glyph differ.
      const mono = badge(wallet);
      const name = document.createElement('b');
      name.textContent = wallet.name;
      const hint = document.createElement('small');
      hint.className = 'wallet-hint';
      hint.textContent = wallet.hint;
      const chevron = document.createElement('span');
      chevron.className = 'wallet-chevron';
      chevron.textContent = '↗';
      row.append(mono, name, hint, chevron);
      // Installing is a page away and needs a reload to be detected, so close rather than
      // leave a stale "no wallet" sheet sitting over the app.
      row.addEventListener('click', () => dlg.close());
      list.append(row);
    }
  }
  panel.append(list);

  const foot = document.createElement('p');
  foot.className = 'wallet-foot';
  foot.textContent = wallets.length
    ? 'MYNE never sees your keys. Connecting only shares your address.'
    : mobileNoWallet
      ? 'Each link hands this page to the wallet app. Nothing installed yet? The same links open its store page.'
      : 'Reload this page once your wallet is installed.';
  panel.append(foot);

  dlg.append(panel);
  document.body.append(dlg);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => {
    const pick = dlg.dataset.pick || null;
    dlg.remove();
    resolve(pick);
  });
  dlg.showModal();
});

chain.setWalletChooser(walletPicker);

const stakingRewards = document.querySelector('.stake-rewards');
const stakingHero = document.querySelector('.staking-hero');
const stakeComposer = document.querySelector('.stake-composer');
stakeComposer.querySelector('.stake-amount-label').insertAdjacentHTML('beforebegin', '<div class="stake-mode-tabs" role="tablist" aria-label="Staking action"><button class="active" id="stake-deposit-tab" role="tab" aria-selected="true">Stake</button><button id="stake-withdraw-tab" role="tab" aria-selected="false">Unstake</button></div>');
// Lock-tier chooser (deposit only): keep commitment clear without oversized multipliers.
stakeComposer.querySelector('.stake-mode-tabs').insertAdjacentHTML('afterend',
  '<div class="stake-tier-tabs" id="stake-tier-tabs" role="tablist" aria-label="Lock tier">'
  + '<button id="stake-tier-flex" role="tab" aria-selected="false"><span><b>STANDARD STAKE</b><small>Flexible · withdraw anytime</small></span><strong id="stake-flex-apy">0.0%</strong></button>'
  + '<button class="active" id="stake-tier-burn" role="tab" aria-selected="true"><span><b>STAKE + BURN</b><small>Permanent · MYNE is burned</small></span><strong id="stake-burn-apy">0.0%</strong></button>'
  + '</div>');
stakeComposer.querySelector('.stake-amount').insertAdjacentHTML('afterend', '<div class="stake-quick-actions"><button data-stake-percent="25">25%</button><button data-stake-percent="50">50%</button><button data-stake-percent="75">75%</button><button data-stake-percent="100">MAX</button></div>');
document.querySelector('#claim-stake-rewards').textContent = 'Connect to claim';
document.body.insertAdjacentHTML('beforeend', `
  <dialog class="stake-flex-dialog" id="stake-flex-dialog" aria-labelledby="stake-flex-title">
    <section class="stake-flex-modal">
      <header class="stake-flex-modal-head"><h2 id="stake-flex-title">FLEX</h2><button type="button" data-flex-close aria-label="Close position card">×</button></header>
      <article class="stake-flex-preview" id="stake-flex-preview">
        <div class="stake-flex-assay" aria-hidden="true"><i class="stake-flex-ring outer"></i><i class="stake-flex-ring inner"></i><div class="stake-flex-mining-grid">${Array.from({ length: 25 }, (_, index) => `<i${[2, 5, 9, 12].includes(index) ? ' class="selected"' : ''}></i>`).join('')}</div></div>
        <header><img src="/gld-wordmark.png" alt="MYNE"/></header>
        <div class="stake-flex-hero"><div><span>SOL REWARDS / DAY</span><strong><img src="/solana-mark.svg" alt=""/><b data-flex-day>0.00</b></strong><small data-flex-day-usd>≈ $—</small></div><aside><span>APY</span><strong data-flex-apy>—</strong></aside></div>
        <div class="stake-flex-stats"><span><small>STAKED MYNE</small><strong><img src="/gld-icon-transparent.png" alt=""/><b data-flex-standard>0.00</b></strong></span><span><small>BURNED MYNE</small><strong><img src="/gld-icon-transparent.png" alt=""/><b data-flex-burned>0.00</b></strong></span><span><small>TOTAL SOL RECEIVED</small><strong><img src="/solana-mark.svg" alt=""/><b data-flex-earned>0.00</b></strong></span></div>
        <footer><code data-flex-link>—</code></footer>
      </article>
      <div class="stake-flex-actions"><button type="button" id="stake-flex-download">Download PNG</button><button type="button" id="stake-flex-copy">Copy image</button><a id="stake-flex-x" href="#" target="_blank" rel="noreferrer" aria-label="Share position on X">${icon('x')}</a><a id="stake-flex-tg" href="#" target="_blank" rel="noreferrer" aria-label="Share position on Telegram">${icon('telegram')}</a></div>
    </section>
  </dialog>`);
// About copy: two tiers (Flexible 1× / Burn 5×); rewards are SOL.
document.querySelector('[data-about-panel="staking-model"] .about-lead').textContent = 'Choose standard staking at 1× weight or permanently burn the principal for 5× weight. Both earn SOL from the 8% mining allocation.';
document.querySelector('[data-about-panel="gold-payouts"] .about-lead').textContent = 'Stakers receive 8% of mining deployment in SOL. Trading fees are not enabled in this milestone.';
const goldPayoutsAbout = document.querySelector('[data-about-panel="gold-payouts"]');
if (goldPayoutsAbout) {
  goldPayoutsAbout.querySelector('.flow-diagram > div:first-child strong').textContent = '8% SOL';
  goldPayoutsAbout.querySelectorAll('.gold-staker-stats strong')[1].textContent = '8%';
  goldPayoutsAbout.querySelector('.about-rule-table > div:nth-child(2) strong').textContent = '8% of deployed SOL';
}
const motherlodeAbout = document.querySelector('[data-about-panel="motherlode"]');
if (motherlodeAbout) {
  motherlodeAbout.querySelector('.motherlode-grid > div:nth-child(2) strong').textContent = '2%';
  motherlodeAbout.querySelector('.motherlode-formula > div:last-child strong').textContent = '2% deployed SOL';
}

// Keep the product language explicit: Motherlode is the SOL payment, while
// its paired MYNE allocation is a permanently burn-staked staking bonus.
const motherlodeTip = document.querySelector('#round-reward-tip');
if (motherlodeTip) {
  const labels = motherlodeTip.querySelectorAll('small > span');
  if (labels[0]) labels[0].textContent = 'MOTHERLODE · SOL CLAIMABLE';
  if (labels[1]) labels[1].textContent = 'STAKING BONUS · MYNE BURNED + STAKED';
}
const motherlodePromise = document.querySelector('.promise-card.promise-gold');
if (motherlodePromise) {
  const title = motherlodePromise.querySelector('h2');
  const detail = motherlodePromise.querySelector('p');
  if (title) title.textContent = 'Staking bonus + SOL';
  if (detail) detail.textContent = 'MYNE is burned and staked · SOL is claimable';
}
const stakingModelAbout = document.querySelector('[data-about-panel="staking-model"]');
if (stakingModelAbout) stakingModelAbout.querySelector('.about-statline > span:nth-child(2) strong').textContent = '8% SOL';
const feeAbout = document.querySelector('[data-about-panel="fees"]');
const formerLiquidityLine = [...feeAbout.querySelectorAll('small')].find((line) => line.textContent.includes('Deepen liquidity'));
if (formerLiquidityLine) formerLiquidityLine.remove();
feeAbout.querySelector('.worked-example p').innerHTML = '<b>0.12 SOL</b> is retained: 0.08 staking · 0.02 buyback and burn · 0.02 Motherlode. No admin fee.';
feeAbout.querySelector('.liquidity-callout p').textContent = 'The 8% mining allocation is deposited into MYNE’s on-chain staking reward vault every round.';
const stakingCalculator = document.querySelector('.staking-calculator');
stakingCalculator.hidden = true;

const referralShell = document.querySelector('[data-page="referrals"]');
if (referralShell) {
  // Metrics ARE real now, so keep them visible (the demo build hid them).
  const referralHero = referralShell.querySelector('.referrals-hero');
  if (referralHero) {
    referralHero.querySelector('h1').textContent = 'Referrals.';
    referralHero.querySelector('p')?.remove();
    referralHero.querySelector('.primary-feature-action')?.setAttribute('hidden', '');
  }
  const referralShareSlot = referralShell.querySelector('.share-actions');
  referralShareSlot?.remove();
  referralShell.querySelector('.referral-performance')?.insertAdjacentHTML('afterend', '<div class="referral-flex-actions"><button class="referral-claim-action" id="claim-referral-rewards" disabled>Nothing to claim</button></div>');
}

document.body.insertAdjacentHTML('beforeend', `
  <dialog class="stake-flex-dialog referral-flex-dialog" id="referral-flex-dialog" aria-labelledby="referral-flex-title">
    <section class="stake-flex-modal">
      <header class="stake-flex-modal-head"><h2 id="referral-flex-title">FLEX</h2><button type="button" data-ref-flex-close aria-label="Close referral card">×</button></header>
      <article class="stake-flex-preview" id="referral-flex-preview">
        <div class="stake-flex-assay" aria-hidden="true"><i class="stake-flex-ring outer"></i><i class="stake-flex-ring inner"></i><div class="stake-flex-mining-grid">${Array.from({ length: 25 }, (_, index) => `<i${[1, 6, 12, 18, 23].includes(index) ? ' class="selected"' : ''}></i>`).join('')}</div></div>
        <header><img src="/gld-wordmark.png" alt="MYNE"/></header>
        <div class="stake-flex-hero"><div><span>MYNE EARNED</span><strong><img src="/gld-icon-transparent.png" alt=""/><b data-ref-flex-earned>0.000</b></strong><small data-ref-flex-earned-usd>$— value</small></div><aside><span>REFERRALS</span><strong data-ref-flex-count>0</strong></aside></div>
        <div class="stake-flex-stats"><span><small>ACTIVE</small><strong><b data-ref-flex-active>0</b></strong></span><span><small>MYNE VALUE</small><strong><b data-ref-flex-earned-value>$—</b></strong></span><span><small>NETWORK EARNED</small><strong><img src="/gld-icon-transparent.png" alt=""/><b data-ref-flex-network>0.000</b></strong></span></div>
        <footer><code data-ref-flex-link>—</code></footer>
      </article>
      <div class="stake-flex-actions referral-flex-share-actions"><button type="button" id="ref-flex-download">Download PNG</button><button type="button" id="ref-flex-copy">Copy image</button><a id="ref-flex-x" href="#" target="_blank" rel="noreferrer" aria-label="Share referrals on X">${icon('x')}</a><a id="ref-flex-tg" href="#" target="_blank" rel="noreferrer" aria-label="Share referrals on Telegram">${icon('telegram')}</a></div>
    </section>
  </dialog>`);
const referralFlexDialog = document.querySelector('#referral-flex-dialog');
// Referral sharing uses the main referral link now; the separate FLEX card is retired.
referralFlexDialog?.remove();

const aboutContent = document.querySelector('.about-content');
const aboutNav = document.querySelector('.about-nav');

/* About is protocol documentation, not a landing page. Keep each chapter to named parameters,
   mechanics and constraints; promotional headings, scenarios and calls to action belong elsewhere. */
if (aboutContent && aboutNav) {
  aboutContent.classList.add('about-factual');

  const facts = {
    intro: `
      <span class="eyebrow">01 · PROTOCOL</span><h2>Protocol parameters</h2>
      <div class="about-statline"><span><small>NETWORK</small><strong>SOLANA</strong></span><span><small>TOKEN</small><strong>MYNE</strong></span><span><small>GENESIS</small><strong>${LAUNCH_GENESIS_MYNE}</strong></span><span><small>HARD CAP</small><strong>2,000,000</strong></span></div>
      <div class="about-rule-table"><div><span>Token standard</span><strong>Solana token on Solana</strong><p>Ticker and token name: MYNE.</p></div><div><span>Genesis allocation</span><strong>${LAUNCH_GENESIS_MYNE} MYNE total</strong><p>All ${LAUNCH_LIQUIDITY_MYNE} MYNE is allocated to launch liquidity. No burn-staked supply exists at mint.</p></div><div><span>Post-genesis issuance</span><strong>Mining rounds only</strong><p>New MYNE is emitted through the mining protocol until the hard cap.</p></div></div>`,
    mining: `
      <span class="eyebrow">02 · MINING</span><h2>Mining rounds</h2>
      <div class="about-statline"><span><small>TILES</small><strong>25</strong></span><span><small>BIDDING</small><strong>60 SEC</strong></span><span><small>RESULT</small><strong>5 SEC</strong></span><span><small>BASE REWARD</small><strong>${isPremine ? '0.3' : '1'} MYNE</strong></span></div>
      <div class="about-rule-table"><div><span>Minimum deployment</span><strong>0.05 SOL per round</strong><p>The minimum applies to the total deployment whether 1 or 25 tiles are selected.</p></div><div><span>Tile selection</span><strong>Manual or all tiles</strong><p>One SOL-per-tile amount is applied to every selected tile.</p></div><div><span>Winner selection</span><strong>One tile per round</strong><p>Split and Solo settlement modes are selected with equal probability.</p></div><div><span>Split settlement</span><strong>Proportional to SOL deployed</strong><p>Every miner on the winning tile receives their share of the MYNE reward.</p></div><div><span>Solo settlement</span><strong>One deployment-weighted miner</strong><p>A miner's probability equals their share of SOL on the winning tile.</p></div><div><span>Resolution period</span><strong>Bids enter the next round</strong><p>Mining remains available while the current round resolves.</p></div></div>`,
    'token-flow': `
      <span class="eyebrow">03 · SUPPLY</span><h2>MYNE supply</h2>
      <div class="about-statline"><span><small>GENESIS MINT</small><strong>${LAUNCH_GENESIS_MYNE}</strong></span><span><small>PRE-EXISTING BURN</small><strong>0</strong></span><span><small>LIQUIDITY</small><strong>${LAUNCH_LIQUIDITY_MYNE}</strong></span><span><small>INITIAL MARKET</small><strong>${LAUNCH_MARKET_MYNE}</strong></span></div>
      <div class="about-rule-table"><div><span>Mint allocation</span><strong>${LAUNCH_GENESIS_MYNE} MYNE total</strong><p>No tokens are minted into a protocol-owned burn stake.</p></div><div><span>Initial liquidity</span><strong>${LAUNCH_LIQUIDITY_MYNE} MYNE paired with SOL</strong><p>The full genesis mint forms the market-available supply at launch.</p></div><div><span>Maximum supply</span><strong>2,000,000 MYNE</strong><p>Mining emissions stop at the hard cap.</p></div><div><span>Claimed mining balance</span><strong>90% to claimant</strong><p>The 10% claim fee distributes 9% to unclaimed balances and 1% to the permanent referrer.</p></div></div>`,
    fees: `
      <span class="eyebrow">04 · FEES</span><h2>Fees and allocations</h2>
      <div class="fee-grid detailed-fees"><div><strong>12%</strong><b>Mining deployment</b><small><span>8%</span>Staker SOL rewards</small><small><span>2%</span>MYNE buyback and burn</small><small><span>2%</span>Motherlode</small></div><div><strong>10%</strong><b>MYNE claim</b><small><span>9%</span>Unclaimed MYNE balances</small><small><span>1%</span>Permanent referrer</small></div></div>`,
    'gold-payouts': `
      <span class="eyebrow">05 · REWARDS</span><h2>SOL staking rewards</h2>
      <div class="about-statline"><span><small>REWARD ASSET</small><strong>SOL</strong></span><span><small>MINING SOURCE</small><strong>8%</strong></span><span><small>TRADING SOURCE</small><strong>0%</strong></span><span><small>ADMIN FEE</small><strong>0%</strong></span></div>
      <div class="about-rule-table"><div><span>Mining source</span><strong>8% of deployed SOL</strong><p>Added to the staking reward accumulator every minute.</p></div><div><span>Trading source</span><strong>Deferred</strong><p>No pool-trade fee is enabled in this milestone.</p></div><div><span>Distribution</span><strong>Pro rata staking weight</strong><p>Rewards are shared according to standard and burn-stake weight.</p></div><div><span>Admin fee</span><strong>0%</strong><p>The mining allocation has no administrator share.</p></div></div>`,
    motherlode: `
      <span class="eyebrow">06 · MOTHERLODE</span><h2>Motherlode SOL + staking bonus</h2>
      <div class="about-statline"><span><small>MYNE ACCRUAL</small><strong>0.2 / ROUND</strong></span><span><small>MINING SOL</small><strong>2%</strong></span><span><small>TRADE SOL</small><strong>0%</strong></span><span><small>HIT ODDS</small><strong>1 / 650</strong></span></div>
      <div class="about-rule-table"><div><span>Staking bonus</span><strong>0.2 MYNE × rounds since the previous hit</strong><p>Paid alongside the shared Motherlode SOL reward to that round’s miners, then permanently burned into each recipient’s 5× staking weight.</p></div><div><span>Mining SOL source</span><strong>2% of SOL deployed each round</strong><p>Added to the liquid Motherlode SOL payment balance.</p></div><div><span>Trading SOL source</span><strong>Deferred</strong><p>No pool-trade fee is enabled in this milestone.</p></div><div><span>Payment status</span><strong>SOL claimable · MYNE staked</strong><p>The Motherlode SOL remains claimable; the staking bonus is never liquid or claimable as MYNE.</p></div></div>`,
    'referral-model': `
      <span class="eyebrow">07 · REFERRALS</span><h2>Referral rewards</h2>
      <div class="about-statline"><span><small>REFERRER SHARE</small><strong>1%</strong></span><span><small>UNCLAIMED SHARE</small><strong>9%</strong></span><span><small>ADDITIONAL FEE</small><strong>0%</strong></span><span><small>ATTRIBUTION</small><strong>FIRST VALID</strong></span></div>
      <div class="about-rule-table"><div><span>Attribution</span><strong>Permanent after first valid assignment</strong><p>The referrer attached to a wallet cannot be replaced.</p></div><div><span>Payment event</span><strong>Referred miner claims MYNE</strong><p>The referrer receives 1% of the claimed amount in MYNE.</p></div><div><span>Fee source</span><strong>Existing 10% claim fee</strong><p>The claimant receives 90%; 9% goes to unclaimed balances and 1% to the referrer.</p></div></div>`,
    'staking-model': `
      <span class="eyebrow">08 · STAKING</span><h2>Staking tiers</h2>
      <div class="about-statline"><span><small>STANDARD</small><strong>1×</strong></span><span><small>WITHDRAWAL QUEUE</small><strong>30 DAYS</strong></span><span><small>STAKE + BURN</small><strong>5×</strong></span><span><small>REWARD ASSET</small><strong>SOL</strong></span></div>
      <section class="staking-history about-staking-history" data-staking-chart aria-label="Total MYNE staked over the past 30 days"><header><div><span>STAKED MYNE · 30 DAYS</span><strong data-staking-chart-total>—</strong></div><small>PAST 30 DAYS · ON-CHAIN</small></header><div class="staking-history-plot" data-staking-chart-plot><span>Loading staking history…</span></div><footer><span data-staking-chart-start>—</span><span>NOW</span></footer></section>
      <div class="about-rule-table"><div><span>Standard stake</span><strong>1× reward weight</strong><p>An unstake request starts a 30-day withdrawal queue.</p></div><div><span>Stake + burn</span><strong>5× reward weight</strong><p>The deposited MYNE is permanently burned and cannot be recovered.</p></div><div><span>Staking bonus</span><strong>Automatic 5× burn stake</strong><p>The bonus is always paired with a Motherlode hit and is never issued as liquid MYNE.</p></div><div><span>Rewards</span><strong>SOL from 8% mining fee</strong><p>Rewards accrue by staking weight and remain claimable.</p></div></div>`,
  };

  Object.entries(facts).forEach(([name, markup]) => {
    const panel = aboutContent.querySelector(`[data-about-panel="${name}"]`);
    if (panel) panel.innerHTML = markup;
  });

  const navLabels = {
    intro: 'Protocol', mining: 'Mine',
    'token-flow': 'Supply', fees: 'Fees', 'gold-payouts': 'Rewards',
    motherlode: 'Motherlode', 'referral-model': 'Referrals', 'staking-model': 'Staking',
  };
  Object.entries(navLabels).forEach(([name, label]) => {
    const button = aboutNav.querySelector(`[data-about-section="${name}"]`);
    if (button) button.textContent = label;
  });
}

/**
 * About contents: a sidebar on desktop, a dropdown on phones.
 *
 * The mobile treatment was a horizontally scrolling strip of ten chips, which hides most of
 * its own options off-screen — you cannot see that "Staking" exists without swiping, and the
 * active chip scrolls out of view as you read. A dropdown shows where you are in one line
 * and every place you could go in one tap.
 *
 * The buttons move into a wrapper so the open list can be positioned as a single panel.
 * `display: contents` on that wrapper keeps the desktop sidebar's flex column byte-identical
 * — the wrapper only becomes a box at the mobile breakpoint.
 */
const aboutNavToggle = document.createElement('button');
if (aboutNav) {
  const list = document.createElement('div');
  list.className = 'about-nav-list';
  list.append(...aboutNav.querySelectorAll('button[data-about-section]'));

  aboutNavToggle.type = 'button';
  aboutNavToggle.className = 'about-nav-toggle';
  aboutNavToggle.setAttribute('aria-expanded', 'false');
  aboutNavToggle.setAttribute('aria-haspopup', 'true');
  aboutNavToggle.innerHTML = '<b></b><i aria-hidden="true">⌄</i>';
  aboutNav.append(aboutNavToggle, list);

  const closeAboutNav = () => {
    aboutNav.classList.remove('open');
    aboutNavToggle.setAttribute('aria-expanded', 'false');
  };
  aboutNavToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = aboutNav.classList.toggle('open');
    aboutNavToggle.setAttribute('aria-expanded', String(open));
  });
  // Collapse on pick. The desktop sidebar never opens, so this is inert there.
  list.addEventListener('click', closeAboutNav);
  document.addEventListener('click', (event) => {
    if (!aboutNav.contains(event.target)) closeAboutNav();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAboutNav(); });
}

// Live staking state, loaded from BullionStaking on the chain.
let stakingState = null;
let stakingMetricsState = null;

const updateStake = () => {
  const principal = Math.max(0, Number(stakeAmount.value || 0));
  const s = stakingState;
  const isBurn = stakeMode === 'deposit' && stakeTier === TIER_BURN;
  const mult = isBurn ? 5 : 1;
  // Weight (points), not principal, drives rewards. Preview the position AFTER this action.
  const weight = s ? Number(chain.format.solIcon(s.weight)) : 0;
  const totalWeight = s ? Number(chain.format.solIcon(s.totalWeight)) : 0;
  const addWeight = principal * mult;
  const projected = stakeMode === 'deposit' ? weight + addWeight : Math.max(0, weight - principal);
  const projTotal = stakeMode === 'deposit' ? totalWeight + addWeight : Math.max(0, totalWeight - principal);
  // Staked principal — flexible plus burned, previewed AFTER this action like the two rows below
  // it. The withdrawal terms this row used to carry are still stated on the composer (the policy
  // box switches between "30-day withdrawal queue" and "Principal burned") and in the caution
  // line under the submit button, so nothing is lost by showing the position here instead.
  const stakedNow = s
    ? Number(chain.format.solIcon(s.flexStaked)) + Number(chain.format.solIcon(s.burnStaked))
    : 0;
  const projectedStaked = stakeMode === 'deposit'
    ? stakedNow + principal
    : Math.max(0, stakedNow - principal);
  const flexEl = document.querySelector('#stake-flex');
  const burnEl = document.querySelector('#stake-burn');
  if (flexEl) flexEl.textContent = chain.format.solIcon(s?.flexStaked ?? 0n, 2);
  if (burnEl) burnEl.textContent = chain.format.solIcon(s?.burnStaked ?? 0n, 2);
  // The policy box reflects the selected tier: 30-day queue (standard) vs permanent burn.
  const policy = stakeComposer.querySelector('.unstake-policy');
  if (policy) {
    policy.querySelector('i').textContent = isBurn ? '5×' : '30';
    policy.querySelector('span').textContent = isBurn ? 'PERMANENT' : 'UNSTAKING';
    policy.querySelector('b').textContent = isBurn ? 'Principal burned' : '30-day withdrawal queue';
    policy.querySelector('p').textContent = isBurn
      ? 'Your MYNE is burned permanently for a 5× reward share that never unlocks.'
      : 'Request withdrawal at any time. Your MYNE becomes claimable 30 days later.';
  }
  document.querySelector('#stake-weight').textContent = projected.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.querySelector('#stake-share').textContent = `${(projTotal > 0 ? (projected / projTotal) * 100 : 0).toFixed(4)}%`;

  // Cap the input at wallet balance (deposit) or flexible-staked principal (withdraw).
  const max = s ? Number(chain.format.solIcon(stakeMode === 'deposit' ? s.walletBullion : s.flexStaked)) : 0;
  const ballabel = stakeComposer.querySelector('.stake-amount-label small');
  if (ballabel) ballabel.textContent = `${chain.format.solIcon(s ? (stakeMode === 'deposit' ? s.walletBullion : s.flexStaked) : 0n)} ${stakeMode === 'deposit' ? 'available' : 'staked'}`;

  const submit = document.querySelector('#stake-submit');
  const overMax = principal > max + 1e-9;
  submit.classList.toggle('ready', principal > 0 && !overMax);
  submit.textContent = !chain.state.account ? 'Connect wallet'
    : principal <= 0 ? 'Enter an amount'
      : overMax ? `Only ${chain.format.solIcon(stakeMode === 'deposit' ? s.walletBullion : s.flexStaked, 2)} available`
        : stakeMode !== 'deposit' ? `Request unstake ${principal.toLocaleString()}`
          : isBurn ? `Burn ${principal.toLocaleString()} MYNE for 5×`
            : `Stake ${principal.toLocaleString()} MYNE`;
};

const renderStakingRewards = () => {
  const s = stakingState;
  // Staker revenue accrues in the same SOL accumulator from the 8% mining allocation.
  const eth_ = s ? chain.format.ethSmart(s.pendingEth) : '0.00';
  const lifetimeEth = s ? chain.format.ethSmart(s.lifetimeEth) : '0.00';
  animateSolReadout('#stake-claimable-eth', eth_);
  animateSolReadout('#stake-lifetime-eth', lifetimeEth);
  const updatedEl = document.querySelector('#stake-reward-updated');
  if (updatedEl) updatedEl.textContent = chain.state.account
    ? `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · updates live`
    : 'Connect a wallet to see your rewards';

  // Migration safety only: stock balances credited before SOL mode stay claimable, but the old
  // basket is not advertised to new stakers and does not participate in the current APR.
  const basket = stakingRewards.querySelector('.stock-reward-basket');
  const owned = (s?.stocks ?? []).filter((x) => x.amount > 0n);
  if (basket) {
    basket.hidden = owned.length === 0;
    const head = basket.querySelector('header b');
    if (head) head.textContent = `${owned.length} ASSET${owned.length === 1 ? '' : 'S'}`;
    let list = basket.querySelector('.stock-reward-list');
    if (owned.length) {
      if (!list) {
        list = document.createElement('div');
        list.className = 'stock-reward-list';
        basket.appendChild(list);
      }
      list.innerHTML = owned
        .map((x) => `<span><small>${x.symbol}</small><b>${chain.format.ethSmart(x.amount)}</b><i>legacy reward</i></span>`)
        .join('');
    } else {
      list?.remove();
    }
  }

  const claimBtn = document.querySelector('#claim-stake-rewards');
  const has = s && (s.pendingEth > 0n || s.hasClaimableStocks);
  claimBtn.disabled = !has;
  claimBtn.textContent = !chain.state.account ? 'Connect to claim'
    : !has ? 'Nothing to claim'
    : s.pendingEth > 0n
      ? `Claim ${eth_} SOL${owned.length ? ' + legacy rewards' : ''}`
      : 'Claim legacy stock rewards';

  // Unstake queue status (matured + cooling), with a withdraw button when something matured.
  const box = document.querySelector('#unstake-status');
  if (box) {
    const claimable = s ? s.unstakeClaimable : 0n;
    const cooling = s ? s.unstakePending : 0n;
    box.hidden = !(claimable > 0n || cooling > 0n);
    box.innerHTML = `
      ${cooling > 0n ? `<div class="unstake-line"><span>Cooling down (30-day)</span><b>${chain.format.solIcon(cooling)} MYNE</b></div>` : ''}
      ${claimable > 0n ? `<div class="unstake-line matured"><span>Ready to withdraw</span><b>${chain.format.solIcon(claimable)} MYNE</b></div><button id="withdraw-unstaked">Withdraw ${chain.format.solIcon(claimable)}</button>` : ''}`;
  }
  updateStakeFlexCard();
};

const solReadoutAnimations = new Map();
const animateSolReadout = (selector, value) => {
  const node = document.querySelector(selector);
  if (!node) return;
  const target = Number(value);
  if (!Number.isFinite(target)) { node.textContent = value; return; }
  const previous = Number(node.textContent?.replace(/[^0-9.-]/g, ''));
  const start = Number.isFinite(previous) ? previous : target;
  const oldAnimation = solReadoutAnimations.get(selector);
  if (oldAnimation) cancelAnimationFrame(oldAnimation);
  if (Math.abs(target - start) < 0.000001) { node.textContent = value; return; }
  const started = performance.now();
  const duration = 720;
  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - ((1 - progress) ** 3);
    node.textContent = (start + ((target - start) * eased)).toFixed(2);
    if (progress < 1) solReadoutAnimations.set(selector, requestAnimationFrame(step));
    else { solReadoutAnimations.delete(selector); node.textContent = value; }
  };
  solReadoutAnimations.set(selector, requestAnimationFrame(step));
};

const setMetric = (id, text) => {
  const el = document.querySelector(id);
  if (el) el.textContent = text;
};

const compactStaked = (value) => value >= 1000
  ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  : value.toLocaleString(undefined, { minimumFractionDigits: value < 10 ? 2 : 0, maximumFractionDigits: 2 });

const renderStakingHistory = ({ points, current }) => {
  const hosts = [...document.querySelectorAll('[data-staking-chart]')];
  if (!hosts.length || !points?.length) return;
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const maxTime = Math.max(Math.floor(Date.now() / 1000), sorted.at(-1).time);
  const minTime = maxTime - (30 * 24 * 60 * 60);
  const beforeWindow = [...sorted].reverse().find((point) => point.time <= minTime);
  const visible = sorted.filter((point) => point.time > minTime && point.time <= maxTime);
  // Carry the last known balance into the left edge and the current balance into NOW. This keeps
  // quiet periods honest: a month without a stake event is a flat line, not an empty chart.
  const chartPoints = [
    { time: minTime, value: beforeWindow?.value ?? visible[0]?.value ?? current },
    ...visible,
    { time: maxTime, value: current },
  ].filter((point, index, all) => index === 0 || point.time !== all[index - 1].time);
  const maxValue = Math.max(1, ...chartPoints.map((point) => point.value));
  const xFor = (point) => 12 + ((point.time - minTime) / (maxTime - minTime)) * 776;
  const yFor = (point) => 108 - (point.value / maxValue) * 94;
  let line = `M ${xFor(chartPoints[0]).toFixed(2)} ${yFor(chartPoints[0]).toFixed(2)}`;
  for (let i = 1; i < chartPoints.length; i += 1) {
    line += ` H ${xFor(chartPoints[i]).toFixed(2)} V ${yFor(chartPoints[i]).toFixed(2)}`;
  }
  const area = `${line} V 112 H 12 Z`;
  const startDate = new Date(minTime * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const currentLabel = `${compactStaked(current)} MYNE`;

  hosts.forEach((host, index) => {
    host.querySelector('[data-staking-chart-total]').textContent = currentLabel;
    host.querySelector('[data-staking-chart-start]').textContent = startDate.toUpperCase();
    const gradientId = `stake-area-${index}`;
    host.querySelector('[data-staking-chart-plot]').innerHTML = `
      <svg viewBox="0 0 800 120" role="img" aria-label="Staked MYNE over the past 30 days, from ${compactStaked(chartPoints[0].value)} to ${currentLabel}">
        <title>Total MYNE staked over the past 30 days</title>
        <defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9edff" stop-opacity=".22"/><stop offset=".55" stop-color="#efc8f4" stop-opacity=".08"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>
        <g class="staking-history-grid"><path d="M12 14H788"/><path d="M12 61H788"/><path d="M12 108H788"/></g>
        <path class="staking-history-area" d="${area}" fill="url(#${gradientId})"/>
        <path class="staking-history-line" d="${line}"/>
        <circle class="staking-history-last" cx="${xFor(chartPoints.at(-1)).toFixed(2)}" cy="${yFor(chartPoints.at(-1)).toFixed(2)}" r="3"/>
      </svg>`;
  });
};

let stakingHistoryFetchedAt = 0;
const STAKING_HISTORY_STALE_MS = 10_000;
const refreshStakingHistory = async () => {
  if (Date.now() - stakingHistoryFetchedAt < STAKING_HISTORY_STALE_MS) return;
  try {
    renderStakingHistory(await readStakingHistory());
    stakingHistoryFetchedAt = Date.now();
  } catch (error) {
    console.warn('staking history failed', error);
    document.querySelectorAll('[data-staking-chart-plot]').forEach((plot) => {
      plot.innerHTML = '<span>History temporarily unavailable</span>';
    });
  }
};

/**
 * The four pool-wide tiles. Kept in its own try/catch and awaited separately from readStaking so a
 * slow or failing log scan can never stop the staking panel itself from rendering — the tiles just
 * hold their last value (or the em dash they start with).
 */
const refreshStakingMetrics = async () => {
  try {
    const m = await readStakingMetrics();
    stakingMetricsState = m;
    // A bare dash reads as "broken" and sends people looking for a bug. `aprStatus` already says
    // WHICH input is missing, so show that instead — it is the difference between "this is down"
    // and "this needs another few hours of history".
    const APR_PENDING = { price: '—', stake: 'LOW STAKE', window: '< 30M' };
    const formatApy = (value) => value >= 1000
      ? `${Math.round(value).toLocaleString()}%`
      : `${value.toFixed(1)}%`;
    const formatHeaderApy = (value) => value >= 1000
      ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k%`
      : formatApy(value);
    const aprText = m.aprPct == null
      ? (APR_PENDING[m.aprStatus] ?? '—')
      : formatApy(m.aprPct);
    // The header promotes the protocol's primary staking choice, not the 1× flexible baseline.
    // Keep it pinned to Stake + Burn's 5× figure regardless of the tier selected in the composer.
    const headerAprText = m.aprPct == null ? aprText : formatHeaderApy(m.aprPct * 5);
    setMetric('#metric-apr', aprText);
    setMetric('#header-staking-apr', headerAprText);
    setMetric('#stake-flex-apy', m.aprPct == null ? '0.0%' : formatApy(m.aprPct));
    setMetric('#stake-burn-apy', m.aprPct == null ? '0.0%' : formatApy(m.aprPct * 5));
    setMetric('#metric-staked', m.totalStakedPrincipal.toLocaleString(undefined, { maximumFractionDigits: 2 }));
    const poolText = m.rewardMode === 'eth'
      ? `${m.rewardsPoolEth < 0.001 && m.rewardsPoolEth > 0
        ? m.rewardsPoolEth.toFixed(6)
        : m.rewardsPoolEth.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 4 })}`
      : 'MIGRATION';
    if (m.rewardMode === 'eth') animateSolReadout('#metric-pool', poolText);
    else setMetric('#metric-pool', poolText);
    const modeWarning = document.querySelector('#staking-mode-warning');
    if (modeWarning) {
      modeWarning.hidden = m.rewardMode === 'eth';
      modeWarning.textContent = m.queuedLegacyStockEth > 0
        ? `On-chain SOL migration pending · ${m.queuedLegacyStockEth.toFixed(6)} SOL remains in the legacy queue.`
        : 'On-chain SOL reward migration pending.';
    }
    setMetric('#metric-stakers', String(m.stakers));
    const apr = document.querySelector('#metric-apr')?.closest('article');
    const headerApr = document.querySelector('.header-apr');
    if (headerApr) {
      headerApr.setAttribute('aria-label', `Open Stake + Burn, current APY ${headerAprText}`);
      headerApr.title = headerAprText === '—' ? 'Open Stake + Burn' : `Stake + Burn APY ${headerAprText}`;
    }
    if (apr) {
      // Every null case used to show the "pool could not be read" message, including the two cases
      // where the pool reads fine. `aprStatus` distinguishes them — use it.
      const aprReason = {
        price: 'APY needs a live MYNE/SOL pool price; the pool could not be read.',
        stake: `APY is published once at least ${m.aprMinWeightGld.toLocaleString()} MYNE of weight is staked — `
          + 'below that a single staker would swing the figure wildly.',
        window: 'APY is calculated from the latest 30-minute SOL reward window and will appear after the first sample.',
      };
      apr.title = m.aprPct == null
        ? (aprReason[m.aprStatus] ?? aprReason.price)
        : `Estimate. Annualised from the latest ${Math.max(1, Math.round(m.aprWindowDays * 1440))}-minute SOL reward window, `
          + 'divided by total staked weight and priced off the live MYNE/SOL pool. '
          + 'Rewards vary with mining and trade volume, so this moves.';
    }
    updateStakeFlexCard();
  } catch (error) {
    console.warn('staking metrics failed', error);
  }
};

const refreshStaking = async () => {
  void refreshStakingMetrics();
  void refreshStakingHistory();
  try {
    stakingState = await readStaking(chain.state.account);
    updateStake();
    renderStakingRewards();
  } catch (error) {
    console.warn('staking refresh failed', error);
  }
};

let stakeMode = 'deposit';
let stakeTier = TIER_BURN; // Burn (5×) is the encouraged default; standard remains reversible.
const setStakeMode = (mode) => {
  stakeMode = mode;
  document.querySelector('#stake-deposit-tab').classList.toggle('active', mode === 'deposit');
  document.querySelector('#stake-withdraw-tab').classList.toggle('active', mode === 'withdraw');
  document.querySelector('#stake-deposit-tab').setAttribute('aria-selected', String(mode === 'deposit'));
  document.querySelector('#stake-withdraw-tab').setAttribute('aria-selected', String(mode === 'withdraw'));
  // The lock-tier chooser only applies when depositing.
  document.querySelector('#stake-tier-tabs').hidden = mode !== 'deposit';
  updateStake();
};
const setStakeTier = (tier) => {
  stakeTier = tier;
  document.querySelector('#stake-tier-flex').classList.toggle('active', tier === TIER_FLEX);
  document.querySelector('#stake-tier-burn').classList.toggle('active', tier === TIER_BURN);
  document.querySelector('#stake-tier-flex').setAttribute('aria-selected', String(tier === TIER_FLEX));
  document.querySelector('#stake-tier-burn').setAttribute('aria-selected', String(tier === TIER_BURN));
  updateStake();
};
document.querySelector('#stake-deposit-tab').addEventListener('click', () => setStakeMode('deposit'));
document.querySelector('#stake-withdraw-tab').addEventListener('click', () => setStakeMode('withdraw'));
document.querySelector('#stake-tier-flex').addEventListener('click', () => setStakeTier(TIER_FLEX));
document.querySelector('#stake-tier-burn').addEventListener('click', () => setStakeTier(TIER_BURN));
document.querySelectorAll('[data-stake-percent]').forEach((button) => button.addEventListener('click', () => {
  // Percentage of the relevant balance: wallet (deposit) or flexible-staked (withdraw).
  const basis = stakingState ? (stakeMode === 'deposit' ? stakingState.walletBullion : stakingState.flexStaked) : 0n;
  const pct = BigInt(button.dataset.stakePercent);
  stakeAmount.value = chain.format.solIcon((basis * pct) / 100n);
  calculatorAmount.value = stakeAmount.value;
  updateStake();
  updateProjection();
}));

const calculatorAmount = document.querySelector('#calculator-amount');
// Live referral link. Becomes the connected wallet's own link once connected; before that
// it's the plain mine URL (sharing it referral-free rather than sharing a fake address).
const REF_BASE = `${window.location.origin}/#mine`;
let referralUrl = REF_BASE;
const referralLinkFor = (account) => account ? `${REF_BASE}?ref=${account}` : REF_BASE;
// Display form: no scheme, address truncated. Used by the referral panel, the projection card and
// the PNG that card exports — all three shipped the same hardcoded `bullion.rhc/mine?ref=0x3iP4`.
const referralShortLink = (account) => {
  const base = REF_BASE.replace(/^https?:\/\//, '');
  return account ? `${base}?ref=${chain.format.short(account)}` : base;
};
// ── FLEX · live, shareable staking position card -------------------------------------------
const stakeFlexDialog = document.querySelector('#stake-flex-dialog');
const stakeFlexNumber = (value, digits = 3) => Number(value || 0).toLocaleString(undefined, {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const stakeFlexApy = (value) => value == null
  ? '—'
  : value >= 1000 ? `${Math.round(value).toLocaleString()}%` : `${value.toFixed(1)}%`;

const stakeFlexValues = () => {
  const state = stakingState;
  const metrics = stakingMetricsState;
  const standard = Number(chain.format.solIcon(state?.flexStaked ?? 0n));
  const burned = Number(chain.format.solIcon(state?.burnStaked ?? 0n));
  const principal = standard + burned;
  const weight = Number(chain.format.solIcon(state?.weight ?? 0n));
  const multiplier = principal > 0 ? weight / principal : 5;
  const dailyPool = metrics?.aprWindowDays > 0 ? metrics.rewardsToStakersEth / metrics.aprWindowDays : 0;
  const daily = dailyPool * ((state?.share ?? 0) / 100);
  const dailyUsdRaw = daily === 0 ? '$0.00' : usdFor(daily);
  return {
    standard,
    burned,
    // Social proof should show SOL actually received, not the private balance still waiting to be
    // claimed. Pending SOL stays on the Stake page and never leaks into the public FLEX card.
    earned: chain.format.ethSmart(state?.claimedEth ?? 0n),
    apy: metrics?.aprPct == null ? null : metrics.aprPct * multiplier,
    daily,
    dailyUsd: dailyUsdRaw?.startsWith('<') ? dailyUsdRaw : dailyUsdRaw ? `≈ ${dailyUsdRaw}` : '≈ $—',
    referral: referralLinkFor(chain.state.account),
    shortReferral: REF_BASE.replace(/^https?:\/\//, '').replace(/\/#mine$/, ''),
  };
};

const updateStakeFlexCard = () => {
  if (!stakeFlexDialog) return;
  const data = stakeFlexValues();
  const set = (selector, value) => {
    const element = stakeFlexDialog.querySelector(selector);
    if (element) element.textContent = value;
  };
  set('[data-flex-apy]', stakeFlexApy(data.apy));
  set('[data-flex-day]', stakeFlexNumber(data.daily, 2));
  set('[data-flex-day-usd]', data.dailyUsd);
  set('[data-flex-standard]', stakeFlexNumber(data.standard, 2));
  set('[data-flex-burned]', stakeFlexNumber(data.burned, 2));
  set('[data-flex-earned]', data.earned);
  set('[data-flex-link]', data.shortReferral);
  const text = `My MYNE stake earns ${stakeFlexNumber(data.daily, 2)} SOL per day at ${stakeFlexApy(data.apy)} APY · ${data.earned} SOL received.`;
  stakeFlexDialog.querySelector('#stake-flex-x').href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(data.referral)}`;
  stakeFlexDialog.querySelector('#stake-flex-tg').href = `https://t.me/share/url?url=${encodeURIComponent(data.referral)}&text=${encodeURIComponent(text)}`;
};

const createStakeFlexCard = async () => {
  const data = stakeFlexValues();
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#08090a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Reuse the landing hero's actual visual language: dotted assay field, concentric rings and a
  // complete 5×5 mining board with several pearlescent selections.
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,.09)';
  for (let x = 664; x < 1190; x += 13) {
    for (let y = 18; y < 520; y += 13) {
      ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 2;
  [310, 225, 145].forEach((radius) => {
    ctx.beginPath(); ctx.arc(950, 245, radius, 0, Math.PI * 2); ctx.stroke();
  });
  const fieldPearl = ctx.createLinearGradient(740, 54, 1158, 472);
  fieldPearl.addColorStop(0, '#fff2b2');
  fieldPearl.addColorStop(.28, '#83ecff');
  fieldPearl.addColorStop(.56, '#776bff');
  fieldPearl.addColorStop(.78, '#f36ee5');
  fieldPearl.addColorStop(1, '#ffffff');
  const selectedTiles = new Set([2, 5, 9, 12]);
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const index = row * 5 + column;
      const x = 740 + column * 86;
      const y = 54 + row * 86;
      ctx.fillStyle = 'rgba(10,10,12,.76)';
      ctx.beginPath(); ctx.roundRect(x, y, 74, 74, 9); ctx.fill();
      ctx.strokeStyle = selectedTiles.has(index) ? fieldPearl : 'rgba(255,255,255,.17)';
      ctx.lineWidth = selectedTiles.has(index) ? 3 : 1.5;
      ctx.beginPath(); ctx.roundRect(x, y, 74, 74, 9); ctx.stroke();
    }
  }
  ctx.restore();

  const pearl = ctx.createLinearGradient(34, 0, 1166, 0);
  pearl.addColorStop(0, '#fff2b2');
  pearl.addColorStop(.28, '#83ecff');
  pearl.addColorStop(.56, '#776bff');
  pearl.addColorStop(.78, '#f36ee5');
  pearl.addColorStop(1, '#ffffff');
  ctx.strokeStyle = pearl;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(20, 20, 1160, 590, 28);
  ctx.stroke();

  const [wordmark, ethLogo, gldLogo] = await Promise.all(['/gld-wordmark.png', '/solana-mark.svg', '/gld-icon-transparent.png'].map(async (src) => {
    const image = new Image(); image.src = src; await image.decode(); return image;
  }));
  ctx.drawImage(wordmark, 60, 52, 158, 57);
  ctx.fillStyle = '#898c92';
  ctx.font = '700 17px "DM Sans", sans-serif';
  ctx.fillText('SOL REWARDS / DAY', 62, 179);
  ctx.drawImage(ethLogo, 62, 204, 66, 66);
  ctx.fillStyle = '#ffffff';
  ctx.font = '750 82px "DM Sans", sans-serif';
  ctx.fillText(stakeFlexNumber(data.daily, 2), 148, 267);
  ctx.fillStyle = '#9a9da3';
  ctx.font = '650 20px "DM Sans", sans-serif';
  ctx.fillText(data.dailyUsd, 148, 304);
  ctx.fillStyle = 'rgba(5,5,7,.82)';
  ctx.beginPath();
  ctx.roundRect(790, 140, 368, 145, 16);
  ctx.fill();
  ctx.fillStyle = pearl;
  ctx.font = '850 66px "DM Sans", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(stakeFlexApy(data.apy), 1138, 250);
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 22px "DM Sans", sans-serif';
  ctx.fillText('APY', 1138, 184);
  ctx.textAlign = 'left';

  const stats = [
    ['STAKED MYNE', stakeFlexNumber(data.standard, 2), gldLogo],
    ['BURNED MYNE', stakeFlexNumber(data.burned, 2), gldLogo],
    ['TOTAL SOL RECEIVED', data.earned, ethLogo],
  ];
  stats.forEach(([label, value, valueIcon], index) => {
    const x = 62 + index * 360;
    ctx.fillStyle = '#7f8288';
    ctx.font = '700 15px "DM Sans", sans-serif';
    ctx.fillText(label, x, 410);
    ctx.fillStyle = '#f4f4f5';
    ctx.font = '720 28px "DM Sans", sans-serif';
    ctx.drawImage(valueIcon, x, 426, 28, 28);
    ctx.fillText(value, x + 39, 455);
  });
  ctx.strokeStyle = 'rgba(255,255,255,.09)';
  ctx.beginPath(); ctx.moveTo(62, 505); ctx.lineTo(1138, 505); ctx.stroke();
  ctx.fillStyle = '#8d9096';
  ctx.font = '650 17px "DM Sans", sans-serif';
  ctx.fillText('MYNE · SOLANA', 62, 558);
  ctx.font = '600 16px "Roboto Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(data.shortReferral, 1138, 558);
  ctx.textAlign = 'left';
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
};

const downloadStakeFlexCard = async () => {
  const blob = await createStakeFlexCard();
  if (!blob) return notify('Could not create position card');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gld-staking-position.png';
  link.click();
  URL.revokeObjectURL(url);
};

const createReferralFlexCard = async () => {
  const s = referralStats;
  const earned = s ? chain.format.solIcon(s.lifetime) : '0.000';
  const referrals = String(s?.referrals ?? 0);
  const active = String(s?.active ?? 0);
  const link = referralShortLink(chain.state.account);
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#08090a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const spectrum = ctx.createLinearGradient(30, 0, 1170, 0);
  spectrum.addColorStop(0, '#fff2b2'); spectrum.addColorStop(.28, '#83ecff');
  spectrum.addColorStop(.56, '#776bff'); spectrum.addColorStop(.78, '#f36ee5'); spectrum.addColorStop(1, '#fff');
  ctx.strokeStyle = spectrum; ctx.lineWidth = 4; ctx.beginPath(); ctx.roundRect(20, 20, 1160, 590, 28); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '760 58px "DM Sans", sans-serif'; ctx.fillText('MYNE REFERRALS', 62, 110);
  ctx.fillStyle = '#8f9299'; ctx.font = '700 18px "DM Sans", sans-serif'; ctx.fillText('MYNE EARNED', 62, 178);
  ctx.fillStyle = '#fff'; ctx.font = '760 82px "DM Sans", sans-serif'; ctx.fillText(earned, 62, 265);
  ctx.fillStyle = '#8f9299'; ctx.font = '700 18px "DM Sans", sans-serif'; ctx.fillText('REFERRALS', 850, 178);
  ctx.fillStyle = spectrum; ctx.font = '850 76px "DM Sans", sans-serif'; ctx.fillText(referrals, 850, 265);
  const stats = [['ACTIVE', active], ['NETWORK EARNED', earned], ['INVITE & EARN', '1% MYNE']];
  stats.forEach(([label, value], index) => {
    const x = 62 + index * 360;
    ctx.fillStyle = '#7f8288'; ctx.font = '700 15px "DM Sans", sans-serif'; ctx.fillText(label, x, 410);
    ctx.fillStyle = '#f4f4f5'; ctx.font = '720 30px "DM Sans", sans-serif'; ctx.fillText(value, x, 455);
  });
  ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.beginPath(); ctx.moveTo(62, 505); ctx.lineTo(1138, 505); ctx.stroke();
  ctx.fillStyle = '#8d9096'; ctx.font = '600 16px "Roboto Mono", monospace'; ctx.fillText('MYNE · SOLANA', 62, 558); ctx.textAlign = 'right'; ctx.fillText(link, 1138, 558); ctx.textAlign = 'left';
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
};

const downloadReferralFlexCard = async () => {
  const blob = await createReferralFlexCard();
  if (!blob) return notify('Could not create referral card');
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = 'myne-referrals.png'; link.click(); URL.revokeObjectURL(url);
};

document.querySelector('#stake-flex-card')?.addEventListener('click', () => {
  updateStakeFlexCard();
  stakeFlexDialog.showModal();
});
stakeFlexDialog?.querySelector('[data-flex-close]')?.addEventListener('click', () => stakeFlexDialog.close());
stakeFlexDialog?.addEventListener('click', (event) => { if (event.target === stakeFlexDialog) stakeFlexDialog.close(); });
stakeFlexDialog?.querySelector('#stake-flex-download')?.addEventListener('click', downloadStakeFlexCard);
stakeFlexDialog?.querySelector('#stake-flex-copy')?.addEventListener('click', async () => {
  const blob = await createStakeFlexCard();
  if (!blob) return notify('Could not create position card');
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    notify('Position card copied');
  } catch {
    await downloadStakeFlexCard();
    notify('Card downloaded');
  }
});
stakeFlexDialog?.querySelectorAll('#stake-flex-x, #stake-flex-tg').forEach((shareLink) => {
  shareLink.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!chain.state.account) return notify('Connect wallet to share your FLEX card and referral link');

    // A website cannot inject an attachment into another origin's composer. Open the correct
    // platform synchronously (so popup blockers allow it), then put the PNG on the clipboard for
    // a single paste. The platform URL already contains this wallet's full referral URL.
    const shareWindow = window.open(shareLink.href, '_blank', 'noopener,noreferrer');
    const blob = await createStakeFlexCard();
    if (!blob) return notify('Could not create position card');
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notify('FLEX image copied · paste it into the post');
    } catch {
      await downloadStakeFlexCard();
      notify('FLEX image downloaded · attach it to the post');
    }
    if (!shareWindow) notify('Allow popups to open the share window');
  });
});

const REF_SHARE_TEXT = 'Mine scarce MYNE on Solana';
// Legacy hidden calculator: both components are SOL-denominated after the reward migration.
const projectionRates = { bullionUsd: 1500, ethUsd: 3451.72, goldUsd: 3451.72, ethApr: .084, goldApr: .10 };
let projectionDays = 30;
let latestProjection = { principal: 1000, eth: 0, gold: 0, ethUsd: 0, goldUsd: 0 };
const rewardAmount = (principal, apr, days, assetUsd) => (principal * projectionRates.bullionUsd * apr * days / 365) / assetUsd;
const compactAmount = (value, digits = 3) => Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

const updateProjection = () => {
  const principal = Math.max(0, Number(calculatorAmount.value || 0));
  const ethReward = rewardAmount(principal, projectionRates.ethApr, projectionDays, projectionRates.ethUsd);
  const goldReward = rewardAmount(principal, projectionRates.goldApr, projectionDays, projectionRates.goldUsd);
  const ethUsd = ethReward * projectionRates.ethUsd;
  const goldUsd = goldReward * projectionRates.goldUsd;
  latestProjection = { principal, eth: ethReward, gold: goldReward, ethUsd, goldUsd };
  // The projection/FLEX card is optional on the current referral surface. Keep the
  // shared updater safe when that retired card is not mounted; an absent presentation
  // element must not abort boot before routing and navigation are initialized.
  const setText = (selector, value) => {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  };
  const setHref = (selector, value) => {
    const node = document.querySelector(selector);
    if (node) node.href = value;
  };
  setText('#projected-eth', compactAmount(ethReward));
  setText('#projected-gold', compactAmount(goldReward));
  const cardLink = document.querySelector('#card-link');
  if (cardLink) cardLink.textContent = referralShortLink(chain.state.account);
  setText('#projected-eth-usd', `$${Math.round(ethUsd).toLocaleString()}`);
  setText('#projected-gold-usd', `$${Math.round(goldUsd).toLocaleString()}`);
  setText('#card-principal', principal.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  setText('#card-period', `${projectionDays} DAYS`);
  setText('#card-eth', compactAmount(ethReward));
  setText('#card-gold', compactAmount(goldReward));
  const shareText = `My ${projectionDays}-day MYNE staking projection: ${compactAmount(ethReward + goldReward)} SOL.`;
  setHref('#share-projection-x', `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(referralUrl)}`);
};

const roundedRect = (context, x, y, width, height, radius) => {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fill();
};

const createProjectionCard = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext('2d');
  const backdrop = context.createRadialGradient(260, 80, 10, 260, 80, 850);
  backdrop.addColorStop(0, '#211b0d');
  backdrop.addColorStop(.48, '#090908');
  backdrop.addColorStop(1, '#000000');
  context.fillStyle = backdrop;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const edge = context.createLinearGradient(60, 0, 1140, 0);
  edge.addColorStop(0, 'rgba(207,174,83,0)');
  edge.addColorStop(.5, 'rgba(231,208,141,.7)');
  edge.addColorStop(1, 'rgba(207,174,83,0)');
  context.fillStyle = edge;
  context.fillRect(60, 0, 1080, 3);
  const logo = new Image();
  logo.src = '/gld-icon-transparent.png';
  await logo.decode();
  context.save();
  context.beginPath();
  context.arc(94, 86, 31, 0, Math.PI * 2);
  context.clip();
  context.drawImage(logo, 63, 55, 62, 62);
  context.restore();
  context.fillStyle = '#f3efe4';
  context.font = '700 30px "DM Sans", sans-serif';
  context.letterSpacing = '7px';
  context.fillText('MYNE', 145, 97);
  context.letterSpacing = '0px';
  context.fillStyle = '#88784d';
  context.font = '700 18px "DM Sans", sans-serif';
  context.textAlign = 'right';
  context.fillText('STAKING PROJECTION', 1120, 92);
  context.textAlign = 'left';
  context.fillStyle = '#777166';
  context.font = '700 16px "DM Sans", sans-serif';
  context.fillText('STAKING', 70, 184);
  context.fillStyle = '#f2eee5';
  context.font = '650 64px "Roboto Mono", monospace';
  context.fillText(latestProjection.principal.toLocaleString(undefined, { maximumFractionDigits: 2 }), 68, 255);
  const principalWidth = context.measureText(latestProjection.principal.toLocaleString(undefined, { maximumFractionDigits: 2 })).width;
  context.fillStyle = '#9a958b';
  context.font = '600 23px "DM Sans", sans-serif';
  context.fillText('MYNE', 82 + principalWidth, 253);
  context.fillStyle = '#201d15';
  roundedRect(context, 70, 305, 510, 174, 24);
  context.fillStyle = '#11141a';
  roundedRect(context, 600, 305, 530, 174, 24);
  context.fillStyle = '#8c7a48';
  context.font = '700 16px "DM Sans", sans-serif';
  context.fillText('PROJECTED SOL', 105, 348);
  context.fillStyle = '#f0ece4';
  context.font = '650 46px "Roboto Mono", monospace';
  context.fillText(`${compactAmount(latestProjection.eth)} SOL`, 105, 417);
  context.fillStyle = '#73829a';
  context.font = '700 16px "DM Sans", sans-serif';
  context.fillText('PROJECTED TRADING SOL', 635, 348);
  context.fillStyle = '#e5cf87';
  context.font = '650 46px "Roboto Mono", monospace';
  context.fillText(`${compactAmount(latestProjection.gold)} SOL`, 635, 417);
  context.fillStyle = '#8c8475';
  context.font = '600 17px "DM Sans", sans-serif';
  context.fillText(`${projectionDays} DAY PROJECTION · ESTIMATES VARY WITH PROTOCOL REVENUE`, 70, 548);
  context.fillStyle = '#c6b371';
  context.font = '600 18px "Roboto Mono", monospace';
  context.textAlign = 'right';
  context.fillText(referralShortLink(chain.state.account), 1130, 548);
  context.textAlign = 'left';
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
};

const bytesFromDataUrl = (url) => {
  const binary = atob(url.split(',')[1]);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** Wrap one JPEG page in a dependency-free, standards-compliant PDF. */
const jpegPagePdf = (jpeg, pixelWidth, pixelHeight) => {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let length = 0;
  const push = (value) => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    chunks.push(bytes);
    length += bytes.length;
  };
  push('%PDF-1.4\n%MYNE\n');
  const object = (number, body) => {
    offsets[number] = length;
    push(`${number} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
  offsets[4] = length;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const command = 'q\n595 0 0 842 0 0 cm\n/Im0 Do\nQ\n';
  object(5, `<< /Length ${command.length} >>\nstream\n${command}endstream`);
  const xref = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i += 1) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const pdf = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) { pdf.set(chunk, cursor); cursor += chunk.length; }
  return pdf;
};

const createStakingStatementPdf = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1240;
  canvas.height = 1754;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#08090b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const pearl = ctx.createLinearGradient(86, 0, 1154, 0);
  pearl.addColorStop(0, '#fff1ba'); pearl.addColorStop(.32, '#bde9ff'); pearl.addColorStop(.67, '#f2c8ff'); pearl.addColorStop(1, '#ffffff');
  ctx.fillStyle = pearl; ctx.fillRect(86, 76, 1068, 5);
  const [gldLogo, ethLogo] = await Promise.all(['/gld-icon-transparent.png', '/solana-mark.svg'].map(async (src) => {
    const image = new Image(); image.src = src; await image.decode(); return image;
  }));
  ctx.drawImage(gldLogo, 86, 118, 72, 72);
  ctx.fillStyle = '#f7f7f7'; ctx.font = '700 34px "DM Sans", sans-serif'; ctx.letterSpacing = '10px'; ctx.fillText('MYNE', 184, 170); ctx.letterSpacing = '0px';
  ctx.fillStyle = '#8f9299'; ctx.font = '650 18px "DM Sans", sans-serif'; ctx.textAlign = 'right'; ctx.fillText('STAKING STATEMENT', 1154, 162); ctx.textAlign = 'left';
  ctx.drawImage(ethLogo, 86, 294, 136, 136);
  ctx.fillStyle = '#9a9ca2'; ctx.font = '700 20px "DM Sans", sans-serif'; ctx.letterSpacing = '4px'; ctx.fillText('CLAIMABLE SOL', 260, 320); ctx.letterSpacing = '0px';
  ctx.fillStyle = '#ffffff'; ctx.font = '700 92px "DM Sans", sans-serif'; ctx.fillText(stakingState ? chain.format.ethSmart(stakingState.pendingEth) : '0.000', 255, 411);
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.moveTo(86, 500); ctx.lineTo(1154, 500); ctx.stroke();
  const statementRows = [
    ['TOTAL SOL EARNED', stakingState ? chain.format.ethSmart(stakingState.lifetimeEth) : '0.000'],
    ['STANDARD STAKE', `${chain.format.solIcon(stakingState?.flexStaked ?? 0n, 2)} MYNE`],
    ['BURN STAKE', `${chain.format.solIcon(stakingState?.burnStaked ?? 0n, 2)} MYNE`],
    ['STAKING WEIGHT', `${chain.format.solIcon(stakingState?.weight ?? 0n, 2)} MYNE`],
    ['POOL SHARE', `${(stakingState?.share ?? 0).toFixed(4)}%`],
  ];
  statementRows.forEach(([label, value], index) => {
    const y = 610 + index * 142;
    ctx.fillStyle = '#85888f'; ctx.font = '700 18px "DM Sans", sans-serif'; ctx.letterSpacing = '3px'; ctx.fillText(label, 90, y); ctx.letterSpacing = '0px';
    ctx.fillStyle = '#f5f5f5'; ctx.font = '700 40px "DM Sans", sans-serif'; ctx.textAlign = 'right'; ctx.fillText(value, 1150, y + 4); ctx.textAlign = 'left';
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(86, y + 55); ctx.lineTo(1154, y + 55); ctx.stroke();
  });
  ctx.fillStyle = '#f0f0f0'; ctx.font = '700 28px "DM Sans", sans-serif'; ctx.fillText('8% mining allocation', 86, 1390);
  ctx.fillStyle = '#989ba1'; ctx.font = '500 21px "DM Sans", sans-serif'; ctx.fillText('Protocol revenue is distributed in SOL by staking weight.', 86, 1434);
  const wallet = chain.state.account ? chain.format.short(chain.state.account) : 'Wallet not connected';
  ctx.fillText(`Wallet  ${wallet}`, 86, 1554);
  ctx.fillText(`Generated  ${new Date().toLocaleString()}`, 86, 1594);
  ctx.fillStyle = '#74777e'; ctx.font = '500 17px "DM Sans", sans-serif'; ctx.fillText('Rewards vary with mining volume. Values reflect the chain at generation time.', 86, 1668);
  ctx.textAlign = 'right'; ctx.fillStyle = '#a5a8ae'; ctx.font = '650 18px "DM Sans", sans-serif'; ctx.fillText('SOLANA', 1154, 1594); ctx.textAlign = 'left';
  return new Blob([jpegPagePdf(bytesFromDataUrl(canvas.toDataURL('image/jpeg', .94)), canvas.width, canvas.height)], { type: 'application/pdf' });
};

// Executor-fee allowance per round, mirroring AutoCommit's `maxFeePerExecution` reserve. The
// plan deposit must cover this on top of the wagers or the contract refuses to bet.
const AUTO_FEE_PER_ROUND = 0.001;
const AUTO_FEE_WEI = 1000000000000000n; // same value in wei, for bigint plan math

/** The contract's one-time per-address deposit, in SOL, read from the same constant the
 *  transaction uses so the disclosure can never drift from what is actually charged. */
/**
 * Format an SOL figure for the deploy panel. Display precision is two decimals; transaction math
 * continues to use the unrounded numeric value underneath.
 */
const ethNum = (n) => {
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
};

const mineCostLabel = (solAmount) => mineDisplayCurrency === 'usd'
  ? (usdFor(solAmount) ?? '$—')
  : `${ethNum(solAmount)} SOL`;

const paintMineBalance = () => {
  const label = document.querySelector('.amount-label small');
  if (!label) return;
  const balance = Number(chain.format.solIcon(chain.state.balance ?? 0n, 6));
  const minimum = mineCostLabel(chain.MIN_ETH_PER_ROUND);
  label.textContent = chain.state.account
    ? `Balance ${mineCostLabel(balance)} · Min ${minimum}`
    : '';
};

const ACCOUNT_DEPOSIT_ETH = Number(chain.format.solIcon(chain.format.ACCOUNT_DEPOSIT, 6));

const updateMine = () => {
  const entered = amountSolValue;
  // What will actually be charged: a small entry is raised only enough for the selected tiles to
  // total the protocol-wide 0.05 SOL minimum for one round.
  const perTile = chain.effectiveEthPerTile(entered, selected.size);
  const toppedUp = entered > 0 && selected.size > 0
    && entered * selected.size < chain.MIN_ETH_PER_ROUND;
  // Do not apply the minimum wager before the user has entered anything. The old calculation made
  // an empty field show a non-zero Auto total (fees + minimum), which looked like a preselected
  // charge in the simplified composer.
  const perRound = entered > 0 ? perTile * selected.size : 0;
  // An auto plan is PREPAID: the stepper is simply how many rounds you're funding.
  //
  // With "Max" on, derive that count from the wallet balance instead. The deposit is
  //   perRound*n + fee*(n+1)  (see requiredDeposit), so solving for n against the spendable
  // balance gives the most rounds the wallet can actually fund.
  const perRoundCostEth = perRound + AUTO_FEE_PER_ROUND;
  const spendable = Math.max(0, availableEth - GAS_RESERVE_ETH - AUTO_FEE_PER_ROUND);
  const maxRounds = perRoundCostEth > 0 ? Math.floor(spendable / perRoundCostEth) : 0;
  if (autoRound && fundMaxRounds) repeatRounds = Math.max(1, maxRounds);
  const fundedRounds = autoRound ? repeatRounds : 1;
  // A first bet from an address also pays the contract's one-time ACCOUNT_DEPOSIT. Both paths
  // already charge it on-chain (placeBet adds it to msg.value; requiredDeposit adds it to the
  // plan), but neither used to SHOW it — so a first-timer read "0.0001" here and then saw their
  // wallet ask for 0.0002. It is disclosed in the total and named in the note below.
  const needsDeposit = !chain.state.hasAccount;
  const queuesNextRound = !autoRound && !bettingOpen;
  const total = perRound > 0
    ? (autoRound
      ? perRound * fundedRounds + AUTO_FEE_PER_ROUND * (fundedRounds + 1)
      : queuesNextRound
        ? perRound + AUTO_FEE_PER_ROUND * 2
        : perRound) + (needsDeposit ? ACCOUNT_DEPOSIT_ETH : 0)
    : 0;
  document.querySelector('#tile-count').textContent = selected.size;
  document.querySelector('#round-count').textContent = autoRound ? repeatRounds : 1;
  syncAllButton();
  document.querySelector('#tile-helper').textContent = selected.size
    ? randomMode ? `${selected.size} random selected` : `${selected.size} of 25 selected`
    : 'No tiles selected';
  document.querySelector('#round-helper').textContent = !autoRound
    ? 'Turn on Auto-round to bet over multiple rounds'
    : fundMaxRounds
      ? (maxRounds > 0
        ? `${maxRounds} round${maxRounds === 1 ? '' : 's'} — all your balance funds`
        : 'Balance too low to fund a round')
      : `Funds ${repeatRounds} round${repeatRounds === 1 ? '' : 's'} · top up anytime`;
  document.querySelector('#total-detail').textContent = autoRound
    ? `${selected.size} tile${selected.size === 1 ? '' : 's'} × ${mineCostLabel(perTile)} × ${repeatRounds} round${repeatRounds === 1 ? '' : 's'}`
    : `${selected.size} tile${selected.size === 1 ? '' : 's'} × ${mineCostLabel(perTile)} · ${queuesNextRound ? 'next round queue' : 'this round'}`;
  document.querySelector('#total-amount').textContent = ethNum(total);
  setMineUsdValue(document.querySelector('#total-amount')?.closest('strong'), total);
  document.querySelector('.total-row:not(.per-round-row) span').textContent = queuesNextRound
    ? 'Next round'
    : 'Total deployment';

  // Break out the per-round stake so the repeat cost is legible. The keeper reserve is still
  // INCLUDED in the total (see perRoundCostEth above) — only its explanatory line was removed.
  const perRoundRow = document.querySelector('#per-round-row');
  perRoundRow.hidden = !autoRound;
  // Explain the surcharge up at the input, where the number is being chosen — and say it is
  // charged ONCE for the address, not per tile, which is the easy thing to misread.
  const minNote = document.querySelector('.amount-min');
  if (minNote) {
    const minimumLabel = `Minimum ${mineCostLabel(chain.MIN_ETH_PER_ROUND)} total per round`;
    if (toppedUp) {
      const parts = [
        minimumLabel,
        `${selected.size} tile${selected.size === 1 ? '' : 's'} — adjusted to ${mineCostLabel(perTile)} per tile`,
      ];
      if (needsDeposit) parts.push(`first bet adds a one-time ${mineCostLabel(ACCOUNT_DEPOSIT_ETH)} account deposit`);
      minNote.textContent = parts.join(' · ');
    } else minNote.textContent = minimumLabel;
    minNote.classList.toggle('is-topped-up', toppedUp);
    minNote.hidden = false;
  }
  if (autoRound) {
    document.querySelector('#per-round-amount').textContent = ethNum(perRound);
    setMineUsdValue(document.querySelector('#per-round-amount')?.closest('strong'), perRound);
  }

  const deploy = document.querySelector('#deploy');
  const ready = protocolReady && selected.size > 0 && entered > 0;
  // A manual action during reveal becomes a one-round keeper queue for the next open round.
  deploy.classList.toggle('ready', ready);
  // Clickable even when "not ready", so mine() can explain what's missing via a toast
  // instead of the button silently doing nothing.
  deploy.disabled = !protocolReady;
  deploy.querySelector('span').textContent = !protocolReady
    ? 'PREVIEW ONLY'
    : autoRound ? 'START AUTO'
      : bettingOpen ? 'MINE' : 'BID NEXT ROUND';
  deploy.setAttribute('aria-label', !protocolReady
    ? 'Mining becomes available after the audited Solana program is connected'
    : ready
    ? autoRound
      ? `Fund an auto-round plan with ${mineCostLabel(total)}`
      : bettingOpen
        ? `Mine this round with ${mineCostLabel(total)}`
        : `Queue a bid for the next round with ${mineCostLabel(total)}`
    : `Select tiles and enter an ${mineDisplayCurrency === 'usd' ? 'USD' : 'SOL'} amount to mine`);
  stripMineSolTooltips();
};

const setRandomMode = (enabled) => {
  randomMode = enabled;
  const button = document.querySelector('#random-tiles');
  button.setAttribute('aria-pressed', String(enabled));
  button.classList.toggle('active', enabled);
};

const randomizeSelectedTiles = () => {
  const count = selected.size;
  if (!count) return false;
  const tiles = [...document.querySelectorAll('.slot')];
  for (let index = tiles.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [tiles[index], tiles[swap]] = [tiles[swap], tiles[index]];
  }
  selected.clear();
  document.querySelectorAll('.slot').forEach((tile) => { tile.classList.remove('selected'); tile.setAttribute('aria-pressed', 'false'); });
  tiles.filter((tile) => !tileLocked(tile.dataset.slot)).slice(0, count)
    .forEach((tile) => { selected.add(tile.dataset.slot); tile.classList.add('selected'); tile.setAttribute('aria-pressed', 'true'); });
  updateMine();
  return true;
};

const setSocialTab = (name) => {
  const target = name === 'news' ? 'news' : 'chat';
  document.querySelector('.social-tabs')?.setAttribute('data-active', target);
  document.querySelectorAll('[data-social-tab]').forEach((button) => { const active = button.dataset.socialTab === target; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll('[data-social-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.socialPanel === target));
};

const setAboutSection = (name) => {
  const target = document.querySelector(`[data-about-panel="${name}"]`) ? name : 'intro';
  document.querySelectorAll('[data-about-section]').forEach((button) => button.classList.toggle('active', button.dataset.aboutSection === target));
  document.querySelectorAll('[data-about-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.aboutPanel === target));
  const sectionTitles = {
    intro: 'Protocol', mining: 'Mine', 'token-flow': 'Supply', fees: 'Fees',
    'gold-payouts': 'Rewards', motherlode: 'Motherlode', 'referral-model': 'Referrals',
    'staking-model': 'Staking',
  };
  const title = sectionTitles[target];
  const panel = document.querySelector(`[data-about-panel="${target}"]`);
  if (title && panel) panel.querySelector('h2')?.replaceChildren(document.createTextNode(title));
  // The mobile dropdown's closed state IS the current section, so it has to be re-labelled
  // here rather than on click alone — deep links and the About tab both land through setAboutSection.
  const label = aboutNavToggle.querySelector('b');
  const active = document.querySelector(`[data-about-section="${target}"]`);
  if (label && active) label.textContent = active.textContent;
};

const syncNavIndicator = () => window.requestAnimationFrame(() => {
  const nav = document.querySelector('.main-nav');
  const active = nav.querySelector('.nav-item.active');
  if (!active) return;
  const navRect = nav.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  // + scrollLeft because the underline is absolutely positioned INSIDE the nav, so it scrolls
  // with the content while getBoundingClientRect is viewport-relative. Below 900px the nav is a
  // horizontal scroller (the seven items are wider than a phone), and without this the underline
  // drifts off the active item by exactly the scroll offset. It is 0 on desktop, so one formula
  // covers both.
  nav.style.setProperty('--nav-x', `${activeRect.left - navRect.left + nav.scrollLeft}px`);
  nav.style.setProperty('--nav-width', `${activeRect.width}px`);
  // Keep the active route reachable without hunting for it after a scroll.
  if (nav.scrollWidth > nav.clientWidth) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
document.querySelector('.main-nav')?.addEventListener('scroll', syncNavIndicator, { passive: true });

// --- Swap page (SOL <-> MYNE on the Solana liquidity adapter) ----------------------------------------
document.querySelector('[data-page="stake"]').insertAdjacentHTML('afterend', `
  <main class="feature-shell swap-shell page-view" data-page="swap">
    <header class="feature-hero route-header"><div><span class="eyebrow">TRADE</span><h1>Swap.</h1></div></header>
    <section class="swap-card">
      <div class="swap-field">
        <div class="swap-field-head"><span>You pay</span><small id="swap-from-bal">—</small></div>
        <div class="swap-field-body"><input id="swap-amount" value="0" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Amount to swap"/><span class="swap-token" id="swap-from-token">${solIcon()} SOL</span></div>
        <div class="swap-quick"><button data-swap-pct="25">25%</button><button data-swap-pct="50">50%</button><button data-swap-pct="75">75%</button><button data-swap-pct="100">MAX</button></div>
      </div>
      <button class="swap-flip" id="swap-flip" aria-label="Flip direction">${icon('shuffle')}</button>
      <div class="swap-field">
        <div class="swap-field-head"><span>You receive (est.)</span><small id="swap-to-bal">—</small></div>
        <div class="swap-field-body"><strong id="swap-out">0.000</strong><span class="swap-token static" id="swap-to-token"><img src="/gld-icon-transparent.png" alt=""/> MYNE</span></div>
      </div>
      <div class="swap-info"><span>Rate</span><b id="swap-rate">—</b></div>
      <div class="swap-info" hidden><span>Price impact</span><b id="swap-impact">—</b></div>
      <div class="swap-info"><span>Max slippage</span><b>1%</b></div>
      <button class="swap-submit" id="swap-submit">Connect wallet</button>
    </section>
  </main>`);

let swapDir = 'buy'; // buy = SOL->MYNE, sell = MYNE->SOL
let swapState = null;
// Exact wei amount set by the 25/50/75/MAX buttons. Using this (instead of re-parsing the rounded
// display string) avoids "Insufficient" on MAX: format.eth rounds to 3 dp, so parseEther of the
// display could exceed the true balance by a rounding sliver. Cleared whenever the user types.
let swapExact = null;
const swapAmount = document.querySelector('#swap-amount');
const swapAmountIn = () => (swapExact !== null ? swapExact : toWei(swapAmount.value));
const SWAP_GAS_BUFFER = 2000000000000000n;  // keep 0.002 SOL for gas on a MAX buy

const renderSwap = () => {
  const s = swapState;
  const fromSol = swapDir === 'buy';
  document.querySelector('#swap-from-token').innerHTML = fromSol ? `${solIcon()} SOL` : `<img src="/gld-icon-transparent.png" alt=""/> MYNE`;
  document.querySelector('#swap-to-token').innerHTML = fromSol ? `<img src="/gld-icon-transparent.png" alt=""/> MYNE` : `${solIcon()} SOL`;
  document.querySelector('#swap-from-bal').textContent = `Balance ${chain.format.ethSmart(s ? (fromSol ? s.solBalance : s.gldBalance) : 0n)}`;
  document.querySelector('#swap-to-bal').textContent = `Balance ${chain.format.ethSmart(s ? (fromSol ? s.gldBalance : s.solBalance) : 0n)}`;

  const amountIn = swapAmountIn();
  const out = (s && amountIn > 0n) ? quote(amountIn, swapDir, s) : 0n;
  document.querySelector('#swap-out').textContent = fromSol ? chain.format.solIcon(out) : chain.format.ethSmart(out);
  if (s && s.sqrtPriceX96 > 0n) {
    // SPOT, not "what 1 SOL would buy". Quoting a full 1 SOL against a pool holding a fraction of
    // that returns the price AFTER enormous impact — it read 491 MYNE/SOL on a pool priced at
    // 33,333, which looks like a broken oracle rather than a shallow pool.
    const spot = spotMynePerSol(s);
    document.querySelector('#swap-rate').textContent =
      `1 SOL ≈ ${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })} MYNE`;

    // Price impact for the amount ACTUALLY entered — the number that matters here, because this
    // pool is thin enough that a modest trade moves it a long way.
    const impactEl = document.querySelector('#swap-impact');
    if (impactEl) {
      if (amountIn > 0n && out > 0n) {
        const effective = fromSol
          ? Number(out) / Number(amountIn)              // MYNE per SOL received
          : Number(amountIn) / Number(out);             // MYNE per SOL given up
        const impact = Math.max(0, (1 - effective / spot) * 100);
        impactEl.textContent = `${impact.toFixed(2)}%`;
        impactEl.classList.toggle('warn', impact >= 5);
        impactEl.closest('.swap-info').hidden = false;
      } else {
        impactEl.closest('.swap-info').hidden = true;
      }
    }
  }

  const submit = document.querySelector('#swap-submit');
  const bal = s ? (fromSol ? s.solBalance : s.gldBalance) : 0n;
  const overMax = amountIn > bal;
  const needsApprove = !fromSol && s && s.allowance < amountIn;
  submit.classList.toggle('ready', Boolean(chain.state.account) && amountIn > 0n && !overMax);
  submit.textContent = !chain.state.account ? 'Connect wallet'
    : amountIn <= 0n ? 'Enter an amount'
      : overMax ? `Insufficient ${fromSol ? 'SOL' : 'MYNE'}`
        : needsApprove ? 'Approve MYNE'
          : fromSol ? 'Buy MYNE' : 'Sell MYNE';
};

/**
 * Keep the MYNE price fresh regardless of route or wallet.
 *
 * The header MYNE price is visible on every route, but `myneUsd` was only ever set by refreshSwap(),
 * which runs on the Swap route or an account change. Keep the shared header quote current even
 * when a disconnected visitor lands directly on Mine.
 *
 * Throttled: this is one pool read, and the price does not move meaningfully inside a minute.
 */
let gldPriceAt = 0;
const refreshGldPrice = async (force = false) => {
  if (!poolAvailable) return;
  if (!force && Date.now() - gldPriceAt < 60_000) return;
  gldPriceAt = Date.now();
  try {
    // No forced repaint: renderChain already runs on every chain poll (~1s), so the headline
    // picks the price up on its own. Calling it here would fire before chain.state is populated
    // on the boot path.
    setMynePerSol(spotMynePerSol(await readSwapState(null)));
  } catch (error) { console.warn('gld price failed', error); }
};

const refreshSwap = async () => {
  // PHASE 1 (premine): no SOL/MYNE pool exists, so there is nothing to read and the Swap surface is
  // removed from the nav. Bail before the read rather than throwing on every account change/poll.
  if (!poolAvailable) return;
  try {
    swapState = await readSwapState(chain.state.account);
    renderSwap();
    setMynePerSol(spotMynePerSol(swapState));
  }
  catch (error) { console.warn('swap state failed', error); }
};

swapAmount.addEventListener('input', () => { swapExact = null; renderSwap(); });
document.querySelector('#swap-flip').addEventListener('click', () => {
  swapDir = swapDir === 'buy' ? 'sell' : 'buy';
  swapExact = null;
  swapAmount.value = '0';
  renderSwap();
});
document.querySelectorAll('[data-swap-pct]').forEach((b) => b.addEventListener('click', () => {
  const s = swapState;
  if (!s) return;
  const fromSol = swapDir === 'buy';
  let bal = fromSol ? s.solBalance : s.gldBalance;
  if (fromSol) bal = bal > SWAP_GAS_BUFFER ? bal - SWAP_GAS_BUFFER : 0n; // leave gas
  const amt = (bal * BigInt(b.dataset.swapPct)) / 100n;
  swapExact = amt;                          // exact wei for the tx
  swapAmount.value = chain.format.solIcon(amt); // rounded, display only
  renderSwap();
}));

const runSwapTx = async (pending, action) => {
  try {
    notify(pending);
    const hash = await action();
    notify('Submitted — waiting…');
    await waitForTx(hash);
    notify('Confirmed');
    await refreshSwap();
    return true;
  } catch (error) { notify(readableError(error)); return false; }
};

document.querySelector('#swap-submit').addEventListener('click', async () => {
  if (!chain.state.account) return chain.connectWallet();
  const s = swapState;
  if (!s) return;
  const amountIn = swapAmountIn();
  if (amountIn <= 0n) return notify('Enter an amount');
  const fromSol = swapDir === 'buy';
  if (amountIn > (fromSol ? s.solBalance : s.gldBalance)) return notify(`Insufficient ${fromSol ? 'SOL' : 'MYNE'}`);
  // Slippage is now enforced ON CHAIN by the Universal Router (SWAP_EXACT_IN_SINGLE's
  // amountOutMinimum), not merely displayed. Passing 0 here would hand every swap to a sandwich,
  // so derive the floor from the same quote the user was shown.
  const expectedOut = quote(amountIn, swapDir, s);
  const minOut = withSlippage(expectedOut, SWAP_SLIPPAGE_BPS);
  if (expectedOut <= 0n) return notify('No liquidity for that amount');
  if (fromSol) {
    await runSwapTx('Buying MYNE…', () => swapSolForGld(amountIn, minOut));
  } else {
    if (s.allowance < amountIn) {
      const approved = await runSwapTx('Approving MYNE…', () => approveGld(amountIn));
      if (!approved) return;
    }
    await runSwapTx('Selling MYNE…', () => swapGldForSol(amountIn, minOut));
  }
  swapExact = null;
  swapAmount.value = '0';
  renderSwap();
});

// The premine banner sits above the topbar, outside the `calc(100dvh - …)` allowance the
// full-height layouts use. Measure it and expose it as a variable so those calcs stay exact — it
// wraps to two lines on narrow screens, so a hardcoded value would be wrong there.
// Marks the document so CSS can react to the phase without every rule threading a flag through.
if (isPremine) document.body.classList.add('premine');

const syncBannerOffset = () => {
  const banner = document.querySelector('.premine-banner');
  document.documentElement.style.setProperty('--premine-banner-h', banner ? `${banner.offsetHeight}px` : '0px');
};
syncBannerOffset();
window.addEventListener('resize', syncBannerOffset);

const setRoute = (route, { updateHash = true, aboutTarget } = {}) => {
  const target = document.querySelector(`[data-page="${route}"]`) ? route : 'mine';
  document.querySelectorAll('.page-view').forEach((page) => page.classList.toggle('active', page.dataset.page === target));
  document.querySelectorAll('.nav-item[data-route]').forEach((button) => button.classList.toggle('active', button.dataset.route === target));
  syncNavIndicator();
  document.body.dataset.route = target;
  chain.setLive(target === 'mine');
  scheduleSocialLoad(target);
  if (target === 'mine') renderChain(chain.state);
  if (target === 'about') setAboutSection(aboutTarget || 'intro');
  if (protocolReady && target === 'rounds') refreshRoundHistory({ force: true });
  if (protocolReady && target === 'referrals') { refreshReferral(); renderLeaderboard(); renderMyReferrals(); }
  if (protocolReady && target === 'stake') refreshStaking();
  if (protocolReady && target === 'swap') refreshSwap();
  relocateChat(target);
  syncTabbar();
  if (updateHash && window.location.hash !== `#${target}`) window.location.hash = target;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

document.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', () => { setRoute(button.dataset.route, { aboutTarget: button.dataset.aboutTarget }); setMenu(false); }));
document.querySelectorAll('[data-social-tab]').forEach((button) => button.addEventListener('click', () => setSocialTab(button.dataset.socialTab)));
document.querySelectorAll('[data-social-open]').forEach((button) => button.addEventListener('click', () => { setRoute('mine'); setSocialTab(button.dataset.socialOpen); setMenu(false); }));
document.querySelectorAll('[data-about-section]').forEach((button) => button.addEventListener('click', () => setAboutSection(button.dataset.aboutSection)));

document.querySelectorAll('.slot').forEach((tile) => tile.addEventListener('click', () => { const id = tile.dataset.slot; if (tileLocked(id)) return notify(`Tile #${id} is already mined this round`); setRandomMode(false); const active = !selected.has(id); active ? selected.add(id) : selected.delete(id); tile.classList.toggle('selected', active); tile.setAttribute('aria-pressed', String(active)); updateMine(); }));
// 4dp, not 2: the increments go down to 0.0001, and rounding to 2 would swallow the two smallest
// buttons entirely (0 + 0.0001 -> "0.00"). Number() then drops trailing zeros, so +0.01 reads
// "0.01" rather than "0.0100", while toFixed first absorbs float noise like 0.30000000000000004.
document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
  amountSolValue = Number((amountSolValue + Number(button.dataset.add)).toFixed(18));
  paintMineAmount();
  updateMine();
}));
mineCurrencyToggle?.addEventListener('click', () => {
  captureMineAmount();
  mineDisplayCurrency = mineDisplayCurrency === 'usd' ? 'eth' : 'usd';
  try { window.localStorage.setItem('gld-mine-currency', mineDisplayCurrency); } catch { /* private mode */ }
  syncMineCurrency();
  paintMineAmount();
  paintMineBalance();
  updateMine();
  renderTiles(chain.state);
});
window.addEventListener('solpricechange', () => {
  syncMineCurrency();
  if (mineDisplayCurrency === 'usd') paintMineAmount();
  paintMineBalance();
  updateMine();
  renderTiles(chain.state);
  updateStakeFlexCard();
});
/**
 * ALL doubles as CLEAR once every tile is selected — otherwise the only way back from a full
 * grid is 25 individual taps, or the − stepper 25 times.
 */
const allTilesButton = document.querySelector('#all');
const allTilesSelected = () => selected.size === document.querySelectorAll('.slot').length;

const syncAllButton = () => {
  const clearing = allTilesSelected();
  allTilesButton.textContent = clearing ? 'CLEAR' : 'ALL';
  allTilesButton.setAttribute('aria-label', clearing ? 'Clear tile selection' : 'Select every tile');
};

allTilesButton.addEventListener('click', () => {
  setRandomMode(false);
  const clearing = allTilesSelected();
  document.querySelectorAll('.slot').forEach((tile) => {
    const id = tile.dataset.slot;
    // ALL means "every tile still available to me", not every tile — a locked one would be staged
    // for a second bet the panel will not place.
    const pick = !clearing && !tileLocked(id);
    if (pick) selected.add(id); else selected.delete(id);
    tile.classList.toggle('selected', pick);
    tile.setAttribute('aria-pressed', String(pick));
  });
  updateMine();
});
document.querySelector('#random-tiles').addEventListener('click', () => {
  if (randomMode) { setRandomMode(false); updateMine(); return notify('Random selection off'); }
  if (!selected.size) return notify('Choose a tile count first');
  setRandomMode(true);
  randomizeSelectedTiles();
  notify(`Random selection on · ${selected.size} tiles`);
});
document.querySelector('#tiles-minus').addEventListener('click', () => { const last = [...selected].pop(); if (last) { selected.delete(last); const tile = document.querySelector(`[data-slot="${last}"]`); tile.classList.remove('selected'); tile.setAttribute('aria-pressed', 'false'); } if (randomMode && selected.size) randomizeSelectedTiles(); else { if (!selected.size) setRandomMode(false); updateMine(); } });
document.querySelector('#tiles-plus').addEventListener('click', () => { const next = slots.find(([id]) => !selected.has(String(id)) && !tileLocked(id)); if (next) { selected.add(String(next[0])); const tile = document.querySelector(`[data-slot="${next[0]}"]`); tile.classList.add('selected'); tile.setAttribute('aria-pressed', 'true'); } if (randomMode) randomizeSelectedTiles(); else updateMine(); });
document.querySelector('#rounds-minus').addEventListener('click', () => { repeatRounds = Math.max(1, repeatRounds - 1); updateMine(); });
document.querySelector('#rounds-plus').addEventListener('click', () => { repeatRounds += 1; updateMine(); });
const autoClaimToggle = document.querySelector('#auto-claim');
// Auto-mine reward policy is a wallet preference. Standard mode leaves MYNE unclaimed in the
// protocol accumulator; Auto-burn is an explicit burn-stake preference for the user's claim flow.
let autoRewardMode = (() => {
  try { return window.localStorage.getItem('myne-auto-reward-mode') === 'burn' ? 'burn' : 'accumulate'; }
  catch { return 'accumulate'; }
})();
const autoRewardRow = document.querySelector('.auto-row');
if (autoRewardRow) {
  autoRewardRow.insertAdjacentHTML('afterend', `<div class="config-row auto-reward-row" hidden><div><b>Rewards</b><small id="auto-reward-helper">Keep your MYNE in-system and accumulating. 10% Claim Fee</small></div><div class="auto-reward-options" role="group" aria-label="Auto-mine reward policy"><button type="button" data-auto-reward="accumulate">Auto-mine</button><button type="button" data-auto-reward="burn">Auto-burn</button></div></div>`);
}
const autoRewardOptions = [...document.querySelectorAll('[data-auto-reward]')];
const syncAutoRewardMode = () => {
  autoRewardOptions.forEach((button) => {
    const active = button.dataset.autoReward === autoRewardMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const helper = document.querySelector('#auto-reward-helper');
  if (helper) helper.textContent = autoRewardMode === 'burn'
    ? 'Stake + burn your MYNE for 5× staking pool weight. 0% Claim Fee'
    : 'Keep your MYNE in-system and accumulating. 10% Claim Fee';
};
autoRewardOptions.forEach((button) => button.addEventListener('click', () => {
  if (!autoRound && button.dataset.autoReward === 'burn') {
    return notify('Turn on Auto-round to enable Auto-burn');
  }
  autoRewardMode = button.dataset.autoReward === 'burn' ? 'burn' : 'accumulate';
  try { window.localStorage.setItem('myne-auto-reward-mode', autoRewardMode); } catch { /* storage is optional */ }
  syncAutoRewardMode();
  if (chain.state.account) {
    document.querySelectorAll(`.round-miner-row[data-wallet="${chain.state.account.toLowerCase()}"]`).forEach((row) => {
        row.classList.toggle('auto-burn', autoRound && autoRewardMode === 'burn');
    });
  }
  notify(autoRewardMode === 'burn'
      ? 'Auto-burn selected — your MYNE is automatically staked and burned for 5× pool weight · 0% claim fee'
    : 'Auto-mine selected — mined MYNE accumulates in-system');
}));
syncAutoRewardMode();
/**
 * Auto-round has one funding rule: use the maximum affordable number of rounds.
 *
 * A plan is ALWAYS configured with unlimited plays. A finite play count was redundant —
 * funding N rounds already stops after N rounds, since the contract can't bet without money.
 * The only difference was that a finite plan ended permanently while an unlimited one pauses
 * and can be resumed by topping up, which is strictly better. Dropping it also removes the
 * "until balance" toggle and the auto-claim conflict (auto-claim forces unlimited anyway).
 */
const untilBalanceToggle = document.querySelector('#until-balance');
const syncAutoControls = () => {
  // Solana auto plans are permissionless to execute but receipt claims remain wallet-signed.
  // Do not offer the inherited delegate-based EVM auto-claim control.
  autoClaimEnabled = false;
  // The simplified composer has no round-count choice. Auto always derives the maximum
  // affordable plan from the connected wallet balance.
  fundMaxRounds = autoRound;

  // With "Max" on the round count is derived from the balance, so the stepper is read-only.
  document.querySelector('#rounds-minus').disabled = fundMaxRounds;
  document.querySelector('#rounds-plus').disabled = fundMaxRounds;
  untilBalanceToggle.disabled = !autoRound;
  untilBalanceToggle.setAttribute('aria-checked', String(fundMaxRounds));
  untilBalanceToggle.classList.toggle('active', fundMaxRounds);

  autoToggle.setAttribute('aria-checked', String(autoRound));
  autoToggle.classList.toggle('active', autoRound);
  autoToggle.querySelector('b').textContent = autoRound ? 'On' : 'Off';

  // Auto-burn is only valid as a reward policy for an active Auto-round plan.
  // Turning Auto-round off immediately returns the wallet to standard Auto-mine.
  if (!autoRound && autoRewardMode === 'burn') {
    autoRewardMode = 'accumulate';
    try { window.localStorage.setItem('myne-auto-reward-mode', autoRewardMode); } catch { /* storage is optional */ }
    syncAutoRewardMode();
  }

  document.querySelector('.auto-claim-row').hidden = true;
  document.querySelector('.auto-reward-row').hidden = !autoRound;
  autoClaimToggle.setAttribute('aria-checked', String(autoClaimEnabled));
  autoClaimToggle.classList.toggle('active', autoClaimEnabled);
  autoClaimToggle.querySelector('b').textContent = autoClaimEnabled ? 'On' : 'Off';

  document.querySelector('#auto-helper').textContent = autoRound
    ? 'Uses your balance for the maximum rounds'
    : 'Mine this round only';
  updateMine();
};
untilBalanceToggle.addEventListener('click', () => {
  if (!autoRound) return notify('Turn on Auto-round first');
  fundMaxRounds = !fundMaxRounds;
  syncAutoControls();
  notify(fundMaxRounds
    ? 'Funding as many rounds as your balance allows'
    : 'Set the round count manually');
});
autoClaimToggle.addEventListener('click', () => {
  if (!autoRound) return;
  autoClaimEnabled = !autoClaimEnabled;
  syncAutoControls();
  notify(autoClaimEnabled
    ? 'Auto-claim on — the contract runs the plan until the balance runs out'
    : 'Auto-claim off — you can set a fixed round count');
});
autoToggle.addEventListener('click', () => {
  autoRound = !autoRound;
  syncAutoControls();
  if (chain.state.account) {
    document.querySelectorAll(`.round-miner-row[data-wallet="${chain.state.account.toLowerCase()}"]`).forEach((row) => {
      row.classList.toggle('auto-burn', autoRound && autoRewardMode === 'burn');
    });
  }
  // Turning the toggle off only changes what the NEXT MINE click does. A plan already
  // funded on-chain keeps betting until its plays run out — stopping it needs cancelPlan.
  const live = chain.state.plan?.enabled;
  notify(autoRound
    ? 'Auto on — funding the maximum rounds your balance allows'
    : live
      ? 'Your active plan is still running — use Cancel & withdraw to stop it'
      : 'Auto-round off — MINE bets on the current round only');
});
amount.addEventListener('input', () => {
  captureMineAmount();
  updateMine();
});
stakeAmount.addEventListener('input', () => { updateStake(); calculatorAmount.value = stakeAmount.value; updateProjection(); });
document.querySelector('#stake-max').addEventListener('click', () => {
  const basis = stakingState ? (stakeMode === 'deposit' ? stakingState.walletBullion : stakingState.flexStaked) : 0n;
  stakeAmount.value = chain.format.solIcon(basis);
  calculatorAmount.value = stakeAmount.value;
  updateStake();
  updateProjection();
});
calculatorAmount.addEventListener('input', updateProjection);
document.querySelectorAll('[data-projection-days]').forEach((button) => button.addEventListener('click', () => {
  projectionDays = Number(button.dataset.projectionDays);
  document.querySelectorAll('[data-projection-days]').forEach((item) => item.classList.toggle('active', item === button));
  updateProjection();
}));
document.querySelector('#copy-projection-link').addEventListener('click', () => {
  void copyText(referralUrl);
  notify('Referral link copied');
});
document.querySelector('#share-projection').addEventListener('click', async () => {
  const blob = await createProjectionCard();
  if (!blob) return notify('Could not create projection card');
  const file = new File([blob], 'bullion-staking-projection.png', { type: 'image/png' });
  const shareText = `My ${projectionDays}-day MYNE staking projection: ${compactAmount(latestProjection.eth + latestProjection.gold)} SOL.`;
  try {
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ title: 'MYNE staking projection', text: shareText, url: referralUrl, files: [file] });
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
  }
  const downloadUrl = URL.createObjectURL(blob);
  const download = document.createElement('a');
  download.href = downloadUrl;
  download.download = file.name;
  download.click();
  URL.revokeObjectURL(downloadUrl);
  void copyText(referralUrl);
  notify('Card downloaded · referral link copied');
});
// --- staking (real, backed by BullionStaking) ----------------------------------------
const runStakeTx = async (pending, action) => {
  try {
    notify(pending);
    const hash = await action();
    notify('Submitted — waiting…');
    await waitForTx(hash);
    notify('Confirmed');
    await refreshStaking();
    return true;
  } catch (error) {
    notify(readableError(error));
    return false;
  }
};

// The amount input shows 3 decimals, so MAX (and hand-typed "all") can round UP past the true
// balance by up to one display unit — parsing "1.782" when you actually hold 1.7819 would revert
// with "Not enough". Clamp to the EXACT on-chain balance when the overage is within that unit
// (a rounding artifact), but still reject a genuine over-entry.
const STAKE_DISPLAY_UNIT = 10n ** 15n; // 0.001 MYNE
const clampToBalance = (amount, balance, overMsg) => {
  if (amount <= balance) return amount;
  if (amount - balance <= STAKE_DISPLAY_UNIT) return balance; // round-up artifact -> use all
  notify(overMsg);
  return null;
};

document.querySelector('#stake-submit').addEventListener('click', async () => {
  if (!chain.state.account) return notify('Connect wallet to stake');
  const parsed = toWei(stakeAmount.value);
  if (parsed <= 0n) return notify('Enter a MYNE amount');

  if (stakeMode === 'deposit') {
    const amount = clampToBalance(parsed, stakingState?.walletBullion ?? 0n, 'Not enough MYNE');
    if (amount === null || amount <= 0n) return;
    // The burn gate comes BEFORE the approval, not between approve and stake: backing out at
    // the old position had already cost a signature and left a live allowance behind.
    const isBurn = stakeTier === TIER_BURN;
    if (isBurn) {
      const ok = await confirmAction({
        eyebrow: 'PERMANENT · NOT RECOVERABLE',
        title: `Burn ${chain.format.solIcon(amount)} MYNE`,
        lead: 'The principal is destroyed on stake. There is no withdrawal, no cooldown and no way to reverse this — you keep the 5× reward weight, not the tokens.',
        rows: [
          ['Burned', `${chain.format.solIcon(amount)} MYNE`],
          ['Reward weight', '5×'],
          ['Withdrawal', 'None — ever'],
        ],
        confirmLabel: 'Burn permanently',
        cancelLabel: 'Keep my MYNE',
      });
      if (!ok) return;
    }
    // Approve first if the allowance is short (one-time per amount).
    const allowance = await readStakeAllowance().catch(() => 0n);
    if (allowance < amount) {
      const approved = await runStakeTx('Approving MYNE…', () => approveStake(amount));
      if (!approved) return;
    }
    await runStakeTx(`${isBurn ? 'Burning' : 'Staking'} ${chain.format.solIcon(amount)} MYNE…`, () => stakeTx(amount, stakeTier));
    stakeAmount.value = '0';
    updateStake();
  } else {
    const amount = clampToBalance(parsed, stakingState?.flexStaked ?? 0n, 'More than you have staked');
    if (amount === null || amount <= 0n) return;
    await runStakeTx('Starting 30-day unstake…', () => requestUnstake(amount));
    stakeAmount.value = '0';
    updateStake();
  }
});

document.querySelector('#claim-stake-rewards').addEventListener('click', async () => {
  if (!chain.state.account) return notify('Connect wallet to claim staking rewards');
  // SOL is the live reward. The stock check remains solely so balances credited before migration
  // can still exit through the contract's combined claim function.
  if (!(stakingState && (stakingState.pendingEth > 0n
        || stakingState.hasClaimableStocks))) return notify('Nothing to claim');
  await runStakeTx('Claiming rewards…', claimStakingRewards);
});

// Withdraw matured unstake requests (delegated — the button is re-rendered).
document.querySelector('#unstake-status').addEventListener('click', async (event) => {
  if (!event.target.closest('#withdraw-unstaked')) return;
  await runStakeTx('Withdrawing…', withdrawUnstaked);
});
// --- referrals (real, backed by BullionReferral) -------------------------------------
let referralStats = null;
let referralLoadedFor = null;
let leaderboardLoaded = false;
let myReferralsLoadedFor = null;

const setReferralText = (sel, value) => { const el = referralShell?.querySelector(sel); if (el) el.textContent = value; };

const renderReferral = () => {
  if (!referralShell) return;
  const acct = chain.state.account;

  // Link + share targets use the connected wallet's address as ?ref=.
  referralUrl = referralLinkFor(acct);
  setReferralText('.referral-link code', acct ? referralShortLink(acct) : 'Connect wallet for your link');
  const s = referralStats;
  // Metrics: CLAIMABLE / ACTIVE / EARNED
  const metrics = referralShell.querySelector('.referral-metrics');
  if (metrics) {
    metrics.hidden = false;
    metrics.querySelectorAll('article strong')[0].innerHTML = `<img src="/gld-icon-transparent.png" alt=""/> ${s ? chain.format.solIcon(s.claimable) : '0.000'}`;
    metrics.querySelectorAll('article strong')[1].firstChild.textContent = s ? String(s.active) : '0';
    const activeSmall = metrics.querySelectorAll('article small')[0];
    if (activeSmall) activeSmall.textContent = s ? `/ ${s.referrals}` : '/ 0';
    metrics.querySelectorAll('article strong')[2].innerHTML = `<img src="/gld-icon-transparent.png" alt=""/> ${s ? chain.format.solIcon(s.lifetime) : '0.000'}`;
  }

  // 30-day performance strip -> repurposed as live totals (contract has no time buckets).
  const perf = referralShell.querySelector('.referral-performance');
  if (perf) {
    perf.querySelector('.eyebrow').textContent = 'YOUR NETWORK';
    const [a, b, c] = perf.querySelectorAll('strong');
    a.innerHTML = `${s ? s.referrals : 0} <small>visits</small>`;
    b.innerHTML = `${s ? s.active : 0} <small>active</small>`;
    c.innerHTML = `${s ? chain.format.solIcon(s.lifetime) : '0.000'} <small>earned</small>`;
  }

  const refFlex = (selector, value) => {
    const el = referralFlexDialog?.querySelector(selector);
    if (el) el.textContent = value;
  };
  const earnedMyne = s ? Number(chain.format.solIcon(s.lifetime)) : 0;
  const myneUsd = getMyneUsd();
  const earnedUsd = myneUsd != null && Number.isFinite(earnedMyne)
    ? `$${(earnedMyne * myneUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '$—';
  refFlex('[data-ref-flex-earned]', s ? chain.format.solIcon(s.lifetime) : '0.000');
  refFlex('[data-ref-flex-earned-usd]', `${earnedUsd} value`);
  refFlex('[data-ref-flex-count]', String(s?.referrals ?? 0));
  refFlex('[data-ref-flex-active]', String(s?.active ?? 0));
  refFlex('[data-ref-flex-earned-value]', earnedUsd);
  refFlex('[data-ref-flex-network]', s ? chain.format.solIcon(s.lifetime) : '0.000');
  refFlex('[data-ref-flex-link]', referralShortLink(acct));
  const referralShareText = `I have referred ${s?.referrals ?? 0} miners and earned ${s ? chain.format.solIcon(s.lifetime) : '0.000'} MYNE on Solana.`;
  const referralShareUrl = referralUrl || REF_BASE;
  const refX = referralFlexDialog?.querySelector('#ref-flex-x');
  const refTg = referralFlexDialog?.querySelector('#ref-flex-tg');
  if (refX) refX.href = `https://x.com/intent/post?text=${encodeURIComponent(referralShareText)}&url=${encodeURIComponent(referralShareUrl)}`;
  if (refTg) refTg.href = `https://t.me/share/url?url=${encodeURIComponent(referralShareUrl)}&text=${encodeURIComponent(referralShareText)}`;

  const claimBtn = document.querySelector('#claim-referral-rewards');
  if (claimBtn) {
    const has = s && s.claimable > 0n;
    claimBtn.disabled = !has;
    claimBtn.textContent = has ? `Claim ${chain.format.solIcon(s.claimable)} MYNE` : 'Nothing to claim';
  }
};

/** @param force re-read even when the account is unchanged (used by the live poller). */
const refreshReferral = async (force = false) => {
  const acct = chain.state.account;
  if (!force && referralLoadedFor === acct && referralStats) return renderReferral();
  referralLoadedFor = acct;
  referralStats = await readReferralStats(acct).catch(() => null);
  renderReferral();
};

/**
 * The list of wallets this account referred.
 *
 * Kept separate from the leaderboard: that ranks everyone, this answers "who did I bring in and
 * what did they earn me" — which is the question the page exists for and previously had no answer
 * anywhere in the UI, only an aggregate count.
 */
const renderMyReferrals = async (force = false) => {
  const list = referralShell?.querySelector('.my-referrals-list');
  if (!list) return;
  const acct = chain.state.account;
  if (!acct) {
    list.innerHTML = '<div class="round-empty">Connect your wallet to see who you referred.</div>';
    myReferralsLoadedFor = null;
    return;
  }
  if (myReferralsLoadedFor === acct && !force) return;
  myReferralsLoadedFor = acct;
  if (!force) list.innerHTML = '<div class="round-empty">Loading…</div>';

  const rows = await readMyReferrals(acct).catch(() => null);
  if (rows === null) {
    // Distinguish "could not read" from "nobody yet" — a failed query must not read as zero.
    list.innerHTML = '<div class="round-empty">Couldn\'t load your referrals — the network didn\'t answer.</div>';
    myReferralsLoadedFor = null;
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<div class="round-empty">Nobody yet. Share your link above to start earning 1% of what they claim.</div>';
    return;
  }
  list.innerHTML = rows.map((r) => `
    <div class="my-referral-row">
      <div class="referrer-identity"><div><b>${chain.format.short(r.addr)}</b></div></div>
      <span class="referral-status ${r.active ? 'is-active' : 'is-pending'}">${r.active ? 'Mining' : 'Not mined yet'}</span>
      <strong><img src="/gld-icon-transparent.png" alt=""/> ${chain.format.solIcon(r.earned)}</strong>
      <a class="round-explorer" href="${explorerAddress(r.addr)}" target="_blank" rel="noreferrer">View ↗</a>
    </div>`).join('');
};

const renderLeaderboard = async (force = false) => {
  if (leaderboardLoaded && !force) return;
  leaderboardLoaded = true;
  const list = referralShell?.querySelector('.referral-list');
  if (!list) return;
  // Only show the placeholder on first load — a background poll must not flash "Loading…".
  if (!force) list.innerHTML = '<div class="round-empty">Loading…</div>';
  const rows = await readLeaderboard(10).catch(() => []);
  if (!rows.length) {
    list.innerHTML = '<div class="round-empty">No referrers yet. Share your link to be the first.</div>';
    return;
  }
  const me = chain.state.account?.toLowerCase();
  list.innerHTML = rows.map((r, i) => `
    <div class="referral-row${r.addr.toLowerCase() === me ? ' is-me' : ''}">
      <span class="referral-rank">#${i + 1}</span>
      <div class="referrer-identity"><i>${r.addr.slice(2, 3).toUpperCase()}</i><div><b>${chain.format.short(r.addr)}</b><span>${r.addr.toLowerCase() === me ? 'you' : 'referrer'}</span></div></div>
      <span>${r.referrals}</span>
      <span>${r.active}</span>
      <strong><img src="/gld-icon-transparent.png" alt=""/> ${chain.format.solIcon(r.lifetime)}</strong>
      <a class="round-explorer" href="${explorerAddress(r.addr)}" target="_blank" rel="noreferrer">View ↗</a>
    </div>`).join('');
};

/**
 * If the visitor arrived via a ?ref=0x… link, bind that referrer once — permanently. Only
 * possible if they've never set one (the contract enforces first-wins). Silent no-op
 * otherwise, so it can run on every connect without nagging.
 */
const applyPendingReferral = async () => {
  const acct = chain.state.account;
  if (!acct) return;
  const params = new URLSearchParams(window.location.hash.split('?')[1] || window.location.search);
  const ref = params.get('ref');
  if (!ref || !/^0x[0-9a-fA-F]{40}$/.test(ref)) return;
  if (ref.toLowerCase() === acct.toLowerCase()) return;

  const existing = await readReferrerOf(acct).catch(() => null);
  if (existing && !/^0x0+$/i.test(existing)) return; // already bound — permanent

  try {
    notify('Setting your referrer (one-time)…');
    const hash = await setReferrer(ref);
    await waitForTx(hash);
    notify('Referrer set — they earn 1% when you claim');
  } catch (error) {
    // Not fatal: the user can still mine; they just have no referrer.
    notify(readableError(error));
  }
};

document.querySelector('#claim-referral-rewards').addEventListener('click', async () => {
  if (!chain.state.account) return notify('Connect wallet to claim referral rewards');
  if (!(referralStats?.claimable > 0n)) return notify('Nothing to claim');
  try {
    notify('Claiming referral rewards…');
    const hash = await claimReferral();
    await waitForTx(hash);
    notify('Referral MYNE claimed');
    referralStats = null;
    await refreshReferral();
  } catch (error) {
    notify(readableError(error));
  }
});
document.querySelector('#referral-flex-card')?.addEventListener('click', () => {
  renderReferral();
  referralFlexDialog?.showModal();
});
referralFlexDialog?.querySelector('[data-ref-flex-close]')?.addEventListener('click', () => referralFlexDialog.close());
referralFlexDialog?.addEventListener('click', (event) => {
  if (event.target === referralFlexDialog) referralFlexDialog.close();
});
referralFlexDialog?.querySelector('#ref-flex-download')?.addEventListener('click', downloadReferralFlexCard);
referralFlexDialog?.querySelector('#ref-flex-copy')?.addEventListener('click', async () => {
  const blob = await createReferralFlexCard();
  if (!blob) return notify('Could not create referral card');
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    notify('Referral card copied');
  } catch {
    await downloadReferralFlexCard();
    notify('Card downloaded');
  }
});
referralFlexDialog?.querySelectorAll('#ref-flex-x, #ref-flex-tg').forEach((shareLink) => {
  shareLink.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!chain.state.account) return notify('Connect wallet to share your referral card');
    const shareWindow = window.open(shareLink.href, '_blank', 'noopener,noreferrer');
    const blob = await createReferralFlexCard();
    if (!blob) return notify('Could not create referral card');
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notify('Referral image copied · paste it into the post');
    } catch {
      await downloadReferralFlexCard();
      notify('Referral image downloaded · attach it to the post');
    }
    if (!shareWindow) notify('Allow popups to open the share window');
  });
});
const menuButton = document.querySelector('#menu-button');
const siteMenu = document.querySelector('#site-menu');
const setMenu = (open) => { if (open) { const bounds = menuButton.getBoundingClientRect(); siteMenu.style.left = `${Math.min(bounds.left, window.innerWidth - 286)}px`; siteMenu.style.top = `${bounds.bottom + 10}px`; } siteMenu.hidden = !open; menuButton.setAttribute('aria-expanded', String(open)); menuButton.classList.toggle('active', open); };
menuButton.addEventListener('click', (event) => { event.stopPropagation(); setMenu(siteMenu.hidden); });
siteMenu.addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (event) => event.key === 'Escape' && setMenu(false));

const workspace = document.querySelector('.workspace');
// Rewards collapse independently from the recent-winners ledger below it. The ledger is never
// nested inside `.rewards-body`, so this state cannot hide previous outcomes.
const rewardsPanel = document.querySelector('.rewards-panel');
const rewardsToggle = document.querySelector('#rewards-toggle');

rewardsToggle?.addEventListener('click', () => {
  const collapsed = rewardsPanel.classList.toggle('collapsed');
  rewardsToggle.setAttribute('aria-expanded', String(!collapsed));
  rewardsToggle.setAttribute('aria-label', collapsed ? 'Expand rewards' : 'Collapse rewards');
});

// Kept as a no-op because a few claim paths still ask for the former overlay.
const setRefinePanel = () => {};

const timeStat = roundSummary.querySelector('.summary-stat:not(.deployed-stat):not(.motherlode-stat)');
const countdownValue = timeStat.querySelector('strong');
const roundNumberLabel = timeStat.querySelector('small');
const timeStatLabel = timeStat.querySelector('span');
timeStatLabel.textContent = 'TIME';
timeStat.insertAdjacentHTML('beforeend', '<i class="round-progress" aria-hidden="true"><span></span></i>');
const roundResults = document.querySelector('.round-results');
const resultRows = [...roundResults.querySelectorAll('.miner')];
roundResults.querySelector('.settlement-result span:nth-child(2) small').textContent = 'OUTCOME · 50/50';
timeStat.classList.add('time-stat');

// The winners list renders INLINE in the last-round panel (in the empty space under the
// settlement summary), not behind a button. Injected after the settlement-result so we don't
// touch the big panel template literal.
let lastResultRoundId = null;
let winnersCacheRound = null; // which round the inline list currently shows (avoids re-scanning each poll)
roundResults.querySelector('.settlement-result')
  ?.insertAdjacentHTML('afterend', '<div class="round-winners" id="round-winners" hidden></div>');
const roundWinnersBox = document.querySelector('#round-winners');

// Populate the inline winners list for `roundId`. Heavy-ish (event scan + multicalls), so callers
// gate on a round change; force=true re-fetches (e.g. after the viewer claims).
async function renderInlineWinners(roundId, account, force = false) {
  if (!force && winnersCacheRound === roundId) return;
  winnersCacheRound = roundId;
  try {
    const { winners, miners, winningSquare, solo } = await readRoundWinners(roundId);
    if (winnersCacheRound !== roundId) return; // a newer round resolved mid-fetch; drop stale result
    roundWinnersBox.hidden = false;
    if (!miners.length) {
      roundWinnersBox.innerHTML = '<div class="round-winners-empty">No miners this round.</div>';
      return;
    }
    // EVERY miner in the round, not just the paid ones. On a solo round only one address is paid,
    // so filtering to winners rendered a single row and hid the fact that others played at all —
    // the draw looked uncontested. Non-winners are dimmed rather than dropped, which also makes
    // "you were on the winning tile but the solo flip went elsewhere" visible instead of silent.
    const paidCount = winners.length;
    const head = paidCount
      ? `${paidCount} paid · ${miners.length} miner${miners.length === 1 ? '' : 's'} · tile #${winningSquare + 1}`
      : `${miners.length} miner${miners.length === 1 ? '' : 's'} · tile #${winningSquare + 1} · no winners`;
    roundWinnersBox.innerHTML =
      `<div class="round-winners-head"><span>${head}</span><small>${solo ? 'winner-take-all' : 'shared by bet size'}</small></div>`
      + miners.map((w) => {
        const you = w.address.toLowerCase() === (account || '').toLowerCase();
        const canClaim = you && w.won && !w.claimed;
        // Losers have no payout to show, so show what they staked — otherwise the row is a name
        // beside a blank column and reads as missing data rather than "did not win".
        // Three states, not two. A winner who already claimed has had their bet record zeroed
        // on-chain, so the exact payout is genuinely unrecoverable — say "won · claimed" rather
        // than render a confident 0.000 that reads as "won nothing".
        const reward = !w.won
          ? `<span class="winner-staked">${solIcon()} ${chain.format.ethSmart(w.wagered)} staked</span>`
          : w.amountKnown
            ? `${solIcon()} ${chain.format.ethSmart(w.eth)} + <img src="/gld-icon-transparent.png" alt=""/> ${chain.format.solIcon(w.bullion)}`
            : '<span class="winner-staked">won · claimed</span>';
        // A near-miss on a solo round is its own outcome: they held the winning tile and the coin
        // flip went to someone else. Worth naming, since "lost" would be misleading.
        const tag = w.isSoloWinner ? '<small class="winner-tag">solo</small>'
          : (!w.won && w.onWinningTile && solo) ? '<small class="winner-tag near">tile hit · flip lost</small>'
          : '';
        return `<div class="winner-row${w.isSoloWinner ? ' solo' : ''}${you ? ' you' : ''}${w.won ? '' : ' lost'}">
          <span class="winner-who">${you ? 'You' : chain.format.short(w.address)}${tag}</span>
          <span class="winner-reward">${reward}</span>
          ${canClaim ? `<button class="claim-round" data-claim-round="${roundId}">Claim</button>` : (you && w.won && w.claimed ? '<small class="winner-claimed">claimed</small>' : '')}
        </div>`;
      }).join('');
  } catch (err) {
    console.warn('winners failed', err);
    if (winnersCacheRound === roundId) { winnersCacheRound = null; roundWinnersBox.hidden = true; }
  }
}

const DRAND_CHAIN = '04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';

async function findMatchingDrandRound(square, totalSquares = 25, searchCount = 500) {
  try {
    const latest = await fetch(
      `https://api.drand.sh/${DRAND_CHAIN}/public/latest`
    ).then(r => r.json());

    for (let round = latest.round; round >= latest.round - searchCount; round--) {
      const data = await fetch(
        `https://api.drand.sh/${DRAND_CHAIN}/public/${round}`
      ).then(r => r.json());

      if (!data.randomness) continue;

      const winner = Number(BigInt("0x" + data.randomness) % BigInt(totalSquares));

      if (winner === square) {
        return {
          round,
          randomness: data.randomness,
          url: `https://api.drand.sh/${DRAND_CHAIN}/public/${round}`,
        };
      }
    }
  } catch (e) {
    console.error(e);
  }

  return null;
}

const { formatClock } = chain.format;

const renderChainCountdown = (state) => {
  const betting = state.phase === 'betting';
  const showingResult = state.phase === 'result';
  bettingOpen = betting; // gates the MINE button (see updateMine)
  timeStat.dataset.phase = state.phase;
  countdownValue.textContent = formatClock(state.secondsLeft);
  roundNumberLabel.textContent = `Round #${roundNo(state.roundId)}`;
  // During bidding the countdown + draining bar carry the state. At zero the compact label
  // changes directly to RESULT for the five-second winner display.
  timeStatLabel.textContent = chain.format.roundPhaseLabel(state.phase);
  const phaseSeconds = betting ? BETTING_SECONDS : WINNER_DISPLAY_SECONDS;
  timeStat.style.setProperty('--round-progress', `${(state.secondsLeft / phaseSeconds) * 100}%`);
  timeStat.classList.toggle('settling', !betting);
  // Deliberately NOT toggling `round-settled` on the control column. That CSS fades the
  // deploy panel to 12% opacity with pointer-events:none. Miners need to configure tiles/amount
  // during the five-second result window so they're ready when the next round opens.
  // "Betting closed" is already signalled by the countdown
  // label and the OPEN/CLOSED stat, and mine() rejects bets outside the window anyway.
  timeStat.setAttribute('aria-label', showingResult
    ? `Round ${roundNo(state.roundId)} result displayed, ${formatClock(state.secondsLeft)} until next round`
    : `Round ${roundNo(state.roundId)} bidding, ${formatClock(state.secondsLeft)} left to deploy`);
};

const renderChainResult = (state) => {
  const { showResultTakeover } = chain.format.roundPresentation(state.phase);
  // Result details belong to the persistent previous-round MINERS panel. Keep the legacy result
  // element hidden so the five-second tile reveal never replaces mining controls or rewards.
  roundResults.hidden = !showResultTakeover;
  const column = document.querySelector('.control-column');
  column?.classList.remove('results-open');
};

// Highlight the winning tile on the grid ONLY for the current round, and only during its final
// five-second result window. Never paint an older round's winner onto a
// fresh betting grid — that's the current round people are betting on right now.
const renderGridWinner = (state) => {
  const cur = state.currentRound;
  const inResult = state.phase === 'result';
  const show = chain.format.roundPresentation(state.phase).showWinningTile && Boolean(cur?.resolved);
  const winSquare = show ? Number(cur.winningSquare) : -1;
  document.querySelectorAll('.slot').forEach((tile) => {
    const isWinner = Number(tile.dataset.slot) - 1 === winSquare;
    tile.classList.toggle('round-winner', isWinner);
    // Result is also the setup window for the NEXT round. Keep every tile interactive while the
    // confirmed winner overlay takes visual priority over selection.
    tile.disabled = false;
    const picked = selected.has(tile.dataset.slot);
    tile.classList.toggle('selected', picked);
    tile.setAttribute('aria-pressed', String(picked));
  });
  document.querySelector('.slot-grid')?.classList.toggle('revealing', show);
  // Hide current-selection markers throughout the short result window, including the RPC
  // confirmation gap before the settled round account arrives.
  document.querySelector('.slot-grid')?.classList.toggle('in-reveal', inResult);
};

// --- chain rendering -----------------------------------------------------------------

const connectButton = document.querySelector('#connect-wallet');
const deployedValue = document.querySelector('.deployed-token-value');
const deployedUsdValue = document.querySelector('.deployed-usd-value');
const motherlodePrimaryValue = document.querySelector('.motherlode-primary-value');
const motherlodeSecondary = document.querySelector('.motherlode-secondary');
const motherlodeEthValue = motherlodeSecondary.querySelector('.motherlode-eth-value');
const motherlodeEthUsdValue = motherlodeSecondary.querySelector('.motherlode-eth-usd');
const balanceLabel = document.querySelector('.amount-label small');
let availableEth = 0;
let lastRoundId = null;

const motherlodeRolls = new WeakMap();

/** Smoothly count a Motherlode value upward while preserving its on-chain display precision. */
const rollMotherlodeValue = (element, nextValue, targetText) => {
  if (!element) return;
  const next = Number(nextValue);
  const previous = Number(element.dataset.rollTarget);
  const running = motherlodeRolls.get(element);
  if (running) cancelAnimationFrame(running.frame);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canRoll = Number.isFinite(previous)
    && Number.isFinite(next)
    && next > previous
    && !reducedMotion
    && !document.hidden
    && !targetText.startsWith('<');

  element.dataset.rollTarget = String(next);
  if (!canRoll) {
    element.textContent = targetText;
    element.classList.remove('rolling-up');
    motherlodeRolls.delete(element);
    return;
  }

  const displayed = Number(element.textContent.replace(/[^0-9.-]/g, ''));
  const from = Number.isFinite(displayed) ? displayed : previous;
  const decimals = targetText.includes('.') ? targetText.split('.')[1].length : 0;
  const startedAt = performance.now();
  const duration = 900;
  element.classList.remove('rolling-up');
  // Restart the lightweight lift even when consecutive chain updates arrive close together.
  void element.offsetWidth;
  element.classList.add('rolling-up');

  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = (from + ((next - from) * eased)).toFixed(decimals);
    if (progress < 1) {
      const state = { frame: requestAnimationFrame(tick), target: next };
      motherlodeRolls.set(element, state);
      return;
    }
    element.textContent = targetText;
    element.classList.remove('rolling-up');
    motherlodeRolls.delete(element);
  };

  motherlodeRolls.set(element, { frame: requestAnimationFrame(tick), target: next });
};

// The "Last round" quick bar in the deploy panel shipped with hardcoded mockup data
// (tile 16 / a fake winner) AND a progress bar filled to a fixed 62% that was wired to nothing.
// Both are gone: the markup now starts at a neutral `#— —` so a slow first read shows a dash
// rather than inventing a round, and this fills it from the real last resolved round — the
// winning tile plus the winner (solo) or the outcome (split / rolled forward).
const lastRoundAside = document.querySelector('.last-round aside');
let lastRoundBarKey = null;
const updateLastRoundBar = (lr) => {
  if (!lastRoundAside || !lr || lr.winningSquare === undefined) return;
  const key = String(lr.roundId);
  if (lastRoundBarKey === key) return; // only redraw when the resolved round changes
  lastRoundBarKey = key;
  const tile = Number(lr.winningSquare) + 1;
  const w = lr.singleMinerWinner;
  const soloWinner = lr.singleMinerRound && w && !/^0x0+$/i.test(w);
  const who = soloWinner ? chain.format.short(w)
    : lr.singleMinerRound ? 'No winner'
      : lr.totalWager > 0n ? 'Split'
        : 'No bets';
  lastRoundAside.innerHTML = `${icon('grid')} #${tile} <b>${who}</b> ${icon('chevron')}`;
};
// Track what the claimable list was last computed for, so it refetches when the wallet
// connects/switches or a new round resolves — but not on every render tick.
let claimsAccount = null;
let claimsResolvedKey = '';
// Totals of unclaimed winning rounds, shared between renderClaimable (which computes them)
// and renderChain (which paints the badge every tick).
let claimableTotals = { count: 0, bullion: 0n, eth: 0n };
/** MYNE a claim would actually deliver: mined − fee + passive. Labels the claim button. */
let netReceivable = 0n;

/**
 * Is this tile already carrying a wager from this address this round?
 *
 * One bet per tile per round is a UI rule, not a contract rule — deliberately. Enforcing it
 * on-chain would break auto-round: BullionAutoCommitV2 bets on your behalf via betFor, so a plan
 * covering a tile you had also bet manually would revert on the KEEPER, stranding rounds you had
 * already paid for. Here the worst case is that someone bypasses the guard with another client and
 * simply tops up, which the contract handles correctly (betOf accumulates, the miner count does
 * not double-count).
 */
const tileLocked = (slotId) => chain.state.phase === 'betting'
  && Boolean(document.querySelector(`.slot[data-slot="${slotId}"]`)?.classList.contains('has-position'));

const renderTiles = (state) => {
  document.querySelectorAll('.slot').forEach((tile) => {
    const square = Number(tile.dataset.slot) - 1;
    const total = state.squareTotals[square] ?? 0n;
    const mine = state.myBets[square] ?? 0n;
    const amount = chain.format.ethSmart(total);
    const amountEl = tile.querySelector('strong');
    if (amountEl && amountEl.textContent !== amount) amountEl.textContent = amount;
    setMineUsdValue(amountEl, Number(total) / 1e9);
    // PRESENTATION ONLY — the value itself is untouched. ethSmart emits 5 to 9 characters
    // ("1.234" up to "<0.000001"), and the longest ones are wider than a tile at the narrower
    // board sizes, where `.slot { overflow: hidden }` silently cut the SOL mark in half. CSS
    // steps the type down for these; nothing is rounded, shortened or hidden.
    setClass(tile, 'is-long-value', amount.length >= 7);
    setClass(tile, 'is-very-long-value', amount.length >= 9);
    setClass(tile, 'has-position', mine > 0n);
    // A bet that lands mid-selection must not stay staged for a second one. The lock itself is
    // read straight off `has-position` (see tileLocked) rather than mirrored into a second Set —
    // one source of truth, and it clears by itself when the next round zeroes the position.
    const slotId = tile.dataset.slot;
    if (state.phase === 'betting' && mine > 0n && selected.delete(slotId)) {
      tile.classList.remove('selected');
      tile.setAttribute('aria-pressed', 'false');
    }
    setClass(tile, 'is-mined', mine > 0n);
    setAttr(tile, 'aria-label', `Tile ${tile.dataset.slot}, ${chain.format.solIcon(total)} SOL deployed${mine > 0n ? `, your position ${chain.format.solIcon(mine)} SOL` : ''}`);
    // Miners on this tile — the real on-chain count from `getBettorsOnSquare`, not a wager.
    // It previously showed the CALLER'S OWN STAKE behind a users icon and a "N miners"
    // aria-label, so the figure contradicted its own label, and `hidden` on a zero stake
    // meant a disconnected visitor saw no counts at all. The crowd on a tile is public and
    // is exactly what a visitor weighs before deploying, so it renders unconditionally.
    const badge = tile.querySelector('.tile-miner-count');
    if (badge) {
      const miners = Number(state.squareMiners?.[square] ?? 0n);
      if (badge.hidden) badge.hidden = false;
      const b = badge.querySelector('b');
      if (b && b.textContent !== String(miners)) b.textContent = String(miners);
      setAttr(badge, 'aria-label', `${miners} miner${miners === 1 ? '' : 's'}`);
      // Empty tiles keep their count but recede: on a quiet round all 25 read "0", and at
      // equal weight that noise is what you have to look past to spot the two that aren't.
      setClass(badge, 'is-empty', miners === 0);
    }
  });
};

const renderChain = (state) => {
  renderChainCountdown(state);
  renderChainResult(state);
  renderTiles(state);
  renderGridWinner(state);
  scheduleRoundMinersRefresh(state);

  // The headline deployed figure is a compact summary, so keep it at two decimals. All
  // underlying wager values remain full base-unit precision for tiles and transactions.
  const deployedSolText = (Number(state.totalWager) / 1e9).toFixed(2);
  setMarkedValue(deployedValue, solIcon('summary-eth'), deployedSolText);
  setMineUsdValue(deployedValue, Number(state.totalWager) / 1e9);
  const deployedUsdText = usdFor(Number(state.totalWager) / 1e9) ?? '$—';
  deployedUsdValue.textContent = deployedUsdText;
  deployedHeading.dataset.solLabel = `≈${deployedSolText} SOL`;
  deployedHeading.dataset.usdLabel = `≈${deployedUsdText}`;
  deployedStat.setAttribute('aria-label', `Deployed ${deployedSolText} SOL${deployedUsdText === '$—' ? '' : `, approximately ${deployedUsdText}`}`);
  const motherlodeGldText = chain.format.solIcon(state.jackpot.bullion, 2);
  const displayedMotherlodeNative = displayedMotherlodeSol(
    state.jackpot.native,
    state.totalWager,
    Boolean(state.currentRound?.resolved),
  );
  const motherlodeEthText = chain.format.ethSmart(displayedMotherlodeNative);
  rollMotherlodeValue(motherlodePrimaryValue, Number(state.jackpot.bullion) / 1e9, motherlodeGldText);
  rollMotherlodeValue(motherlodeEthValue, Number(displayedMotherlodeNative) / 1e9, motherlodeEthText);
  const motherlodeUsdText = usdFor(Number(displayedMotherlodeNative) / 1e9) ?? '$—';
  motherlodeEthUsdValue.textContent = motherlodeUsdText;
  motherlodeHeading.dataset.solLabel = `≈${motherlodeEthText} SOL`;
  motherlodeHeading.dataset.usdLabel = `≈${motherlodeUsdText}`;
  syncSummaryHoverLabels();
  motherlodeStat.setAttribute('aria-label', `Motherlode SOL payment ${motherlodeEthText} SOL plus staking bonus ${motherlodeGldText} MYNE, burned and staked at 5× reward weight; 1 in 650 chance per round`);

  availableEth = Number(chain.format.solIcon(state.balance, 6));
  paintMineBalance();

  // `state.unclaimed` is the UNREFINED balance — MYNE credited by claimed rounds and not yet
  // withdrawn (the contract calls it withdrawUnrefinedBullion). It is NOT the value of unclaimed
  // wins, and it stays 0 until those rounds are claimed. The panel header is labelled UNREFINED
  // for that reason: reading "UNCLAIMED 0.000" directly above "2 winning rounds to claim · 2.000"
  // made two different quantities look like one broken one.
  const unrefined = chain.format.solIcon(state.unclaimed);
  // Both the badge and the panel header lead with what the miner can act on FIRST: the MYNE in
  // unclaimed wins when there are any, otherwise the unrefined balance. They must agree — the
  // header used to be hardwired to the unrefined figure, so pressing a badge that read "5.000"
  // opened a panel headed "0.000", which reads as a bug even though both numbers were right.
  const pendingGld = claimableTotals.count > 0;
  // Claiming pays BOTH assets, so both are shown; the unrefined balance is MYNE only, so it is not
  // padded with a meaningless 0 SOL.
  const headline = pendingGld
    ? `${solIcon()} ${chain.format.ethSmart(claimableTotals.eth)} · <img src="/gld-icon-transparent.png" alt=""/> ${chain.format.solIcon(claimableTotals.bullion)}`
    : `<img src="/gld-icon-transparent.png" alt=""/> ${unrefined}`;
  // REWARDS rows (the card under the deploy panel). Kept here so they follow the same refresh as
  // the rest of the claim surface rather than drifting on their own timer.
  const setRow = (id, v) => { const n = document.querySelector(id); if (n) n.textContent = v; };
  // Mined MYNE = already credited in miner state + still owed by unclaimed winning rounds.
  // Round rewards are credited LAZILY — `_addUserRewardToTotalUnclaimed` runs inside the claim —
  // so `state.unclaimed` is 0 for a win you have not claimed yet. Showing it alone rendered 0.000
  // beside a claim button offering 0.600, which is the one case this panel exists for.
  setRow('#rw-eth', chain.format.ethSmart(claimableTotals.eth));
  // Same pair the claimable-rounds box used to show: what is sitting in won-but-unclaimed rounds.
  // ALL mined MYNE not yet in the wallet, which is two buckets: `state.unclaimed` (what an SOL-only
  // claim leaves behind, plus redistribution credited to you) and `claimableTotals.bullion` (won
  // rounds not yet claimed at all). Feeding it only the second read 0.000 while 0.600 sat in the
  // first. The expanded Mined row shows this gross amount; the card title is populated with the
  // net claimable amount below, after the protocol fee calculation.
  const unclaimedGld = state.unclaimed + claimableTotals.bullion;
  setRow('#rw-mined', chain.format.solIcon(unclaimedGld));
  const grossMined = state.unclaimed + claimableTotals.bullion;
  // Passive has THREE sources, and only summing all three matches what the claim actually pays:
  //   1. `refinedAccrued` — already checkpointed into the miner's state
  //   2. the uncheckpointed delta on `rewardsBullion` (folded in by readMiner)
  //   3. rounds WON BUT NEVER CLAIMED — invisible to 1 and 2, because the reward has not entered
  //      the miner state yet. The contract back-dates these to each round's resolve index at claim
  //      time, so an account that has never claimed accrues real MYNE while the row shows 0.000.
  const refined = (state.refinedAccrued ?? 0n)
    + chain.passiveOnRounds(claimableRounds, state.minerIndex ?? 0n);
  // PASSIVE = the redistribution share ALONE — other miners' claim fees credited to you through
  // minerIndex. This row used to be fed netClaimable (gross - fee + refined), which is the net
  // PAYOUT, not passive income: it contradicted its own name, and the one number that explains
  // why waiting pays had nowhere to appear. It is also the only component never charged a fee,
  // which is worth saying out loud.
  // Keep passive MYNE aligned with the mined MYNE row: both use the shared
  // three-decimal token format so the reward columns remain visually consistent.
  setRow('#rw-passive', chain.format.solIcon(refined));
  // NET = what actually lands in the wallet. Same figure the row above used to show. Held in a
  // variable because the claim BUTTON needs it too — it used to be labelled with the gross mined
  // amount while this row said something larger, so the passive share looked unclaimable.
  netReceivable = chain.netClaimable({
    grossMined,
    refinedAccrued: refined,
    totalUnclaimed: state.totalUnclaimed ?? 0n,
    hasReferrer: Boolean(state.hasReferrer),
  });
  // The title is the actionable balance: exactly what can reach the wallet. The expanded Mined
  // row deliberately remains gross so the 10% claim deduction stays independently verifiable.
  setRow('#rw-unclaimed-gld', chain.format.solIcon(netReceivable));
  // Explain a zero rather than letting it read as broken: early on nobody has claimed yet, so
  // there are no fees to redistribute.
  const passiveNote = document.querySelector('#rw-passive-note');
  if (passiveNote) {
    passiveNote.textContent = refined === 0n
      ? 'accrues when other miners claim'
      : 'from other miners’ claim fees · never charged a fee';
  }
  setRow('#mined-chip-value', chain.format.solIcon(state.unclaimed + claimableTotals.bullion));
  const ethBtn = document.querySelector('#claim-eth-only');
  const allBtn = document.querySelector('#claim-all');
  if (ethBtn) ethBtn.disabled = claimableTotals.count === 0;
  // "Claim All" covers BOTH exits, because from the user's side they are one intent: take what
  // I have earned. There are two on-chain paths and which applies is an implementation detail:
  //   - unclaimed ROUNDS      -> claimMany()               (pays SOL + MYNE)
  //   - unrefined MINER STATE -> withdrawUnrefinedBullion() (MYNE only)
  // An SOL-only claim — which is EVERY claim during premine — settles the round but leaves the
  // MYNE behind, so afterwards `claimableTotals.count` is 0 while a real MYNE balance remains. The
  // button used to grey out there, showing a number with no way to take it.
  const refinable = state.unclaimed ?? 0n;
  if (allBtn && !isPremine) {
    const hasRounds = claimableTotals.count > 0;
    allBtn.disabled = !hasRounds && refinable === 0n;
    // Label with what LANDS IN THE WALLET, not the gross mined figure. The old label showed
    // `refinable` (mined only) while the row directly above said "You receive" and a larger number,
    // because passive MYNE is paid whole and carries no fee. Two different numbers on adjacent
    // controls, with no button next to the bigger one, reads as "the passive part is not included" —
    // it is, in the same single transfer.
    allBtn.textContent = hasRounds
      ? 'Claim All'
      : (refinable > 0n ? `Refine → ${chain.format.solIcon(netReceivable)} MYNE` : 'Claim All');
  }
  const headStrong = document.querySelector('.claim-heading > strong');
  if (headStrong) headStrong.innerHTML = headline;
  // ...and the label says which of the two it is, so the number is never ambiguous.
  const headingLabel = document.querySelector('.claim-heading .eyebrow');
  if (headingLabel) headingLabel.textContent = isPremine ? 'MINED · LOCKED' : (pendingGld ? 'CLAIMABLE' : 'UNREFINED');
  // The standalone "Claim <n> MYNE" button that used to live here is removed. It called
  // withdrawUnrefinedBullion() — the only UI exit for the contract's `unclaimed` MYNE bucket, which
  // is what an SOL-only claim leaves behind. It reverts during premine anyway (GldLockedDuringPremine),
  // so nothing is reachable-but-broken today; post-launch that bucket needs a way out again.

  renderPlan(state);

  connectButton.textContent = state.account ? chain.format.short(state.account) : 'Connect';
  connectButton.classList.toggle('connected', Boolean(state.account));

  // Rounds page hero mirrors the same live round/countdown.

  if (lastRoundId !== String(state.roundId)) {
    lastRoundId = String(state.roundId);
    // The header advertises the live staking APR on every page. Refresh once per mining round;
    // readStakingMetrics samples its own 30-minute window, so this stays current without adding a
    // second high-frequency poll or competing with the mining render loop.
    if (protocolReady) void refreshStakingMetrics();
    if (autoRound && randomMode && selected.size) randomizeSelectedTiles();
    // A new round id means the previous one finished — pull it into history immediately.
    if (document.body.dataset.route === 'rounds') refreshRoundHistory({ force: true });
  }
  updateLastRoundBar(state.lastResolved);

  // Claimable rounds depend on the connected account, and a freshly resolved round can add
  // one. The initial load runs before the wallet is restored, so without this the panel
  // would report "nothing to claim" forever. Only refetch on an actual change.
  const resolvedKey = state.lastResolved ? String(state.lastResolved.roundId) : '';
  if (state.account !== claimsAccount || resolvedKey !== claimsResolvedKey) {
    const accountChanged = state.account !== claimsAccount;
    claimsAccount = state.account;
    claimsResolvedKey = resolvedKey;
    if (state.account) {
      refreshRoundHistory({ force: true });
      // …and again shortly after, because this fires the moment the CHAIN says the round settled,
      // while the claimable panel is built from the Supabase index the backend fills on its own 3s
      // tail poll. Refreshing only once loses that race about as often as it wins it, and the next
      // trigger is a whole round away (~80s) — so a miner who just won sits looking at "nothing to
      // claim". These retries cost two cached queries and close the gap to a couple of seconds.
      scheduleClaimCatchUp();
    } else {
      // A disconnected visitor has no account-specific claims. Do not fetch or fall back to a
      // 2,000-round chain scan merely to prove that the anonymous balance is zero.
      claimableRounds = [];
      claimableTotals = { count: 0, bullion: 0n, eth: 0n };
      claimableUnknown = 0;
      renderClaimable();
    }

    // On a new connection: bind any ?ref= referrer (one-shot), then reload referral stats.
    if (accountChanged && state.account) {
      referralStats = null;
      applyPendingReferral().finally(refreshReferral);
    } else if (accountChanged) {
      referralStats = null;
      renderReferral();
    }
    if (accountChanged) { refreshStaking(); refreshSwap(); }
  }

  updateMine();
};

chain.setNotifier(notify);
let offRouteRenderKey = '';
chain.subscribe((state) => {
  // The local clock emits every second. Only Mine needs a 25-tile DOM traversal at that cadence;
  // other routes redraw on meaningful account/round/phase/result changes and on re-entry.
  const key = `${state.account || ''}:${state.roundId}:${state.phase}:${state.lastResolved?.roundId || ''}`;
  if (document.body.dataset.route === 'mine' || key !== offRouteRenderKey) {
    offRouteRenderKey = key;
    renderChain(state);
  }
});

/**
 * Live chat, profiles and news. The social layer knows nothing about how this
 * app connects wallets — it only gets this adapter, so the two stay separable.
 */
// Live SOL/USD polling + the hover tooltip that converts any SOL figure on the page.
if (protocolReady) mountSolPrice();
// No pool before launch, so nothing ever quotes MYNE and the pill would hold an em dash for the
// whole premine. Show the fixed pre-launch price instead; refreshSwap takes the pill over with the
// real spot price on its first poll once liquidity exists.
// Both conditions on purpose: !poolAvailable is what leaves the pill empty, but the fixed price is
// a PREMINE statement. If a pool read ever fails after launch, an em dash is the honest answer —
// a hardcoded $100 sitting over a live market would not be.
if (isPremine && !poolAvailable) showPremineMynePrice();

const ensureSocial = () => {
  if (socialPromise) return socialPromise;
  socialPromise = import('./social/index.js')
    .then(({ mountSocial }) => {
      social = mountSocial({
        notify,
        getAccount: () => chain.state.account,
        connectWallet: () => chain.connectWallet(),
        setRoute: (route, options) => setRoute(route, options),
        subscribe: (fn) => chain.subscribe(fn),
        chatRequiresMinedRounds: NETWORK.cluster === 'mainnet-beta',
        getMinedRoundCount: countMyBetRounds,
        // Passed through the adapter rather than imported by the social layer: `copyText` carries
        // the clipboard fallback for non-secure contexts, and the one-way coupling stays intact.
        copyText,
      });
      return social;
    })
    .catch((error) => {
      socialPromise = null;
      console.warn('social module failed to load', error);
      return null;
    });
  return socialPromise;
};

// Pointer/focus intent loads chat immediately. Otherwise wait for an idle period and only warm it
// on routes where chat is visible; Stake/Swap/History visitors never pay for Supabase or stickers.
const socialPanelElement = document.querySelector('.chat-panel');
socialPanelElement?.addEventListener('pointerenter', () => { void ensureSocial(); }, { once: true, passive: true });
socialPanelElement?.addEventListener('focusin', () => { void ensureSocial(); }, { once: true });
let socialIdleHandle = 0;
scheduleSocialLoad = (route) => {
  if (route !== 'mine' || socialPromise || socialIdleHandle) return;
  const warm = () => {
    socialIdleHandle = 0;
    if (document.body.dataset.route === 'mine') void ensureSocial();
  };
  if ('requestIdleCallback' in window) {
    socialIdleHandle = window.requestIdleCallback(warm, { timeout: 2500 });
  } else {
    socialIdleHandle = window.setTimeout(warm, 1800);
  }
};
scheduleSocialLoad(document.body.dataset.route);

/**
 * Keep every page live without a manual refresh.
 *
 * The Mine page already updates itself (chain.subscribe fires on each poll tick). The other
 * pages only loaded on navigation, so values like referral earnings or staking rewards went
 * stale while you watched them. This polls ONLY the page currently on screen — and pauses
 * entirely when the tab is hidden — so it stays cheap on RPC.
 */
const PAGE_POLL_MS = 10000;
const STAKING_POLL_MS = 5000;
const ROUNDS_POLL_MS = 4000;
window.setInterval(() => {
  if (document.hidden || !protocolReady) return;
  refreshGldPrice();   // route-independent: the Motherlode headline needs it on Mine too
  switch (document.body.dataset.route) {
    case 'referrals':
      refreshReferral(true);
      renderLeaderboard(true);
      renderMyReferrals(true);
      break;
    case 'stake':
      // A dedicated five-second loop below owns staking reads so the claimable
      // SOL balance responds promptly as the minute-based 8% fee is distributed.
      break;
    case 'swap':
      refreshSwap();
      break;
    case 'rounds':
      break; // the dedicated four-second loop below is the single owner
    case 'mine':
      // Round state arrives via chain.subscribe, but the CLAIMABLE panel is built from the
      // Supabase index and had no periodic refresh here at all — so any settlement its event
      // hook missed stayed invisible. Unforced, so the 3s cache absorbs the cost.
      if (chain.state.account) refreshRoundHistory();
      break;
    default:
      // Static/content routes do not need mining-history traffic.
      break;
  }
}, PAGE_POLL_MS);

window.setInterval(() => {
  if (document.hidden || !protocolReady || document.body.dataset.route !== 'stake') return;
  refreshStaking();
}, STAKING_POLL_MS);

// Rounds page gets its own faster loop — history should land seconds after settlement.
window.setInterval(() => {
  if (document.hidden || !protocolReady || document.body.dataset.route !== 'rounds') return;
  if (!document.querySelector('.round-entry.expanded')) refreshRoundHistory({ force: true });
}, ROUNDS_POLL_MS);

// Catch up immediately when the tab regains focus, rather than waiting for the next tick.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !protocolReady) return;
  const route = document.body.dataset.route;
  if (route === 'referrals') { refreshReferral(true); renderLeaderboard(true); }
  else if (route === 'stake') refreshStaking();
  else if (route === 'rounds') refreshRoundHistory({ force: true });
});

/**
 * Header wallet button.
 *
 * Disconnected → start the connect flow. Connected → open an account menu.
 * This used to fire a native `confirm('Disconnect wallet?')`, which made the
 * only account action a destructive one and left the profile reachable solely
 * from inside the chat panel.
 */
/**
 * MYNE price pill -> token links. The pill was inert: the styles for this panel already shipped
 * (`.token-menu*` in style.css) and `dexscreenerUrl` was already exported from config, but nothing
 * ever built the markup or bound a handler, so clicking it did nothing.
 *
 * The DexScreener URL is derived from the V4 poolId rather than pasted, because the poolId is a
 * hash of the pool key — currencies, fee, tickSpacing and the hook address — so any redeploy
 * changes it. A hardcoded link would silently point at a dead pool. `dexscreenerUrl` is null when
 * the pool is not configured, and that entry is then simply omitted rather than rendered broken.
 */
const tokenPill = document.querySelector('#gld-price-pill');
const tokenMenu = document.querySelector('#token-menu');

const closeTokenMenu = () => {
  if (!tokenMenu) return;
  tokenMenu.hidden = true;
  tokenPill?.setAttribute('aria-expanded', 'false');
};

if (tokenPill && tokenMenu) {
  tokenMenu.innerHTML = `
    <div class="token-menu-summary">
      <img src="/gld-icon-transparent.png" alt="" aria-hidden="true" />
      <span><b>MYNE</b><small>Solana</small></span>
      <strong data-gld-price>${document.querySelector('#gld-price')?.textContent || '—'}</strong>
    </div>
    <nav class="token-menu-links" aria-label="MYNE market links"></nav>`;
  const linkHost = tokenMenu.querySelector('.token-menu-links');
  const links = [
    { href: explorerAddress(addresses.BullionToken), label: 'Explorer', note: 'View token contract' },
    dexscreenerUrl && { href: dexscreenerUrl, label: 'Market', note: 'Chart, liquidity and trades' },
  ].filter(Boolean);
  for (const l of links) {
    const a = document.createElement('a');
    a.href = l.href;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.innerHTML = '<span><b></b><small></small></span><i aria-hidden="true">↗</i>';
    a.querySelector('b').textContent = l.label;
    a.querySelector('small').textContent = l.note;
    a.addEventListener('click', closeTokenMenu);
    linkHost.appendChild(a);
  }
  tokenPill.addEventListener('click', (event) => {
    event.stopPropagation(); // otherwise the document handler below closes it in the same tick
    const open = tokenMenu.hidden;
    tokenMenu.hidden = !open;
    tokenPill.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (!tokenMenu.hidden && !tokenMenu.contains(event.target) && !tokenPill.contains(event.target)) closeTokenMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTokenMenu(); });
}

const accountMenu = document.querySelector('#header-account-menu');

const closeAccountMenu = () => {
  accountMenu.hidden = true;
  connectButton.setAttribute('aria-expanded', 'false');
};

const onDocCloseAccount = (event) => {
  if (!accountMenu.hidden
    && !accountMenu.contains(event.target)
    && !connectButton.contains(event.target)) {
    closeAccountMenu();
  }
};
document.addEventListener('click', onDocCloseAccount);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccountMenu(); });

/**
 * Balances shown in the account panel, straight from the polled chain state.
 *
 * Labels deliberately match what the rest of the app already calls these exact values —
 * `unclaimed` is UNCLAIMED on the Mine page and `refinedAccrued` is ACCRUED in the claim
 * breakdown. They previously read "Miner State" (the contract's `getMinerState` function name,
 * which means nothing to a user) and "Dividends", so the same figure appeared twice under two
 * names.
 */
const accountStats = () => {
  // Rewards reach a miner in TWO stages: winning a round credits nothing until `claim(roundId)`,
  // and only then does it land in the balance that `getMinerState` reports as awaiting refine.
  // Counting the second stage alone made the panel read "Unclaimed 0.000" next to a Refine panel
  // headed "14 winning rounds" — technically the refinable balance, but wrong to a reader.
  const pendingBullion = claimableRounds.reduce((sum, r) => sum + r.userBullion, 0n);
  // A win pays SOL as well as MYNE, and the Refine panel already lists both per round
  // ("0.0022 + 1.000"), so the summary shows both rather than silently dropping the SOL.
  const pendingEth = claimableRounds.reduce((sum, r) => sum + r.userEth, 0n);
  return [
    ['Stakeable', { bullion: chain.state.bullionBalance }],
    ['Unclaimed', { eth: pendingEth, bullion: chain.state.unclaimed + pendingBullion }],
    ['Accrued', { bullion: chain.state.refinedAccrued }],
  ];
};

const renderAccountMenu = () => {
  const account = chain.state.account;
  if (!account) return;
  accountMenu.textContent = '';
  // Reassigned after a successful save so the field's "current" value stays accurate.
  let profile = social?.getMyProfile?.() ?? null;
  const { min: NAME_MIN, max: NAME_MAX } = social?.nameLimits ?? { min: 2, max: 24 };

  // ── address + copy ──────────────────────────────────────────────────────
  const addrRow = document.createElement('div');
  addrRow.className = 'account-address';
  const addrText = document.createElement('b');
  addrText.textContent = chain.format.short(account);
  addrText.title = account;
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'account-copy';
  copyBtn.setAttribute('aria-label', 'Copy wallet address');
  copyBtn.title = 'Copy address';
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>';
  copyBtn.addEventListener('click', async () => {
    if (await copyText(account)) {
      notify('Address copied');
    } else {
      notify('Could not copy — copy it from your wallet');
    }
  });
  addrRow.append(addrText, copyBtn);
  accountMenu.appendChild(addrRow);

  // ── avatar + username ───────────────────────────────────────────────────
  const idRow = document.createElement('div');
  idRow.className = 'account-identity';

  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'account-avatar';
  const avatarEl = social?.buildAvatar?.(profile?.displayName, profile?.avatarUrl, account);
  if (avatarEl) avatarWrap.appendChild(avatarEl);
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.hidden = true;
  const camera = document.createElement('button');
  camera.type = 'button';
  camera.className = 'account-avatar-edit';
  camera.setAttribute('aria-label', 'Change profile picture');
  camera.title = 'Change picture';
  camera.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>';
  // The whole avatar is the target, not just the badge — the picture is the
  // obvious thing to click. The badge stays a real <button> so it is reachable
  // by keyboard; its click bubbles here, so only one handler is needed.
  avatarWrap.addEventListener('click', () => fileInput.click());
  avatarWrap.title = 'Change picture';
  avatarWrap.append(camera, fileInput);
  idRow.appendChild(avatarWrap);

  const nameField = document.createElement('label');
  nameField.className = 'account-name-field';
  const nameLabel = document.createElement('span');
  nameLabel.textContent = 'Username';

  const nameRow = document.createElement('div');
  nameRow.className = 'account-name-row';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = NAME_MAX;
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.placeholder = 'Choose a username';
  nameInput.value = profile?.displayName || '';

  // Explicit confirm/cancel rather than save-on-blur: renaming is a signed
  // action, so it should never fire from merely clicking away.
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'account-name-btn cancel';
  cancelBtn.title = 'Discard changes';
  cancelBtn.setAttribute('aria-label', 'Discard username changes');
  cancelBtn.textContent = '✕';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'account-name-btn confirm';
  confirmBtn.title = 'Save username';
  confirmBtn.setAttribute('aria-label', 'Save username');
  confirmBtn.textContent = '✓';

  nameRow.append(nameInput, cancelBtn, confirmBtn);
  nameField.append(nameLabel, nameRow);
  idRow.appendChild(nameField);
  accountMenu.appendChild(idRow);

  // Mirrors what the server and the 0003 CHECK actually enforce.
  const hint = document.createElement('p');
  hint.className = 'account-hint';
  hint.textContent = `${NAME_MIN}–${NAME_MAX} characters · letters, numbers, _ and -`;
  accountMenu.appendChild(hint);

  const setHint = (message, kind) => {
    hint.textContent = message;
    hint.dataset.kind = kind || '';
  };
  const resetHint = () => setHint(`${NAME_MIN}–${NAME_MAX} characters · letters, numbers, _ and -`);

  const currentName = () => profile?.displayName || '';

  /**
   * ✕/✓ appear only once the field differs from what is saved. Visibility is
   * tied to that, NOT to focus — hiding them on blur would remove the buttons
   * before the click on them could land.
   */
  let saving = false;
  let availability = null; // true | false | null (unknown)

  const isDirty = () => nameInput.value.trim() !== currentName();
  const syncButtons = () => {
    const dirty = isDirty() && !saving;
    nameRow.classList.toggle('dirty', dirty);
    cancelBtn.hidden = !dirty;
    confirmBtn.hidden = !dirty;
    confirmBtn.disabled = availability === false;
  };

  let availabilityToken = 0;
  const checkAvailability = async () => {
    const value = nameInput.value.trim();
    availability = null;
    if (!isDirty()) { resetHint(); syncButtons(); return; }
    if (value.length < NAME_MIN || value.length > NAME_MAX) {
      setHint(`Username must be ${NAME_MIN}–${NAME_MAX} characters`, 'error');
      syncButtons();
      return;
    }
    const token = ++availabilityToken;
    setHint('Checking…');
    const free = await social.checkNameAvailable(value);
    if (token !== availabilityToken) return; // a newer keystroke won
    availability = free;
    if (free === true) setHint('Available', 'ok');
    else if (free === false) setHint('That username is taken', 'error');
    else resetHint(); // lookup failed — stay quiet rather than guess
    syncButtons();
  };

  let checkTimer = 0;
  nameInput.addEventListener('input', () => {
    syncButtons();
    window.clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => { void checkAvailability(); }, 350);
  });

  const cancelEdit = () => {
    window.clearTimeout(checkTimer);
    availabilityToken += 1;
    availability = null;
    nameInput.value = currentName();
    resetHint();
    syncButtons();
  };

  const commitName = async () => {
    const next = nameInput.value.trim();
    if (saving || !isDirty()) return;
    if (next.length < NAME_MIN || next.length > NAME_MAX) {
      setHint(`Username must be ${NAME_MIN}–${NAME_MAX} characters`, 'error');
      return;
    }
    saving = true;
    syncButtons();
    setHint('Saving…');
    try {
      await social.saveProfile({ displayName: next });
      profile = social.getMyProfile();
      setHint('Saved', 'ok');
      renderChain(chain.state);
    } catch (err) {
      setHint(err.message || 'Could not save username', 'error');
      nameInput.value = currentName();
    } finally {
      saving = false;
      syncButtons();
    }
  };

  cancelBtn.addEventListener('click', cancelEdit);
  confirmBtn.addEventListener('click', () => { void commitName(); });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void commitName(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  });

  syncButtons();

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    setHint('Uploading picture…');
    try {
      const dataUrl = await social.fileToAvatarDataUrl(file);
      await social.saveProfile({ avatarDataUrl: dataUrl });
      setHint('Picture updated', 'ok');
      // Re-render so the new avatar shows without reopening the panel.
      renderAccountMenu();
    } catch (err) {
      setHint(err.message || 'Could not upload picture', 'error');
    }
  });

  // ── on-chain stats ──────────────────────────────────────────────────────
  const stats = document.createElement('div');
  stats.className = 'account-stats';
  for (const [label, value] of accountStats()) {
    const row = document.createElement('div');
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('b');
    // Token marks, not bare numbers: with SOL and MYNE side by side in one row, the figures
    // are ambiguous without them. Both are 18-decimal but format differently — ethSmart trims
    // SOL to something readable, solIcon() is the 3dp form the Refine panel uses for MYNE.
    const parts = [];
    if (value.eth !== undefined) {
      parts.push(`${solIcon('account-stat-mark')} ${chain.format.ethSmart(value.eth)}`);
    }
    if (value.bullion !== undefined) {
      parts.push(`<img class="account-stat-mark" src="/gld-icon-transparent.png" alt="MYNE"/> ${chain.format.solIcon(value.bullion)}`);
    }
    v.innerHTML = parts.join('<i class="account-stat-plus">+</i>');
    row.append(l, v);
    stats.appendChild(row);
  }
  accountMenu.appendChild(stats);

  // ── disconnect ──────────────────────────────────────────────────────────
  const disconnect = document.createElement('button');
  disconnect.type = 'button';
  disconnect.className = 'account-disconnect';
  disconnect.textContent = 'Disconnect';
  disconnect.addEventListener('click', () => {
    closeAccountMenu();
    chain.disconnectWallet();
    notify('Wallet disconnected');
  });
  accountMenu.appendChild(disconnect);
};

connectButton.addEventListener('click', async (event) => {
  event.stopPropagation();
  if (!chain.state.account) {
    chain.connectWallet();
    return;
  }
  if (accountMenu.hidden) {
    await ensureSocial();
    renderAccountMenu();
    accountMenu.hidden = false;
    connectButton.setAttribute('aria-expanded', 'true');
  } else {
    closeAccountMenu();
  }
});
connectButton.setAttribute('aria-haspopup', 'menu');
connectButton.setAttribute('aria-expanded', 'false');
document.querySelector('#deploy').addEventListener('click', () => chain.mine({
  tiles: [...selected].map(Number),
  // Same rule the panel displays — the wallet must be asked for exactly what the total showed.
  ethPerTile: chain.effectiveEthPerTile(amountSolValue, selected.size),
  auto: autoRound,
  // Always unlimited plays: the deposit is what limits the plan, so the stepper alone
  // decides how long it runs — and a paused plan can be topped up instead of re-created.
  plays: chain.UNLIMITED_PLAYS,
  fundRounds: repeatRounds,
  autoClaim: autoRound && autoClaimEnabled,
}));
// Delegated: the plan panel is re-rendered on every state change.
document.querySelector('#auto-plan').addEventListener('click', (event) => {
  if (event.target.closest('#cancel-plan')) chain.cancelAutoPlan();
  if (event.target.closest('#topup-plan')) chain.topUpPlan(10);
  if (event.target.closest('#approve-delegate')) chain.approveAutoClaim();
});

// Claim buttons inside the Refine panel (delegated — the list is re-rendered on refresh).
document.querySelector('.claim-panel').addEventListener('click', async (event) => {
  const all = event.target.closest('#claim-all');
  const ethOnly = event.target.closest('#claim-eth-only');
  if (!all && !ethOnly) return;

  const ids = claimableRounds.map((r) => r.roundId);
  (all || ethOnly).disabled = true;
  try {
    if (all) {
      // Two on-chain exits, one user intent. Unclaimed ROUNDS settle through claimMany (SOL+MYNE);
      // MYNE already sitting in miner state — what an SOL-only claim leaves behind, which is every
      // claim made during premine — only comes out through withdrawUnrefinedBullion. Pick whichever
      // actually applies rather than greying the button out and stranding a visible balance.
      if (ids.length > 0) {
        // One signature per 15 rounds — a single one for any normal backlog, batched only when the
        // list is long enough that one transaction would not fit.
        await chain.claimMany(ids);
      } else {
        await chain.refine();
      }
    } else {
      await chain.claimEthOnly(ids);
    }
  } finally {
    (all || ethOnly).disabled = false;
  }
  await refreshRoundHistory();
});
roundResults.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-claim-round]');
  if (!button) return;
  const roundId = BigInt(button.dataset.claimRound);
  button.disabled = true;
  await chain.claim(roundId);
  // Reflect the claim in the inline winners list (your row -> "claimed").
  if (lastResultRoundId === roundId) renderInlineWinners(roundId, chain.state.account, true);
});

/** One social panel: inline on Mine and moved into the bottom drawer on phones. */
const chatPanelNode = document.querySelector('.chat-panel');

const chatDrawer = document.querySelector('#chat-drawer');
/** Matches the phone-shell breakpoint in style.css — keep the two in step. */
const PHONE = window.matchMedia('(max-width: 720px)');

/**
 * On a phone the panel always lives in the bottom drawer.
 */
const chatHostFor = () => {
  if (PHONE.matches) return chatDrawer;
  return workspace;
};

/**
 * The sibling the panel sits in FRONT of on Mine, captured before any move.
 *
 * `.workspace` is a three-column grid with no `order` on any child, so a child's column is
 * decided purely by its DOM position — and chat is the FIRST of the three. Appending it on the
 * way back therefore shifts the board and controls one column left, squeezing the 5×5 grid into
 * the narrow chat column.
 */
const chatHomeAnchor = chatPanelNode?.nextElementSibling ?? null;

const relocateChat = (route) => {
  if (!chatPanelNode) return;
  const host = chatHostFor();
  if (!host || chatPanelNode.parentElement === host) return;
  // Return to the exact Mine slot; insertBefore(node, null) degrades to append if the anchor ever
  // stops existing.
  if (host === workspace) host.insertBefore(chatPanelNode, chatHomeAnchor);
  else host.appendChild(chatPanelNode);
  // Moving a node resets its scrollTop to 0 — the TOP of the list, i.e. the oldest message. Put
  // the reader back on the newest one, which is what they were looking at before the move.
  social?.showLatestMessages?.();
  // Crossing the breakpoint (rotation, desktop resize) has to hand the panel back.
  if (!PHONE.matches) closeSheets();
};

/** Toggle the Mine social panel and its fixed reopen control. */
const setChat = (visible) => {
  workspace.classList.toggle('chat-hidden', !visible);
  document.querySelector('#show-chat')?.classList.toggle('visible', !visible);
  // Opening it should always land on the newest message. On a phone the drawer was display:none
  // until this moment, so any scroll position set while it was hidden was thrown away.
  if (visible) social?.showLatestMessages?.();
};
// closeSheets() is a no-op off-phone, and on a phone it is what actually dismisses the drawer —
// the panel's own ✕ has to work there too, not just the CHAT tab.
document.querySelector('#hide-chat').addEventListener('click', () => { setChat(false); closeSheets(); });
document.querySelector('#show-chat').addEventListener('click', () => { setRoute('mine'); setChat(true); });
const compactChat = window.matchMedia('(max-width: 900px)');
const syncChatLayout = () => setChat(!compactChat.matches);
compactChat.addEventListener('change', syncChatLayout);
syncChatLayout();

/* --- phone shell: bottom tab bar, action sheet, chat + more drawers -------------------------
 *
 * One rule keeps this simple: at most ONE sheet is open at a time, and `closeSheets()` is the
 * only way anything closes. Body classes do the work so the CSS owns every transition, and
 * nothing here moves a node except chat (see chatHostFor).
 */
const scrim = document.querySelector('#sheet-scrim');
const moreSheet = document.querySelector('#more-sheet');

const closeSheets = () => {
  chatDrawer?.classList.remove('open');
  moreSheet?.classList.remove('open');
  if (scrim) scrim.hidden = true;
  syncTabbar();
};

/**
 * Chat is a DESTINATION, not an overlay: it takes the whole viewport between the header and the
 * bar, like any other tab. So it gets no scrim — there is nothing behind it to look through to.
 * MORE is the opposite: a short list that should read as temporary, so it stays a dimmed sheet.
 */
const openSheet = (which) => {
  const target = which === 'chat' ? chatDrawer : moreSheet;
  const already = target?.classList.contains('open');
  closeSheets();
  if (already) return; // tapping the same tab twice closes it
  if (which === 'chat') setChat(true);
  target?.classList.add('open');
  if (scrim && which === 'more') scrim.hidden = false;
  syncTabbar();
};

function syncTabbar() {
  const route = document.body.dataset.route;
  const overlay = chatDrawer?.classList.contains('open') || moreSheet?.classList.contains('open');
  // A route tab reads as active only when nothing is covering its page.
  document.querySelectorAll('.tabbar .tab[data-route]').forEach((t) => t.classList.toggle('active', !overlay && t.dataset.route === route));
  document.querySelector('#tab-chat')?.classList.toggle('active', Boolean(chatDrawer?.classList.contains('open')));
  document.querySelector('#tab-more')?.classList.toggle('active', Boolean(moreSheet?.classList.contains('open')));
}

document.querySelector('#tab-chat')?.addEventListener('click', () => openSheet('chat'));
document.querySelector('#tab-more')?.addEventListener('click', () => openSheet('more'));
scrim?.addEventListener('click', closeSheets);
document.querySelectorAll('[data-sheet-close]').forEach((b) => b.addEventListener('click', closeSheets));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
// Navigating away from a sheet's page should not leave it hanging over the new one.
document.querySelectorAll('.tabbar .tab[data-route], .sheet-links button[data-route]').forEach((b) => b.addEventListener('click', closeSheets));
PHONE.addEventListener('change', () => { relocateChat(document.body.dataset.route); closeSheets(); });

// --- rounds page (real on-chain history) ---------------------------------------------

const roundList = document.querySelector('.round-list');
const roundMetrics = document.querySelectorAll('[data-page="rounds"] .feature-metrics article strong');

// MYNE supply row on the Rounds header: Max / Total mined / Current / Burned (see chain/supply.js).
// Injected after the existing metrics so we don't touch the big page template literal.
document.querySelector('[data-page="rounds"] .feature-metrics')?.insertAdjacentHTML('afterend',
  '<section class="feature-metrics supply-metrics">'
  + '<article><span>MAX SUPPLY</span><strong id="sup-max">—</strong><small>hard cap</small></article>'
  + '<article><span>TOTAL MINED</span><strong id="sup-supplied">—</strong><small>mining emissions</small></article>'
  + '<article><span>CURRENT</span><strong id="sup-current">—</strong><small>circulating</small></article>'
  + '<article><span>BURNED</span><strong id="sup-burned">—</strong><small id="sup-burned-detail"></small></article>'
  + '</section>');
const gld = (x) => `<img src="/gld-icon-transparent.png" alt=""/> ${(x / 10n ** 9n).toLocaleString()}`;
const renderSupply = async () => {
  try {
    const s = await readSupplyStats();
    document.querySelector('#sup-max').innerHTML = gld(s.max);
    // Keep mined emissions separate from current supply: current includes the 100 MYNE genesis
    // mint plus every subsequent on-chain emission (and reflects any burns).
    // Current supply is the protocol accounting view: genesis mint + mining emissions - burns.
    // This keeps the displayed figure meaningful even when an RPC token-supply snapshot lags.
    const mined = roundStats?.minted ?? 0n;
    const burned = s.burned ?? 0n;
    const genesis = BigInt(LAUNCH_GENESIS_MYNE) * 10n ** 9n;
    const current = genesis + mined - burned;
    document.querySelector('#sup-supplied').innerHTML = gld(mined);
    document.querySelector('#sup-current').innerHTML = gld(current > 0n ? current : 0n);
    document.querySelector('#sup-burned').innerHTML = gld(s.burned);
    document.querySelector('#sup-burned-detail').textContent =
      `buyback ${(s.burnedBuyback / 10n ** 9n).toLocaleString()} · staking ${(s.burnedStaking / 10n ** 9n).toLocaleString()}`;
  } catch (err) { console.warn('supply stats failed', err); }
};
const explorerContract = `${solanaNetwork.blockExplorers.default.url}/address/${addresses.BullionGridLottery}`;
const explorerTx = (hash) => `${solanaNetwork.blockExplorers.default.url}/tx/${hash}`;
// roundId -> settlement tx hash (or null). Filled lazily when a row is expanded; survives
// re-renders so re-expanding is instant.
const settlementTxCache = new Map();
let roundFilter = 'all';
let roundHistory = [];
// Paginated FULL history (see chain/rounds-page.js). These mirror loadRoundHistory's return.
let roundPage = 0;
let roundPages = 1;
let roundStats = null;
let roundTruncated = false;
// Unclaimed wins across ALL history (not just the visible page) — drives the Mine-page
// claimable panel and claim-all, which must reach winning rounds on any page.
let claimableRounds = [];
let claimableUnknown = 0;
/**
 * Round ids whose detail is open.
 *
 * The Rounds page re-renders every 20s (`roundList.innerHTML = ...`), which destroys every node
 * and with it `detail.hidden`, `aria-expanded` and `.expanded`. An open row therefore snapped
 * shut a few seconds after being clicked. Keeping the state outside the DOM lets the render
 * restore it.
 */
const expandedRounds = new Set();
// First / ‹ / page / › / Last — paged history like the reference ORE UIs. Footer under the list.
roundList.insertAdjacentHTML('afterend',
  '<div class="round-pagination" id="round-pagination" hidden>'
  + '<button data-round-page="first">First</button>'
  + '<button data-round-page="prev" aria-label="Previous page">‹</button>'
  + '<span class="round-page-label" id="round-page-label">1 / 1</span>'
  + '<button data-round-page="next" aria-label="Next page">›</button>'
  + '<button data-round-page="last">Last</button>'
  + '</div>');

const relTime = (ts) => {
  // `ts` is a BLOCK timestamp, so it must be differenced against chain time. On a device
  // running 5 minutes fast every settled round reads "5 min ago" the instant it lands.
  const diff = Math.max(0, Number(chain.nowSeconds()) - Number(ts));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

const roundMinersList = document.querySelector('#round-miners-list');
const roundMinersLabel = document.querySelector('#round-miners-label');
const confirmedMinerByWallet = new Map();
let roundMinerCard = null;
let roundMinerCloseTimer = 0;
let confirmedMinerRenderedKey = '';
let confirmedMinerRequestKey = '';
let roundMinerFetchTimer = 0;
let confirmedMinerFetchAttempt = 0;
let confirmedMinerPage = 0;
let confirmedMinerRows = [];
const CONFIRMED_MINERS_PAGE_SIZE = 10;

const minerRoundResult = (miner) => {
  return {
    resolved: true,
    ethWon: miner.eth ?? 0n,
    gldWon: miner.bullion ?? 0n,
    winningSquare: Number(miner.winningSquare),
  };
};

const closeRoundMinerCard = () => {
  window.clearTimeout(roundMinerCloseTimer);
  roundMinerCard?.remove();
  roundMinerCard = null;
};
const scheduleRoundMinerCardClose = () => {
  window.clearTimeout(roundMinerCloseTimer);
  roundMinerCloseTimer = window.setTimeout(closeRoundMinerCard, 180);
};

const positionRoundMinerCard = (anchor) => {
  if (!roundMinerCard) return;
  const rect = anchor.getBoundingClientRect();
  const cardWidth = roundMinerCard.offsetWidth || 324;
  const cardHeight = roundMinerCard.offsetHeight || 370;
  const left = rect.left > cardWidth + 22 ? rect.left - cardWidth - 12 : rect.right + 12;
  roundMinerCard.style.left = `${Math.max(10, Math.min(window.innerWidth - cardWidth - 10, left))}px`;
  roundMinerCard.style.top = `${Math.max(76, Math.min(window.innerHeight - cardHeight - 10, rect.top - 30))}px`;
};

const openRoundMinerCard = (wallet, anchor) => {
  const miner = confirmedMinerByWallet.get(wallet.toLowerCase());
  if (!miner) return;
  closeRoundMinerCard();
  const result = minerRoundResult(miner);
  const card = document.createElement('aside');
  card.className = 'round-miner-card';
  card.setAttribute('role', 'tooltip');
  card.addEventListener('mouseenter', () => window.clearTimeout(roundMinerCloseTimer));
  card.addEventListener('mouseleave', scheduleRoundMinerCardClose);
  const grid = miner.tileBets.map((amount, index) => {
    const classes = [amount > 0n ? 'has-bid' : '', result.winningSquare === index ? 'winning' : ''].filter(Boolean).join(' ');
    const title = amount > 0n ? ` title="Tile ${index + 1}: ${chain.format.ethSmart(amount)} SOL"` : '';
    return `<i class="${classes}"${title}>${index + 1}</i>`;
  }).join('');
  const solReward = result.resolved
    ? `${solIcon('miner-card-eth')}<b>${chain.format.ethSmart(result.ethWon)}</b>`
    : '<em>Pending result</em>';
  const myneReward = result.resolved
    ? `<img src="/gld-icon-transparent.png" alt=""/><b>${chain.format.solIcon(result.gldWon)}</b>`
    : '<em>Pending result</em>';
  card.innerHTML = `<header><span>ROUND #${roundNo(miner.roundId)}</span><code title="${miner.address}">${chain.format.short(miner.address)}</code></header><div class="round-miner-grid">${grid}</div><footer><span>DEPLOYED</span><strong>${solIcon('miner-card-eth')}<b>${chain.format.ethSmart(miner.deployed)}</b></strong><span>SOL REWARD</span><strong>${solReward}</strong><span>MYNE REWARD</span><strong>${myneReward}</strong></footer>`;
  document.body.appendChild(card);
  roundMinerCard = card;
  positionRoundMinerCard(anchor);
};

const walletProfileCache = new Map();
const loadWalletProfile = async (wallet) => {
  const key = wallet.toLowerCase();
  if (walletProfileCache.has(key)) return walletProfileCache.get(key);
  const pending = fetch(`/rounds/api/profile/${key}`, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  walletProfileCache.set(key, pending);
  return pending;
};

const paintRoundMinerIdentity = async (row, wallet) => {
  const profile = await loadWalletProfile(wallet);
  if (!row.isConnected) return;
  const displayName = profile?.displayName || chain.format.short(wallet);
  row.querySelector('.round-miner-name-text').textContent = displayName;
  const avatar = row.querySelector('.round-miner-avatar');
  const url = profile?.avatarUrl ? social?.avatarUrlFor?.(wallet, profile.avatarUrl) : null;
  if (!url) {
    avatar.textContent = displayName.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '0X';
    return;
  }
  const img = new Image();
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => { avatar.textContent = displayName.slice(0, 2).toUpperCase(); });
  img.src = url;
  avatar.replaceChildren(img);
};

const renderConfirmedMiners = (miners, roundId, winningSquare) => {
  if (!roundMinersList) return;
  const confirmedMiners = miners.map((miner) => ({ ...miner, roundId, winningSquare }));
  // A settled round should always have at least one miner. If an RPC/indexer briefly returns an
  // empty roster, preserve the last confirmed panel instead of replacing it with a misleading
  // empty-state message.
  if (!confirmedMiners.length && roundMinersList.children.length) return;
  confirmedMinerByWallet.clear();
  confirmedMiners.forEach((miner) => confirmedMinerByWallet.set(miner.address.toLowerCase(), miner));
  confirmedMinerRows = confirmedMiners;
  confirmedMinerPage = Math.min(
    confirmedMinerPage,
    Math.max(0, Math.ceil(confirmedMiners.length / CONFIRMED_MINERS_PAGE_SIZE) - 1),
  );
  if (roundMinersLabel) {
    roundMinersLabel.textContent = `ROUND #${roundNo(roundId)} · WINNING TILE #${winningSquare + 1} · ${confirmedMiners.length} MINER${confirmedMiners.length === 1 ? '' : 'S'}`;
  }
  roundMinersList.textContent = '';
  const pageCount = Math.max(1, Math.ceil(confirmedMiners.length / CONFIRMED_MINERS_PAGE_SIZE));
  const pagination = document.querySelector('#round-miners-pagination');
  const pageLabel = document.querySelector('#round-miners-page-label');
  if (pagination && pageLabel) {
    // Keep the controls present as a stable affordance even for a single page or
    // an empty/transient roster; unavailable directions are visibly disabled.
    pagination.hidden = false;
    pageLabel.textContent = `${confirmedMinerPage + 1} / ${pageCount}`;
    pagination.querySelector('[data-miners-page="prev"]').disabled = confirmedMinerPage === 0;
    pagination.querySelector('[data-miners-page="next"]').disabled = confirmedMinerPage >= pageCount - 1;
  }
  if (!confirmedMiners.length) {
    return;
  }
  const pageStart = confirmedMinerPage * CONFIRMED_MINERS_PAGE_SIZE;
  const pageRows = confirmedMiners.slice(pageStart, pageStart + CONFIRMED_MINERS_PAGE_SIZE);
  pageRows.forEach((miner) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'round-miner-row';
    row.dataset.wallet = miner.address.toLowerCase();
    row.classList.toggle('won', Boolean(miner.won));
    const isAutoBurn = Boolean(
      miner.autoRound && (miner.autoBurn || miner.autoMode === 'burn' || miner.rewardMode === 'burn')
      || (chain.state.account && autoRound && miner.address.toLowerCase() === chain.state.account.toLowerCase() && autoRewardMode === 'burn'),
    );
    row.classList.toggle('auto-burn', isAutoBurn);
    const soloMyneWinner = Boolean(miner.isSoloWinner);
    row.setAttribute('aria-label', `${chain.format.short(miner.address)}${isAutoBurn ? ', auto-burn participant' : ''}${soloMyneWinner ? ', solo MYNE winner' : ''}, deployed ${chain.format.ethSmart(miner.deployed)} SOL. Open for round rewards.`);
    const soloMyneBadge = soloMyneWinner
      ? '<span class="solo-myne-badge" aria-label="Solo MYNE reward"><b aria-hidden="true">+</b><img src="/gld-icon-transparent.png" alt=""/></span>'
      : '';
    const tileCount = Number(miner.tiles ?? 0);
    row.innerHTML = `<i class="round-miner-avatar">${icon('user')}</i><b class="round-miner-name"><span class="round-miner-name-text">${chain.format.short(miner.address)}</span>${soloMyneBadge}</b><span class="round-miner-value"><span class="round-miner-tiles" aria-label="${tileCount} tiles bid" title="${tileCount} tiles bid">${icon('grid')}<b>${tileCount}</b></span><strong>${solIcon('round-miner-eth')}<b>${chain.format.ethSmart(miner.deployed)}</b></strong></span>`;
    row.addEventListener('mouseenter', () => openRoundMinerCard(miner.address, row));
    row.addEventListener('mouseleave', scheduleRoundMinerCardClose);
    row.addEventListener('focus', () => openRoundMinerCard(miner.address, row));
    row.addEventListener('blur', scheduleRoundMinerCardClose);
    row.addEventListener('click', () => openRoundMinerCard(miner.address, row));
    roundMinersList.appendChild(row);
    void paintRoundMinerIdentity(row, miner.address);
  });
  try {
    localStorage.setItem('myne-previous-miners', JSON.stringify({ roundId: String(roundId), winningSquare, miners: confirmedMiners }, (_, value) => typeof value === 'bigint' ? { __bigint: value.toString() } : value));
  } catch { /* private storage or quota; live chain data remains authoritative */ }
};

// Paint the last confirmed roster immediately on reload while the current RPC request catches up.
// This avoids an empty/loading state even though the chain read is asynchronous.
try {
  const cached = JSON.parse(localStorage.getItem('myne-previous-miners') || 'null', (_, value) => value && value.__bigint !== undefined ? BigInt(value.__bigint) : value);
  if (cached?.miners?.length && cached.roundId !== undefined) {
    renderConfirmedMiners(cached.miners, cached.roundId, Number(cached.winningSquare));
    confirmedMinerRenderedKey = String(cached.roundId);
  }
} catch { /* ignore malformed or unavailable cache */ }

const scheduleRoundMinersRefresh = (state) => {
  if (!protocolReady) return;
  const confirmed = state.lastResolved;
  if (!shouldRefreshConfirmedMiners(confirmed, confirmedMinerRenderedKey, confirmedMinerRequestKey)) return;
  const key = confirmedMinerRoundKey(confirmed);
  confirmedMinerRequestKey = key;
  confirmedMinerFetchAttempt = 0;
  window.clearTimeout(roundMinerFetchTimer);
  const fetchConfirmedMiners = async () => {
    const requestedRound = confirmed.roundId;
    // The panel must describe exactly currentRound - 1. A rollover can happen while the RPC
    // request is in flight, so never paint a response that is no longer adjacent to the live UI.
    const expectedPrevious = previousConfirmedRoundId(chain.state.roundId);
    if (expectedPrevious === null || String(expectedPrevious) !== String(requestedRound)) return;
    // Receipt scans are cached for normal reads, but a new confirmed round must always start
    // from a fresh scan. Otherwise the first read can race the final deployment and preserve the
    // previous roster forever because an empty result is treated as a transient RPC response.
    invalidateReceiptCache();
    try {
      const result = await readRoundWinners(requestedRound);
      if (String(chain.state.lastResolved?.roundId) !== String(requestedRound)) return;
      if (String(previousConfirmedRoundId(chain.state.roundId)) !== String(requestedRound)) return;
      if (!result.miners.length && confirmedMinerFetchAttempt < 8) {
        confirmedMinerFetchAttempt += 1;
        roundMinerFetchTimer = window.setTimeout(fetchConfirmedMiners, 750);
        return;
      }
      renderConfirmedMiners(previousRoundMinerRoster(result), requestedRound, result.winningSquare);
      confirmedMinerRenderedKey = key;
    } catch (error) {
      // Keep the older confirmed result visible. A transient RPC failure must not replace a
      // known-good miner roster with an error or an empty state.
      console.warn('confirmed miners refresh failed', error);
    } finally {
      if (confirmedMinerRequestKey === key
        && (confirmedMinerRenderedKey === key || String(chain.state.lastResolved?.roundId) !== String(requestedRound))) {
        confirmedMinerRequestKey = '';
      }
    }
  };
  roundMinerFetchTimer = window.setTimeout(fetchConfirmedMiners, 250);
};

const renderPagination = () => {
  const bar = document.querySelector('#round-pagination');
  const label = document.querySelector('#round-page-label');
  if (!bar || !label) return;
  bar.hidden = roundPages <= 1;
  label.textContent = `${roundPage + 1} / ${roundPages}`;
  const atFirst = roundPage <= 0;
  const atLast = roundPage >= roundPages - 1;
  bar.querySelector('[data-round-page="first"]').disabled = atFirst;
  bar.querySelector('[data-round-page="prev"]').disabled = atFirst;
  bar.querySelector('[data-round-page="next"]').disabled = atLast;
  bar.querySelector('[data-round-page="last"]').disabled = atLast;
};

const renderRoundHistory = () => {
  // `roundHistory` is already the current page for the active filter (see loadRoundHistory).
  const rows = roundHistory;

  roundList.innerHTML = rows.length ? rows.map((r) => {
    // Rounds with no bets never resolve (the keeper skips them) and rounds still awaiting
    // the keeper have no outcome yet — neither has a winning tile, winner count or payout,
    // so show dashes rather than inventing values from an unset winningSquare.
    if (r.status !== 'settled') {
      const empty = r.status === 'no-bets';
      return `
    <div class="round-entry ${r.status}" data-round-mode="${r.mode}" data-round-id="${r.roundId}">
      <button class="round-record" aria-expanded="false">
        <span class="round-number">#${roundNo(r.roundId)}</span><span class="winning-tile muted">—</span><span class="round-mode ${r.mode}">${empty ? 'no bets' : 'resolving'}</span><span>${solIcon()} 0</span><span class="muted">—</span><time>${relTime(r.endsAt)}</time><i>${icon('chevron')}</i>
      </button>
      <div class="round-detail" hidden>
        <div><span>RESULT</span><strong>${empty ? 'No bets — pot carried forward' : 'Awaiting keeper resolution'}</strong></div>
        <a class="round-explorer" href="${explorerContract}" target="_blank" rel="noreferrer">View contract ↗</a>
      </div>
    </div>`;
    }

    const tile = Number(r.winningSquare) + 1;
    const label = r.mode === 'motherlode' ? 'Motherlode' : r.mode.toUpperCase();
    // A solo round pays exactly ONE miner (chosen among everyone on the tile, bet-weighted),
    // so its paid-winner count is 1 even when several bet the tile. A split round pays every
    // bettor on the tile. Either is zero if nobody was on the winning square (pot rolls
    // forward). `r.winners` is the raw bettor count, which overcounts solo rounds — so derive
    // the true count from the payout mode.
    const soloWinner = r.singleMinerRound && r.singleMinerWinner && !/^0x0+$/i.test(r.singleMinerWinner);
    const winnerCount = r.winners === 0n ? 0n
      : r.singleMinerRound ? (soloWinner ? 1n : 0n)
        : r.winners;
    // Split pays every bettor on the tile; a solo round pays exactly one (bet-weighted), even
    // if several bet it; zero winners rolls forward. RESULT mirrors this.
    const result = winnerCount === 0n ? 'No winners — rolled forward'
      : r.singleMinerRound
        ? `Solo winner · ${chain.format.short(r.singleMinerWinner)}${r.winners > 1n ? ` (1 of ${r.winners})` : ''}`
        : `${winnerCount} miner${winnerCount === 1n ? '' : 's'}`;
    const claimable = r.myBet > 0n && !r.claimed;
    const myLine = r.myBet > 0n
      ? `<div><span>YOUR POSITION</span><strong>${chain.format.ethSmart(r.myBet)} SOL on #${tile}${r.claimed ? ' · claimed' : ''}</strong></div>`
      : '';
    // No claim button here: history is a ledger, and claiming lives in the Refine panel (which
    // lists every claimable round and can settle them in one transaction via claimMany). Two
    // entry points for the same action meant two places to keep in sync for no gain.
    const extra = myLine ? `<div class="round-detail-extra">${myLine}</div>` : '';
    return `
    <div class="round-entry${claimable ? ' claimable' : ''}" data-round-mode="${r.mode}" data-round-id="${r.roundId}">
      <button class="round-record" aria-expanded="false">
        <span class="round-number">#${roundNo(r.roundId)}</span><span class="winning-tile">${icon('grid')} Tile ${tile}</span><span class="round-mode ${r.mode}">${label}</span><span>${solIcon()} ${chain.format.ethSmart(r.totalWager)}</span><span>${winnerCount}</span><time>${relTime(r.endsAt)}</time><i>${icon('chevron')}</i>
      </button>
      <div class="round-detail" hidden data-round-id="${r.roundId}" data-square="${r.winningSquare}" data-payout-mul="${r.payoutMulWad}" data-solo="${r.singleMinerRound ? '1' : ''}" data-winner="${(r.singleMinerWinner || '').toLowerCase()}" data-randomness="${r.randomnessValue ?? ''}" data-wager="${r.totalWager}"${r.drandUrl ? ` data-drand-url="${r.drandUrl}" data-drand-round="${r.drandRound ?? ''}"` : ''}>
        <div><span>RESULT</span><strong>${result}</strong></div>
        <div><span>SETTLEMENT</span><strong class="round-settlement">—</strong></div>
        <div><span>NETWORK</span><strong>Solana</strong></div>
        <a class="round-explorer round-tx-link" href="${explorerContract}" target="_blank" rel="noreferrer">View transaction ↗</a>
        ${extra}
        <div class="round-fairness" hidden></div>
        <div class="round-miners" hidden></div>
      </div>
    </div>`;
  }).join('') : `<div class="round-empty">No ${roundFilter === 'all' ? '' : roundFilter + ' '}rounds yet.</div>`;

  // Re-open whatever was open before this render. The lazy loaders are cached per round, so
  // restoring costs nothing after the first expand.
  for (const id of expandedRounds) {
    const entry = roundList.querySelector(`.round-entry[data-round-id="${id}"]`);
    const detail = entry?.querySelector('.round-detail');
    if (!detail) continue; // row fell off the page or out of the filter
    detail.hidden = false;
    entry.classList.add('expanded');
    entry.querySelector('.round-record')?.setAttribute('aria-expanded', 'true');
    loadSettlement(detail);
    loadFairness(detail);
    loadMiners(detail);
  }

  renderPagination();
  // Metrics summarise ALL of history (from loadRoundHistory), not just the visible page.
  const s = roundStats;
  if (s && roundMetrics.length >= 4) {
    // "ROUNDS" counts every elapsed round; the label clarifies how many were actually mined.
    roundMetrics[0].textContent = String(s.count);
    const minedLabel = roundMetrics[0].parentElement?.querySelector('small');
    if (minedLabel) minedLabel.textContent = `${s.mined} mined${roundTruncated ? ' (capped)' : ''}`;
    roundMetrics[1].innerHTML = `${solIcon()} ${chain.format.ethSmart(s.deployed)}`;
    const averageDeployed = s.mined > 0 ? s.deployed / BigInt(s.mined) : 0n;
    roundMetrics[2].innerHTML = `${solIcon()} ${chain.format.ethSmart(averageDeployed)}`;
    const averageLabel = roundMetrics[2].parentElement?.querySelector('small');
    if (averageLabel) averageLabel.textContent = `${s.mined} mined round${s.mined === 1 ? '' : 's'}`;
    roundMetrics[3].textContent = String(s.jackpots);
  }
};

document.querySelector('#round-miners-pagination')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-miners-page]');
  if (!button || button.disabled) return;
  const pageCount = Math.ceil(confirmedMinerRows.length / CONFIRMED_MINERS_PAGE_SIZE);
  confirmedMinerPage = Math.max(0, Math.min(
    pageCount - 1,
    confirmedMinerPage + (button.dataset.minersPage === 'next' ? 1 : -1),
  ));
  renderConfirmedMiners(confirmedMinerRows, confirmedMinerRows[0]?.roundId, confirmedMinerRows[0]?.winningSquare ?? 0);
});

const refreshRoundHistory = async ({ force = false } = {}) => {
  try {
    const res = await loadRoundHistory({ page: roundPage, filter: roundFilter, account: chain.state.account, force });
    roundHistory = res.rows;
    roundPage = res.page; // clamped if the page count shrank
    roundPages = res.pages;
    roundStats = res.summary;
    roundTruncated = res.truncated;
    claimableRounds = res.claimable ?? [];
    // Rounds whose claim status could not be read. Tracked separately from "none claimable" —
    // an unreadable chain must never render as a confident zero.
    claimableUnknown = res.claimableUnknown ?? 0;
    renderRoundHistory();
    renderSupply(); // MYNE supply row (cached 15s, so this is cheap on the poll)
    // Surface claimable rounds on the Mine page too — `claim(roundId)` is per-round and the
    // reveal overlay is transient, so without this a winning round becomes unreachable.
    renderClaimable();
  } catch (error) {
    console.warn('round history failed', error);
  }
};

// Jump to a page and reload. `first`/`prev`/`next`/`last` or an absolute index.
const goToRoundPage = (target) => {
  const next = target === 'first' ? 0
    : target === 'last' ? roundPages - 1
      : target === 'prev' ? roundPage - 1
        : target === 'next' ? roundPage + 1
          : Number(target);
  roundPage = Math.min(Math.max(0, next), roundPages - 1);
  refreshRoundHistory();
};

/**
 * Live auto-round plan. The keeper executes it each round, so this is the only visible proof
 * the plan is running — and the only way to stop it (cancel refunds the remaining balance).
 */
const renderPlan = (state) => {
  const box = document.querySelector('#auto-plan');
  if (!box) return;
  const plan = state.plan;
  box.hidden = !plan;
  if (!plan) return;

  // A finished plan keeps its unspent deposit until it's withdrawn — show that state
  // explicitly so the balance is never stranded.
  if (!plan.enabled) {
    box.innerHTML = `
      <div class="auto-plan-head">
        <span class="auto-plan-live ended"><i></i>AUTO-ROUND ENDED</span>
        <b>${chain.format.ethSmart(plan.balance)} SOL left</b>
      </div>
      <p class="auto-plan-note">This plan has finished, but its unspent deposit is still held by the contract. Withdraw it back to your wallet.</p>
      <button class="auto-plan-cancel" id="cancel-plan">Withdraw ${chain.format.ethSmart(plan.balance)} SOL</button>`;
    return;
  }

  // For an unlimited plan the play counter is meaningless — what limits it is the balance,
  // so show how many more rounds that balance actually funds.
  // The contract refuses to bet unless balance >= wager + the executor-fee reserve, so a
  // plan can be enabled yet unable to play. Say "needs top-up" rather than "0 rounds left",
  // which reads like it ended.
  const perRoundCost = plan.amountPerPlay + AUTO_FEE_WEI;
  const affordable = perRoundCost > 0n ? plan.balance / perRoundCost : 0n;
  const stalled = affordable === 0n;
  const rounds = plan.unlimited ? `~${affordable}` : String(plan.playsRemaining);
  box.innerHTML = `
    <div class="auto-plan-head">
      <span class="auto-plan-live${stalled ? ' stalled' : ''}"><i></i>${stalled ? 'AUTO-ROUND PAUSED' : 'AUTO-ROUND ACTIVE'}</span>
      <b>${stalled ? 'needs top-up' : `${rounds} round${rounds === '1' ? '' : 's'} left`}</b>
    </div>
    <p class="auto-plan-summary">${plan.tiles.length} tile${plan.tiles.length === 1 ? '' : 's'} · ${chain.format.ethSmart(plan.amountPerPlay)} SOL per round · ${chain.format.ethSmart(plan.balance)} SOL left</p>
    <p class="auto-plan-reward-mode"><b>${autoRewardMode === 'burn' ? 'AUTO-BURN' : 'AUTO-MINE'}</b> · ${autoRewardMode === 'burn' ? 'Stake + burn your MYNE for 5× staking pool weight. 0% Claim Fee' : 'Keep your MYNE in-system and accumulating. 10% Claim Fee'}</p>
    ${stalled ? `<p class="auto-plan-warn">Balance ${chain.format.ethSmart(plan.balance)} SOL is below the ${chain.format.ethSmart(perRoundCost)} SOL needed for one more round (wager + keeper reserve). Top up to resume, or withdraw what's left.</p>` : ''}
    ${plan.autoClaim
      ? `<p class="auto-plan-note">${plan.canClaim
        ? 'SOL winnings are claimed back into the balance automatically. MYNE stays unrefined so it keeps earning dividends.'
        : '⚠ Auto-claim needs delegate approval — winnings are not being claimed.'}</p>`
      : ''}
    ${plan.autoClaim && !plan.canClaim ? '<button class="auto-plan-approve" id="approve-delegate">Approve auto-claim</button>' : ''}
    <div class="auto-plan-actions">
      <button class="auto-plan-topup" id="topup-plan">+10 rounds</button>
      <button class="auto-plan-cancel" id="cancel-plan">Cancel &amp; withdraw</button>
    </div>`;
};

/**
 * Re-poll the claimable panel for a few seconds after a settlement.
 *
 * Timed against the backend indexer's 3s tail poll: the first retry usually lands after the round
 * has been written, the second covers a slow write. Timers are replaced rather than stacked so
 * back-to-back settlements cannot pile up overlapping refreshes.
 */
let claimCatchUpTimers = [];
function scheduleClaimCatchUp() {
  for (const t of claimCatchUpTimers) window.clearTimeout(t);
  claimCatchUpTimers = [2500, 7000].map((delay) => window.setTimeout(() => {
    if (!document.hidden) refreshRoundHistory({ force: true });
  }, delay));
}

const renderClaimable = () => {
  const pending = claimableRounds;
  // PER-USER amounts (this account's share), not the round's total pot.
  claimableTotals = {
    count: pending.length,
    bullion: pending.reduce((sum, r) => sum + r.userBullion, 0n),
    eth: pending.reduce((sum, r) => sum + r.userEth, 0n),
  };



  // The winning-round count, the repeated SOL · MYNE total and the "rewards aren't paid
  // automatically" paragraph are gone: the pair now lives in the Unclaimed row above, so this box
  // was duplicate data plus a note that restated the buttons. It survives for the ONE thing it
  // alone can report — rounds whose claim status could not be read. "We couldn't check N rounds"
  // is information the user needs; hiding it is what turns a network failure into "you won nothing".
  const box = document.querySelector('#claimable-rounds');
  if (!box) return;
  box.hidden = claimableUnknown === 0;
  box.innerHTML = claimableUnknown
    ? `<p class="claimable-note claimable-stale">Couldn't check ${claimableUnknown} round${claimableUnknown === 1 ? '' : 's'} — the network didn't answer. Your rewards are safe on-chain; reload to try again.</p>`
    : '';
};

// Delegated so the handlers survive re-rendering the list.
document.querySelectorAll('[data-round-filter]').forEach((button) => button.addEventListener('click', () => {
  roundFilter = button.dataset.roundFilter;
  document.querySelectorAll('[data-round-filter]').forEach((item) => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  });
  roundPage = 0; // a new filter changes the page count; start at the newest page
  refreshRoundHistory();
}));
document.querySelector('#round-pagination')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-round-page]');
  if (button && !button.disabled) goToRoundPage(button.dataset.roundPage);
});
roundList.addEventListener('click', async (event) => {
  const record = event.target.closest('.round-record');
  if (!record) return;
  const detail = record.nextElementSibling;
  const open = detail.hidden;
  detail.hidden = !open;
  record.setAttribute('aria-expanded', String(open));
  record.parentElement.classList.toggle('expanded', open);
  // Expanded state has to survive the 20s poll, which rebuilds the whole list via innerHTML.
  // Tracking it here rather than reading the DOM back means the re-render can restore it.
  const id = record.parentElement.dataset.roundId;
  if (id) { if (open) expandedRounds.add(id); else expandedRounds.delete(id); }
  if (open) { loadSettlement(detail); loadFairness(detail); loadMiners(detail); }
});

// Lazily fill a round's SETTLEMENT tx hash + "View transaction" link when its row is expanded.
// Cached per round so re-expanding is instant. Only settled rounds carry a data-round-id.
const loadSettlement = async (detail) => {
  const roundId = detail.dataset.roundId;
  const el = detail.querySelector('.round-settlement');
  if (!roundId || !el || el.dataset.loaded) return;
  el.dataset.loaded = '1';
  const link = detail.querySelector('.round-tx-link');
  let tx = settlementTxCache.get(roundId);
  if (tx === undefined) {
    el.textContent = 'loading…';
    tx = await readSettlementTx(BigInt(roundId)).catch(() => null);
    settlementTxCache.set(roundId, tx);
  }
  if (tx) {
    el.textContent = chain.format.short(tx);
    if (link) link.href = explorerTx(tx);
  } else {
    el.textContent = 'not found';
    delete el.dataset.loaded; // let a later expand retry
  }
};
/**
 * "Miners on the winning square" — the roster the chain cannot produce.
 *
 * Payout per miner is their stake x payoutMulWad / 1e18, the same formula the claim panel uses,
 * and it applies to EVERY miner on the winning tile — including in a solo round. Solo changes only
 * `bullionMulWad`, i.e. which single miner takes the MYNE; the SOL pot is split pro rata either way.
 * The `+MYNE` tag marks the solo winner.
 */
/**
 * The fairness strip: winning square, total deployed, and the drand round matched to the tile.
 *
 * Drand links are stored in the database when a round resolves (see backend drand cache).
 * The live api.drand.sh search is only a fallback when the index has no stored link yet.
 */
const loadFairness = async (detail) => {
  const host = detail.querySelector('.round-fairness');
  const roundId = detail.dataset.roundId;
  if (!host || !roundId || host.dataset.loaded) return;
  host.dataset.loaded = '1';

  const randomness = detail.dataset.randomness;
  const square = Number(detail.dataset.square);
  const deployed = detail.dataset.wager ? chain.format.ethSmart(BigInt(detail.dataset.wager)) : null;
  const storedUrl = detail.dataset.drandUrl || null;
  const storedRound = detail.dataset.drandRound ? Number(detail.dataset.drandRound) : null;

  const hash = randomness ? `0x${BigInt(randomness).toString(16).padStart(64, '0')}` : null;
  host.hidden = false;

  host.innerHTML = [
    `<span class="fair-chip">Winning square <b>#${square + 1}</b></span>`,
    deployed
      ? `<span class="fair-item">Total deployed <b>${deployed}</b></span>`
      : '',
    `<span class="fair-drand"></span>`,
    `<span class="fair-note"></span>`,
    randomness
      ? `<button type="button" class="fair-verify">verify</button>`
      : '',
  ].filter(Boolean).join('');

  const renderDrandLink = (matched) => {
    if (!matched) return;
    const drandHost = host.querySelector('.fair-drand');
    if (!drandHost || !host.isConnected) return;
    drandHost.innerHTML = `
    <a class="fair-link"
       href="${matched.url}"
       target="_blank"
       rel="noreferrer">
       drand round #${matched.round} ↗
    </a>
  `;
  };

  if (storedUrl && storedRound != null) {
    renderDrandLink({ url: storedUrl, round: storedRound });
  } else {
    const tryDrand = async (attempt = 0) => {
      const link = await loadDrandLink(roundId).catch(() => null);
      if (link) {
        renderDrandLink(link);
        return;
      }
      const drandHost = host.querySelector('.fair-drand');
      if (!drandHost || !host.isConnected) return;
      drandHost.innerHTML = '<span class="fair-pending muted">drand link pending…</span>';
      // Backend assigns links seconds after settlement — retry until one lands or we give up.
      if (attempt < 24) window.setTimeout(() => tryDrand(attempt + 1), 5000);
    };
    tryDrand();
  }

  const btn = host.querySelector('.fair-verify');
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'checking…';
    const r = await verifyRoundFairness(BigInt(roundId), randomness, square);
    if (!r) { btn.textContent = 'unavailable'; btn.disabled = false; return; }
    btn.replaceWith(renderVerdict(r));
  });
};

/**
 * The verdict, spelled out rather than reduced to a tick.
 *
 * A bare "verified" asks the reader to trust the app — which is the exact thing a fairness
 * panel exists to avoid. Listing the three checks means each one is independently repeatable
 * against the contract.
 */
const renderVerdict = (r) => {
  const wrap = document.createElement('span');
  wrap.className = `fair-verdict ${r.ok ? 'ok' : 'bad'}`;
  const checks = [
    // [`committed ${r.lockedInSeconds}s before close`, r.lockedInSeconds > 0],
    // ['seed matches commitment', r.seedMatches],
    // [`derives tile #${r.derivedSquare + 1}`, r.squareMatches],
  ];
  wrap.innerHTML = `<b>${r.ok ? '✓ verified' : '✗ not verified'}</b>`
    + checks.map(([t, pass]) => `<i class="${pass ? 'pass' : 'fail'}">${pass ? '✓' : '✗'} ${t}</i>`).join('');
  return wrap;
};

const minersCache = new Map();
const loadMiners = async (detail) => {
  const host = detail.querySelector('.round-miners');
  const roundId = detail.dataset.roundId;
  if (!host || !roundId || host.dataset.loaded) return;
  host.dataset.loaded = '1';

  const square = Number(detail.dataset.square);
  const payoutMul = BigInt(detail.dataset.payoutMul || '0');
  const key = `${roundId}:${square}`;
  let rows = minersCache.get(key);
  if (rows === undefined) {
    host.hidden = false;
    host.innerHTML = '<span class="round-miners-head">Loading miners…</span>';
    rows = await loadRoundBets(BigInt(roundId), square).catch(() => null);
    minersCache.set(key, rows);
  }
  if (!rows) { host.hidden = true; delete host.dataset.loaded; return; } // index unavailable
  if (!rows.length) { host.hidden = true; return; }

  // Read from the data attributes, not from the rendered mode cell — the cell is display text
  // and would silently change meaning if the label were ever reworded.
  const solo = detail.dataset.solo === '1';
  const winner = detail.dataset.winner || '';
  host.hidden = false;
  host.innerHTML = `<div class="round-miners-head">
      <span>Miners on the winning square (${rows.length})</span>
      <small>DEPLOYED <i>&rarr;</i> RECEIVED</small>
    </div>`
    + rows.map((m) => {
      // EVERY miner on the winning tile is paid SOL, solo or not. `calculatePayoutMultipliers` in
      // RoundLib computes payoutMulWad the same way in both modes — `singleMinerRound` only changes
      // bullionMulWad. So solo decides who takes the MYNE; the SOL pot is always split pro rata.
      // This used to show "—" for solo non-winners, telling miners who were genuinely owed SOL that
      // they had received nothing.
      const isSoloGldWinner = solo && m.bettor.toLowerCase() === winner;
      const payout = chain.format.ethSmart((m.winningStake * payoutMul) / (10n ** 18n)) + ' SOL';
      const won = true; // on the winning tile => owed SOL
      const spread = m.deployed > m.winningStake
        ? ` title="${chain.format.ethSmart(m.winningStake)} of it on the winning tile"` : '';
      return `<div class="round-miner-row${won ? ' won' : ''}${isSoloGldWinner ? ' solo-gld' : ''}">
        <code>${m.bettor}${isSoloGldWinner ? ' <b class="solo-tag">+MYNE</b>' : ''}</code>
        <span${spread}>${chain.format.ethSmart(m.deployed)}</span>
        <i aria-hidden="true">&rarr;</i>
        <b>${payout}</b>
      </div>`;
    }).join('');
};

document.querySelectorAll('[data-copy-ref]').forEach((button) => button.addEventListener('click', () => {
  if (!chain.state.account) return notify('Connect wallet to get your referral link');
  void copyText(referralUrl);
  notify('Referral link copied');
}));
updateProjection();

window.addEventListener('hashchange', () => setRoute(window.location.hash.slice(1), { updateHash: false }));
window.addEventListener('resize', syncNavIndicator);
syncAutoControls();
updateMine();
updateStake();
setRoute(window.location.hash.slice(1) || 'home', { updateHash: false });
// Release the header only after the initial route has applied its visibility rules. This prevents
// the landing page from flashing the full in-app menu while the module bootstraps.
document.querySelector('#app')?.classList.add('app-ready');
chain.start();
// Price the MYNE leg immediately on load, not on the first 10s poll tick — otherwise the first
// thing a visitor sees is a Motherlode missing most of its value.
if (protocolReady) refreshGldPrice(true);
// Legacy 20s poll removed — ROUNDS_POLL_MS loop above covers the Rounds page.
