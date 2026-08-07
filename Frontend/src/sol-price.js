/**
 * Live SOL/USD, and the hover tooltip that puts a dollar figure on any SOL amount.
 *
 * The preferred price comes from our cached backend (`/rounds/api/sol-price`). Local development
 * and backend outages fall back to validated CoinGecko and Kraken responses; the last good quote
 * stays rendered until a later poll succeeds.
 *
 * Values are NOT rewritten in place. Every SOL figure on the site is rendered by a different piece
 * of code on its own refresh cycle, so injecting a dollar amount into the markup would mean
 * touching all of them and fighting every re-render. A single delegated hover reads whatever the
 * DOM currently says and converts it — no coupling, and it cannot go stale against the number it
 * is describing because it reads that number at hover time.
 */
import { fetchSolPrice } from './chain/sol-price-feed.js';

const ENDPOINT = `${window.location.origin}/rounds/api/sol-price`;
const POLL_MS = 60_000;

let price = null;      // { usd, at, stale } | null
let timer = null;

/** Always two decimals — the price and every converted value read as money, so they format alike. */
const fmtUsd = (usd) => `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Keep the compact header quote and its expanded token panel in sync. */
const paintMynePrice = (value) => {
  document.querySelectorAll('#gld-price, [data-gld-price]').forEach((el) => {
    el.textContent = value;
  });
};

export const getSolUsd = () => price?.usd ?? null;
// Quote-only SOL/USDC rate. The cached endpoint may return `usdc`; older deployments fall back to
// USD parity, while CoinGecko derives it from the independently reported USDC/USD value.
export const getSolUsdc = () => price?.usdc ?? price?.usd ?? null;

/** USD string for an SOL amount, or null when there is no price to convert with. */
export function usdFor(solAmount) {
  const usd = getSolUsd();
  if (usd == null || !Number.isFinite(solAmount)) return null;
  const value = solAmount * usd;
  // Below a cent there is nothing two decimals can say — "$0.00" reads as broken, not as tiny.
  if (value > 0 && value < 0.005) return '< $0.01';
  return fmtUsd(value);
}

/** USDC amount for an SOL amount. This is presentation-only; mining instructions remain SOL. */
export function usdcFor(solAmount) {
  const solUsdc = getSolUsdc();
  if (solUsdc == null || !Number.isFinite(solAmount)) return null;
  const value = solAmount * solUsdc;
  if (value > 0 && value < 0.005) return '< 0.01';
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function poll() {
  const next = await fetchSolPrice(ENDPOINT);
  if (next) {
    price = next;
    window.dispatchEvent(new CustomEvent('solpricechange', {
      detail: { usd: next.usd, usdc: next.usdc ?? next.usd, stale: Boolean(next.stale) },
    }));
  }
  paintHeader();
}

/**
 * The header pill. It shipped hardcoded at $3,451.72, which quietly became fiction the moment the
 * market moved — an em dash until the feed answers is honest, a stale constant is not.
 */
function paintHeader() {
  const el = document.querySelector('#sol-price');
  if (!el) return;
  const usd = getSolUsd();
  el.textContent = usd == null ? '—' : fmtUsd(usd);
  const pill = document.querySelector('#sol-price-pill');
  if (pill) {
    pill.setAttribute('aria-label', usd == null ? 'SOL price unavailable' : `SOL price ${fmtUsd(usd)}`);
    pill.classList.toggle('is-stale', Boolean(price?.stale));
  }
}

/**
 * MYNE has no market price — only what our own launch pool quotes — so it is derived here rather
 * than fetched, and only when the pool can be read. `mynePerSol` comes from the caller because the
 * swap module already reads that state on its own cycle.
 */
export function setMynePerSol(mynePerSol) {
  const el = document.querySelector('#gld-price');
  if (!el) return;
  const usd = getSolUsd();
  const ok = usd != null && Number.isFinite(mynePerSol) && mynePerSol > 0;
  myneUsd = ok ? usd / mynePerSol : null;
  paintMynePrice(ok ? fmtUsd(usd / mynePerSol) : '—');
  const pill = document.querySelector('#gld-price-pill');
  if (pill) pill.setAttribute('aria-label', ok ? `MYNE price ${fmtUsd(usd / mynePerSol)}` : 'MYNE price unavailable');
}

/**
 * USD price of ONE MYNE — the pool's spot price once liquidity exists, the premine placeholder
 * before that, and null when neither is available. Held here because both writers live in this
 * module and every reader wants "whatever MYNE is currently worth" without caring which it is.
 */
let myneUsd = null;

export const getMyneUsd = () => myneUsd;

/**
 * USD value of a pot holding BOTH legs — the Motherlode is SOL and MYNE together, and a headline
 * that priced only the SOL understated it by the larger half.
 *
 * The MYNE leg is only added when something can price it. Before launch that price is the premine
 * placeholder, so the total is a stated projection rather than a market value; after launch it is
 * the pool's spot price and the same sum becomes a real quote. Returns null when there is no SOL
 * price at all, so callers can leave the line blank — "no price" must not render as "$0.00".
 */
export function usdForSolAndMyne(solAmount, myneAmount) {
  const solUsd = getSolUsd();
  if (solUsd == null || !Number.isFinite(solAmount)) return null;
  let value = solAmount * solUsd;
  if (myneUsd != null && Number.isFinite(myneAmount)) value += myneAmount * myneUsd;
  return fmtUsd(value);
}

/**
 * PREMINE ONLY — the pre-launch reference price for MYNE.
 *
 * There is no SOL/MYNE pool until launch, so `setMynePerSol` is never called during premine (see
 * refreshSwap in main.js, which bails on !poolAvailable) and the pill sat on its initial em dash.
 *
 * This is a fixed PLACEHOLDER, not a quote: nothing can be bought or sold at it, and it is not
 * derived from anything on-chain. It exists so the header states the intended launch value instead
 * of a dash. The moment the pool opens, the first swap poll calls setMynePerSol and the real spot
 * price overwrites it — so this needs no removal at launch, but it must be kept in step with
 * whatever the launch price actually ends up being while premine lasts.
 */
export const PREMINE_MYNE_USD = 100;

export function showPremineMynePrice() {
  const el = document.querySelector('#gld-price');
  if (!el) return;
  myneUsd = PREMINE_MYNE_USD;
  // Written flat ("$100"), not through fmtUsd's two decimals: this is a round, chosen number, and
  // "$100.00" claims a precision to the cent that a placeholder does not have.
  paintMynePrice(`$${PREMINE_MYNE_USD.toLocaleString()}`);
  const pill = document.querySelector('#gld-price-pill');
  // Say it is a pre-launch figure: a bare dollar amount in a price pill otherwise reads as a live
  // market quote, which it is not until the pool exists.
  if (pill) {
    pill.setAttribute('aria-label', `MYNE pre-launch price $${PREMINE_MYNE_USD.toLocaleString()}`);
    pill.setAttribute('title', 'Pre-launch reference price — trading opens with liquidity');
  }
}

// ─────────────────────────────────────────────── hover: show the figure in USD, in place
/**
 * The nearest ancestor that owns an SOL mark — `solIcon()` renders `<img class="sol-icon">` immediately
 * before its number, so that image is the reliable anchor for "this element is an SOL amount".
 */
function solHost(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    // Motherlode owns a dedicated whole-column SOL → USD swap. Letting the generic
    // delegated hover also rewrite this row would create two competing effects.
    if (n.classList?.contains('motherlode-secondary')
      || n.classList?.contains('deployed-token-value')
      || n.classList?.contains('staking-sol-pool')) return null;
    if (n.querySelector?.(':scope > img.sol-icon')) return alreadyPricedAlongside(n) ? null : n;
  }
  return null;
}

/**
 * Is this figure's dollar value ALREADY on screen next to it?
 *
 * Some stats (DEPLOYED) render the USD permanently on their own line. Swapping the SOL number
 * there too would print the same dollar figure twice in one stat, which reads as a rendering bug
 * rather than a conversion. Where the value is already stated, hover does nothing.
 */
function alreadyPricedAlongside(host) {
  const parent = host.parentElement;
  if (!parent) return false;
  for (const sib of parent.children) {
    if (sib !== host && sib.textContent.trim().startsWith('$')) return true;
  }
  return false;
}

/**
 * The number belonging to THIS SOL mark.
 *
 * Read only the nodes that follow the mark and stop at the next image, because a combined figure
 * like the Motherlode renders `<img.sol-icon> 0.12 <img bullion> 4.40` in one element — taking the
 * whole textContent there would convert the MYNE amount as if it were SOL.
 */
function solAmountIn(host) {
  const mark = host.querySelector(':scope > img.sol-icon');
  if (!mark) return NaN;
  let text = '';
  // Guard against self-reference: the SOL mark also sits beside the PRICE pill, whose value is
  // already USD. Converting that treats $1,925 as 1,925 SOL and prints millions.
  for (let n = mark.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.tagName === 'IMG') break;
    text += n.textContent ?? '';
  }
  if (text.includes('$') || text.includes('%')) return NaN;
  const m = /-?[\d,]*\.?\d+/.exec(text.replace(/\s+/g, ''));
  return m ? Number(m[0].replace(/,/g, '')) : NaN;
}

/**
 * Swap the SOL number for its USD value, in place.
 *
 * The nodes carrying the number are detached and held, not overwritten, so restoring is exact and
 * nothing has to know how the figure was formatted. If the app re-renders the element while it is
 * hovered, the injected span is orphaned with it — `isConnected` catches that on restore and we
 * simply drop the stale nodes rather than writing an old number back over a fresh one.
 *
 * The SOL mark is hidden along with the number: it is the UNIT, and leaving a diamond beside a
 * dollar figure states the wrong one. CSS does the hiding (`.is-usd > img.sol-icon`) rather than JS, so
 * the image is never detached — see the mouseleave note below for why that matters.
 */
let swap = null;
/** The figure the pointer is currently inside, whether or not the swap is applied. */
let hovered = null;
/** Watches the hovered figure so an app re-render can be re-swapped instead of snapping back. */
let observer = null;
/** True while WE are mutating the host, so the observer ignores its own echo. */
let applying = false;

function showUsd(host) {
  if (swap?.host === host) return;
  restoreSol();
  const label = usdFor(solAmountIn(host));
  if (label == null) return;

  const mark = host.querySelector(':scope > img.sol-icon');
  const nodes = [];
  for (let n = mark.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.tagName === 'IMG') break;
    nodes.push(n);
  }
  if (!nodes.length) return;

  // FLICKER GUARD. The swap must not change the element's box, or the pointer can end up outside
  // it — which fires mouseleave, restores the SOL figure, puts the box back under the pointer,
  // fires mouseover, and swaps again, forever. Two things move the box:
  //   1. hiding the SOL mark (CSS now uses visibility, not display, so its space is kept), and
  //   2. the number itself — "$1,925" is a different width from "0.000".
  // Pinning the pre-swap width covers (2). Read it BEFORE mutating, or it measures the new text.
  const width = host.getBoundingClientRect().width;
  // Mining values live in tightly packed controls; pinning their host width can push adjacent
  // controls or alter the grid when the USD string is wider. Other routes keep the stable width
  // so the hover readout never moves.
  if (document.body.dataset.route !== 'mine' && width > 0) host.style.minWidth = `${width}px`;

  const span = document.createElement('span');
  span.className = 'usd-swap';
  span.textContent = price?.stale ? `${label}*` : label;
  if (price?.stale) span.title = 'Price is a few minutes old';

  applying = true;
  host.insertBefore(span, nodes[0]);
  for (const n of nodes) n.remove();
  host.classList.add('is-usd');
  applying = false;

  swap = { host, nodes, span };
}

function restoreSol() {
  if (!swap) return;
  const { host, nodes, span } = swap;
  swap = null;
  applying = true;
  host.classList.remove('is-usd');
  host.style.minWidth = '';
  // Only put the original nodes back if our span is still where we left it; otherwise the host
  // was re-rendered underneath us and the fresh markup already has the right value.
  if (span.isConnected && span.parentNode === host) {
    for (const n of nodes) host.insertBefore(n, span);
    span.remove();
  }
  applying = false;
}

/**
 * Follow a figure while the pointer sits on it.
 *
 * The page re-renders on every poll tick (round state each second, page data every few seconds).
 * A re-render rewrites the host's children, which silently destroys the injected span — so the
 * figure snapped back to SOL and only returned to USD if the pointer happened to move again.
 * Held still, it read as the number flipping back and forth on its own.
 *
 * Watching only the ONE hovered element keeps this to a single short-lived observer.
 */
function watch(host) {
  unwatch();
  hovered = host;
  observer = new MutationObserver(() => {
    if (applying || hovered !== host || !host.isConnected) return;
    // Our span is gone (the app rewrote the figure) — put the USD reading back.
    if (!swap || swap.host !== host || !swap.span.isConnected) {
      swap = null;
      showUsd(host);
    }
  });
  observer.observe(host, { childList: true, characterData: true, subtree: true });
}

function unwatch() {
  observer?.disconnect();
  observer = null;
  hovered = null;
}

function leaveFigure() {
  unwatch();
  restoreSol();
}

/** Start polling and wire the delegated hover. Safe to call once at boot. */
export function mountSolPrice() {
  paintHeader();
  poll();
  if (!timer) timer = window.setInterval(poll, POLL_MS);
  // Pause polling while the tab is hidden — a backgrounded tab does not need a live price.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { window.clearInterval(timer); timer = null; }
    else if (!timer) { poll(); timer = window.setInterval(poll, POLL_MS); }
  });

  document.addEventListener('mouseover', (event) => {
    // History keeps its SOL figures in protocol units; do not turn those ledger values into
    // transient USD readings when the pointer crosses a row or metric.
    if (document.body.dataset.route === 'rounds') { leaveFigure(); return; }
    if (getSolUsd() == null) return;                    // nothing to convert with
    const host = solHost(event.target);
    if (!host) { leaveFigure(); return; }
    if (hovered === host) return;                       // already following this one
    showUsd(host);
    // Restore on mouseLEAVE of the host, not mouseout of a child: mouseout fires as the pointer
    // crosses between the mark and the number inside the same figure, which would toggle the swap
    // constantly. mouseleave only fires when the pointer truly exits.
    //
    // NOT `{ once: true }`. The listener has to outlive a re-render of the host's children, and a
    // one-shot listener that fired on some earlier spurious event left the figure stuck in USD
    // with nothing to restore it.
    host.addEventListener('mouseleave', leaveFigure);
    watch(host);
  });
  // Any of these can move the pointer off the figure without firing mouseout on it.
  window.addEventListener('blur', leaveFigure);
  window.addEventListener('scroll', leaveFigure, { passive: true });
}
