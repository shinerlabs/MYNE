/**
 * Stickers.
 *
 * Chat has no separate attachment column — a sticker rides inside the message
 * body behind a control-character marker, so it stays under the 300-char DB
 * check and needs no schema change. Roughly half of the existing history is
 * sticker messages, so decoding is not optional: without it those rows render
 * as raw control characters.
 *
 * Refs are short prefixed tokens rather than URLs, which keeps the body small
 * and means a client can never smuggle an arbitrary remote image into a field
 * every other user renders.
 *
 *   c:name.png   → /stickers/custom/name.png     (committed)
 *   l:name.webp  → /stickers/animated/name.webp  (synced, see README)
 *   a:Name.webp  → local animated mirror, slugified
 *   w:U+1F600.webp → telemoji CDN
 *   t:1f600.png  → twemoji CDN
 */
/**
 * Written as an explicit escape, never as a literal control character — a raw
 * 0x1F in source is invisible, and any tool that strips it silently breaks
 * decoding for every sticker message already in the database.
 */
const US = '\u001f'; // ASCII unit separator
export const IMG_MARK = `${US}IMG${US}`;

const STICKER_REF_RE = /^(?:c:[a-z0-9_-]+\.(?:png|gif|webp)|l:[a-z0-9_-]+\.webp|a:[A-Za-z0-9][A-Za-z0-9 ._/+-]*\.webp|w:U\+[A-Za-z0-9+_]+\.webp|t:[a-z0-9_-]+\.png|\/stickers\/(?:custom\/|animated\/)?[a-z0-9_-]+\.(?:png|gif|webp))$/i;
const STICKER_CDN_TELE = 'https://cdn.jsdelivr.net/gh/saeedtahmtan/telemoji@main/webp/animated';
const STICKER_CDN_TWITTER = 'https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@15.1.2/img/twitter/64';

const STICKER_FIRST = 24;
const STICKER_PAGE = 48;
// Decode only the first visible row eagerly. The former value (36) downloaded roughly 9 MB of
// animated reactions as soon as the browser became idle, even while Social was closed.
const STICKER_EAGER_IMAGES = 8;
const STICKER_STORE_PREFIX = 'bullion-sticker-pack-v';

const slugifyAnimatedPath = (path) => {
  const stem = path.toLowerCase().endsWith('.webp') ? path.slice(0, -5) : path;
  return `${stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.webp`;
};

export const resolveStickerSrc = (ref) => {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('c:') && STICKER_REF_RE.test(ref)) return `/stickers/custom/${ref.slice(2)}`;
  if (ref.startsWith('l:') && STICKER_REF_RE.test(ref)) return `/stickers/animated/${ref.slice(2)}`;
  // Prefer the local mirror; these are the same assets as the upstream CDN.
  if (ref.startsWith('a:') && STICKER_REF_RE.test(ref)) return `/stickers/animated/${slugifyAnimatedPath(ref.slice(2))}`;
  if (ref.startsWith('w:') && STICKER_REF_RE.test(ref)) return `${STICKER_CDN_TELE}/${encodeURIComponent(ref.slice(2))}`;
  if (ref.startsWith('t:') && STICKER_REF_RE.test(ref)) return `${STICKER_CDN_TWITTER}/${ref.slice(2)}`;
  if (ref.startsWith('/stickers/') && STICKER_REF_RE.test(ref)) return ref;
  return null;
};

/** Wraps a sticker ref + optional caption, trimmed to fit the 300-char body. */
export const encodeImageBody = (imageRef, caption = '') => {
  let ref = imageRef;
  if (!ref) return caption;
  if (ref.startsWith('/stickers/custom/')) ref = `c:${ref.slice('/stickers/custom/'.length)}`;
  else if (ref.startsWith('/stickers/animated/')) ref = `l:${ref.slice('/stickers/animated/'.length)}`;
  else if (ref.startsWith('/stickers/') && !ref.includes('/', 10)) ref = `c:${ref.slice('/stickers/'.length)}`;
  if (!resolveStickerSrc(ref)) return caption;
  const prefix = `${IMG_MARK}${ref}${US}`;
  const budget = 300 - prefix.length;
  return prefix + String(caption).slice(0, Math.max(0, budget));
};

export const decodeImageBody = (raw) => {
  if (typeof raw !== 'string' || !raw.startsWith(IMG_MARK)) return { body: raw, image: null };
  const rest = raw.slice(IMG_MARK.length);
  const sep = rest.indexOf(US);
  if (sep < 0) return { body: raw, image: null };
  const ref = rest.slice(0, sep);
  const src = resolveStickerSrc(ref);
  // Unknown ref: fall through to the raw body rather than rendering a broken image.
  if (!src) return { body: raw, image: null };
  return { body: rest.slice(sep + 1), image: src, imageRef: ref };
};

/**
 * Wires the sticker picker panel. Returns handles the chat module uses to read
 * and clear the pending selection.
 */
export function mountStickerPicker({ notify, requireWallet, onPick, focusInput }) {
  const btn = document.querySelector('#chat-sticker-btn');
  const panel = document.querySelector('#chat-sticker-panel');
  const grid = document.querySelector('#chat-sticker-grid');
  const packsEl = document.querySelector('#chat-sticker-packs');
  const searchEl = document.querySelector('#chat-sticker-search');
  const countEl = document.querySelector('#chat-sticker-count');
  const moreEl = document.querySelector('#chat-sticker-more');
  const preview = document.querySelector('#chat-attach-preview');

  let index = null;
  const packCache = new Map();
  let packId = 'reactions';
  let query = '';
  let shown = 0;
  let filterCache = { key: '', list: [] };
  let searchTimer = 0;
  let packsRenderedV = -1;
  let pending = null;

  // Only fetch thumbs once they scroll into view — packs run to hundreds of images.
  let imgObserver = null;
  const observeImg = (img) => {
    if (!img?.dataset?.src) return;
    if (!imgObserver && grid) {
      imgObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;
          if (el.dataset.src) { el.src = el.dataset.src; el.removeAttribute('data-src'); }
          imgObserver.unobserve(el);
        }
      }, { root: grid, rootMargin: '160px 0px' });
    }
    imgObserver?.observe(img);
  };

  const prefetched = new Set();
  const prefetchImages = (items, limit = STICKER_EAGER_IMAGES) => {
    if (!items?.length || navigator.connection?.saveData) return;
    for (const sticker of items.slice(0, limit)) {
      if (!sticker.src || prefetched.has(sticker.src)) continue;
      prefetched.add(sticker.src);
      const probe = new Image();
      probe.decoding = 'async';
      probe.src = sticker.src;
    }
  };

  const readSessionPack = (v, id) => {
    try {
      const raw = sessionStorage.getItem(`${STICKER_STORE_PREFIX}${v}:${id}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  };
  const writeSessionPack = (v, id, items) => {
    try { sessionStorage.setItem(`${STICKER_STORE_PREFIX}${v}:${id}`, JSON.stringify(items)); } catch { /* quota */ }
  };

  const normalizePackItems = (packData) => {
    const out = [];
    for (const item of packData.items || []) {
      const name = Array.isArray(item) ? item[0] : item.name;
      const raw = Array.isArray(item) ? item[1] : (item.ref || item.file || item.image);
      if (!raw || typeof raw !== 'string') continue;
      let ref = raw;
      if (!ref.includes(':') && !ref.startsWith('http') && !ref.startsWith('/')) ref = `c:${ref}`;
      const src = (Array.isArray(item) && item[2]) || resolveStickerSrc(ref);
      if (!src) continue;
      out.push({ name, ref, src });
    }
    return out;
  };

  const fetchStickerJson = async (url) => {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  async function ensurePackLoaded(id) {
    if (packCache.has(id)) return packCache.get(id);
    const meta = index?.packs?.find((p) => p.id === id);
    if (!meta) return [];
    const v = index?.v || 0;
    const cached = readSessionPack(v, id);
    if (cached?.length) { packCache.set(id, cached); return cached; }
    const items = normalizePackItems(await fetchStickerJson(`/stickers/${meta.file}`));
    packCache.set(id, items);
    writeSessionPack(v, id, items);
    return items;
  }

  const filtered = () => {
    const pack = packCache.get(packId) || [];
    const q = query.trim().toLowerCase();
    const key = `${packId}|${q}`;
    if (filterCache.key === key) return filterCache.list;
    const list = q
      ? pack.filter((s) => (s.name || '').toLowerCase().includes(q) || s.ref.toLowerCase().includes(q))
      : pack;
    filterCache = { key, list };
    return list;
  };

  const renderBatch = (reset = false) => {
    if (!grid) return;
    const list = filtered();
    if (reset) { grid.replaceChildren(); shown = 0; }
    const next = list.slice(shown, shown + (reset ? STICKER_FIRST : STICKER_PAGE));
    const frag = document.createDocumentFragment();
    next.forEach((sticker, i) => {
      const globalIdx = shown + i;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'chat-sticker-item';
      item.title = sticker.name || sticker.ref;
      item.dataset.ref = sticker.ref;
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.width = 56;
      img.height = 56;
      if (reset && globalIdx < STICKER_EAGER_IMAGES) {
        img.src = sticker.src;
        img.fetchPriority = globalIdx < 8 ? 'high' : 'auto';
      } else {
        img.dataset.src = sticker.src;
        img.loading = 'lazy';
        img.fetchPriority = 'low';
        observeImg(img);
      }
      item.appendChild(img);
      frag.appendChild(item);
    });
    grid.appendChild(frag);
    shown += next.length;
    if (moreEl) moreEl.hidden = shown >= list.length;
    if (countEl) {
      countEl.textContent = list.length ? `${Math.min(shown, list.length)} / ${list.length}` : 'No stickers match';
    }
  };

  const enableDragScroll = (el) => {
    if (!el || el.dataset.dragScroll === '1') return;
    el.dataset.dragScroll = '1';
    let active = false; let dragging = false; let startX = 0; let startLeft = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      active = true; dragging = false; startX = e.clientX; startLeft = el.scrollLeft;
    });
    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dx = e.clientX - startX;
      if (!dragging && Math.abs(dx) >= 10) {
        dragging = true;
        el.classList.add('is-dragging');
        el.dataset.dragMoved = '1';
      }
      if (dragging) el.scrollLeft = startLeft - dx;
    });
    const endDrag = () => {
      if (!active) return;
      active = false;
      el.classList.remove('is-dragging');
      if (!dragging) el.dataset.dragMoved = '0';
      dragging = false;
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('pointerleave', () => { if (active && !dragging) endDrag(); });
  };

  const renderPacks = () => {
    if (!packsEl || !index) return;
    const v = index.v || 0;
    if (packsRenderedV === v && packsEl.childElementCount > 0) return;
    packsRenderedV = v;
    const packs = index.packs || [];
    packsEl.hidden = packs.length === 0;
    const frag = document.createDocumentFragment();
    for (const pack of packs) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', pack.id === packId ? 'true' : 'false');
      tab.className = 'chat-sticker-pack';
      tab.classList.toggle('active', pack.id === packId);
      tab.dataset.pack = pack.id;
      tab.title = `${pack.name} · ${pack.count}`;
      tab.textContent = pack.name;
      const warm = () => ensurePackLoaded(pack.id).then((items) => prefetchImages(items, 8)).catch(() => {});
      tab.addEventListener('mouseenter', warm, { passive: true });
      tab.addEventListener('focus', warm);
      tab.addEventListener('click', (e) => {
        // A drag across the tab strip must not also select a category.
        if (packsEl?.dataset.dragMoved === '1') {
          e.preventDefault(); e.stopPropagation();
          packsEl.dataset.dragMoved = '0';
          return;
        }
        void selectPack(pack.id);
      });
      frag.appendChild(tab);
    }
    packsEl.replaceChildren(frag);
    enableDragScroll(packsEl);
  };

  let loadToken = 0;
  async function selectPack(id) {
    if (!id || !index?.packs?.some((p) => p.id === id)) return;
    if (id === packId && packCache.has(id)) { renderBatch(true); return; }

    const token = ++loadToken;
    packId = id;
    query = '';
    filterCache = { key: '', list: [] };
    if (searchEl) searchEl.value = '';
    packsEl?.querySelectorAll('.chat-sticker-pack').forEach((tab) => {
      const on = tab.dataset.pack === id;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    const cached = packCache.get(id);
    if (cached?.length) { prefetchImages(cached); renderBatch(true); return; }

    if (grid) grid.replaceChildren(loadingNode('Loading…'));
    if (moreEl) moreEl.hidden = true;
    if (countEl) countEl.textContent = 'Loading…';
    try {
      const items = await ensurePackLoaded(id);
      if (token !== loadToken) return;
      if (!items.length) {
        grid?.replaceChildren(loadingNode('No stickers in this category'));
        if (countEl) countEl.textContent = '0 stickers';
        return;
      }
      prefetchImages(items);
      renderBatch(true);
    } catch (err) {
      if (token !== loadToken) return;
      console.warn('sticker pack switch failed', err);
      grid?.replaceChildren(loadingNode('Could not load category'));
    }
  }

  const loadingNode = (text) => {
    const div = document.createElement('div');
    div.className = 'chat-sticker-loading';
    div.textContent = text;
    return div;
  };

  let warmPromise = null;
  const warmCatalog = () => {
    if (warmPromise) return warmPromise;
    warmPromise = (async () => {
      if (!index) index = await fetchStickerJson('/stickers/manifest.json');
      renderPacks();
      prefetchImages(await ensurePackLoaded(packId));
    })().catch(() => {});
    return warmPromise;
  };

  async function loadStickers() {
    try {
      if (warmPromise) await warmPromise;
      else if (!index) index = await fetchStickerJson('/stickers/manifest.json');
      if (!index?.packs?.length) throw new Error('empty sticker packs');
      if (!index.packs.some((p) => p.id === packId)) packId = index.packs[0].id;
      renderPacks();
      filterCache = { key: '', list: [] };
      if (packCache.has(packId)) {
        prefetchImages(packCache.get(packId));
        renderBatch(true);
        return;
      }
      if (grid) grid.replaceChildren(loadingNode('Loading…'));
      prefetchImages(await ensurePackLoaded(packId));
      renderBatch(true);
    } catch (err) {
      console.warn('sticker pack failed to load', err);
      notify('Could not load stickers');
    }
  }

  const close = () => {
    if (panel) panel.hidden = true;
    btn?.classList.remove('active');
  };

  const setPending = (refOrSrc) => {
    let ref = refOrSrc;
    if (ref.startsWith('/stickers/custom/')) ref = `c:${ref.slice('/stickers/custom/'.length)}`;
    else if (ref.startsWith('/stickers/animated/')) ref = `l:${ref.slice('/stickers/animated/'.length)}`;
    const src = resolveStickerSrc(ref) || (refOrSrc.startsWith('/') || refOrSrc.startsWith('http') ? refOrSrc : null);
    if (!src) return;
    pending = resolveStickerSrc(ref) ? ref : refOrSrc;
    if (!preview) return;
    const img = preview.querySelector('img');
    if (img) { img.src = src; img.decoding = 'async'; img.fetchPriority = 'high'; }
    preview.hidden = false;
  };

  const clearPending = () => {
    pending = null;
    if (preview) preview.hidden = true;
  };

  btn?.addEventListener('mouseenter', () => warmCatalog(), { passive: true });
  btn?.addEventListener('focus', () => warmCatalog());
  btn?.addEventListener('click', async () => {
    if (!requireWallet('Send a sticker')) return;
    if (!panel) return;
    if (panel.hidden) {
      panel.hidden = false;
      btn.classList.add('active');
      await loadStickers();
    } else close();
  });

  grid?.addEventListener('click', (event) => {
    const item = event.target.closest('.chat-sticker-item');
    if (!item?.dataset.ref) return;
    if (!requireWallet('Send a sticker')) return;
    setPending(item.dataset.ref);
    close();
    onPick?.(item.dataset.ref);
    focusInput?.();
  });

  grid?.addEventListener('scroll', () => {
    if (!grid || moreEl?.hidden) return;
    if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 80) renderBatch(false);
  }, { passive: true });

  moreEl?.addEventListener('click', () => renderBatch(false));
  document.querySelector('#chat-sticker-close')?.addEventListener('click', close);
  document.querySelector('#chat-attach-clear')?.addEventListener('click', clearPending);

  searchEl?.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = searchEl.value || '';
      renderBatch(true);
    }, 120);
  });

  // Do not warm on page load. `mouseenter`/`focus` above still starts the small catalogue request
  // before a deliberate click, while visitors who never open stickers download nothing.

  return {
    getPending: () => pending,
    setPending,
    clearPending,
    close,
    isOpen: () => panel && !panel.hidden,
  };
}
