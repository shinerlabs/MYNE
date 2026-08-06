import { NEWS_API } from './config.js';
import { getSession, authedFetchJson } from './session.js';

/**
 * News feed — a read-only channel for everyone, postable by wallets listed in
 * the backend's CHAT_ADMIN_WALLETS. Admin state is decided server-side; the
 * hidden composer here is presentation only, never the access control.
 */
let host = { notify: () => {}, getAccount: () => null, requireWallet: () => false, setRoute: () => {} };
let isChatAdmin = false;

export const configureNews = (adapter) => { host = { ...host, ...adapter }; };
export const getIsChatAdmin = () => isChatAdmin;

/** Relative label from the exact stored UTC time (Just now / 2h ago / Yesterday / …). */
export function formatRelativeTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours}h ago`;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((startToday - startThat) / 86_400_000);
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return `${dayDiff}d ago`;
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

export function refreshNewsRelativeTimes() {
  document.querySelectorAll('.news-card time[datetime]').forEach((el) => {
    el.textContent = formatRelativeTime(el.getAttribute('datetime'));
  });
}

export async function refreshChatAdmin() {
  isChatAdmin = false;
  const session = getSession();
  try {
    if (session?.token) {
      const res = await fetch(`${NEWS_API}/admin`, {
        headers: { Authorization: `Bearer ${session.token}` },
        cache: 'no-store',
      });
      if (res.ok) isChatAdmin = Boolean((await res.json()).admin);
    }
  } catch { /* not an admin, or backend down */ }
  const adminEl = document.querySelector('#news-admin');
  if (adminEl) adminEl.hidden = !isChatAdmin;
  return isChatAdmin;
}

function buildNewsCard(item) {
  const art = document.createElement('article');
  art.className = `news-card${item.pinned ? ' pinned' : ''}`;
  art.dataset.newsId = String(item.id);

  const head = document.createElement('header');
  const cat = document.createElement('span');
  cat.textContent = item.pinned ? 'PINNED' : (item.category || 'PROTOCOL');
  const time = document.createElement('time');
  time.dateTime = item.publishedAt;
  time.title = new Date(item.publishedAt).toLocaleString();
  time.textContent = formatRelativeTime(item.publishedAt);
  head.append(cat, time);
  art.appendChild(head);

  const h3 = document.createElement('h3');
  h3.textContent = item.title;
  const p = document.createElement('p');
  p.className = 'news-body';
  p.textContent = item.body;
  art.append(h3, p);

  // A body longer than the CSS line clamp gets a toggle. Whether it overflows depends on the
  // RENDERED width, and this card is built detached — and the news panel is often still closed when
  // the feed loads — so measuring here reads zeros and the button would never appear. A
  // ResizeObserver measures the moment the paragraph actually has a box, and again on resize: a
  // wider column can make the toggle unnecessary.
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'news-more';
  more.hidden = true;
  more.textContent = 'Read more';
  more.addEventListener('click', () => {
    const expanded = art.classList.toggle('expanded');
    more.textContent = expanded ? 'Read less' : 'Read more';
    more.setAttribute('aria-expanded', String(expanded));
  });
  more.setAttribute('aria-expanded', 'false');
  art.appendChild(more);
  new ResizeObserver(() => {
    // Expanded means the clamp is off, so scrollHeight === clientHeight and the check below would
    // hide the only way back to "Read less".
    if (art.classList.contains('expanded') || !p.clientHeight) return;
    more.hidden = p.scrollHeight <= p.clientHeight + 1;
  }).observe(p);

  if (item.linkRoute) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.route = item.linkRoute;
    if (item.linkRoute === 'about') btn.dataset.aboutTarget = 'token-flow';
    btn.textContent = item.linkLabel || 'Read more →';
    btn.addEventListener('click', () => host.setRoute(item.linkRoute, { aboutTarget: btn.dataset.aboutTarget }));
    art.appendChild(btn);
  }

  if (isChatAdmin) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'news-card-delete';
    del.title = 'Delete news';
    del.setAttribute('aria-label', 'Delete news');
    del.textContent = '✕';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const { res, data } = await authedFetchJson(`${NEWS_API}/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(data.error || 'Delete failed');
        art.remove();
        host.notify('News removed');
      } catch (err) {
        host.notify(err.message || 'Could not delete news');
      }
    });
    art.appendChild(del);
  }
  return art;
}

export function upsertNewsCard(item) {
  const feed = document.querySelector('#news-feed');
  if (!feed || !item) return;
  feed.querySelector(`.news-card[data-news-id="${item.id}"]`)?.remove();
  const card = buildNewsCard(item);
  const pinned = feed.querySelector('.news-card.pinned');
  if (item.pinned || !feed.querySelector('.news-card')) feed.insertBefore(card, feed.firstChild);
  else if (pinned?.nextSibling) feed.insertBefore(card, pinned.nextSibling);
  else if (pinned) feed.appendChild(card);
  else feed.insertBefore(card, feed.firstChild);
}

export function removeNewsCard(id) {
  document.querySelector(`.news-card[data-news-id="${id}"]`)?.remove();
}

export async function loadNewsFeed() {
  const feed = document.querySelector('#news-feed');
  if (!feed) return;
  try {
    const res = await fetch(NEWS_API, { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not load news');
    const data = await res.json();
    feed.textContent = '';
    for (const item of data.items || []) feed.appendChild(buildNewsCard(item));
  } catch (err) {
    console.warn('news load failed', err);
  }
}

export function mountNews(adapter) {
  configureNews(adapter);

  document.querySelector('#news-post')?.addEventListener('click', async () => {
    if (!isChatAdmin) return;
    if (!host.requireWallet('Post news')) return;
    const title = document.querySelector('#news-title')?.value?.trim() || '';
    const body = document.querySelector('#news-body')?.value?.trim() || '';
    const category = document.querySelector('#news-category')?.value || 'PROTOCOL';
    const pinned = Boolean(document.querySelector('#news-pinned')?.checked);
    if (!title || !body) return host.notify('Title and body are both required');
    try {
      const { res, data } = await authedFetchJson(NEWS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, category, pinned }),
      });
      if (!res.ok) throw new Error(data.error || 'Post failed');
      if (data.item) upsertNewsCard(data.item);
      const titleEl = document.querySelector('#news-title');
      const bodyEl = document.querySelector('#news-body');
      const pin = document.querySelector('#news-pinned');
      if (titleEl) titleEl.value = '';
      if (bodyEl) bodyEl.value = '';
      if (pin) pin.checked = false;
      host.notify('News posted');
    } catch (err) {
      host.notify(err.message || 'Could not post news');
    }
  });

  void loadNewsFeed();
  void refreshChatAdmin();
  window.setInterval(refreshNewsRelativeTimes, 60_000);
}
