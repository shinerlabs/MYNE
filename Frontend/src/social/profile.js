import { formatEther } from '../chain/units.js';

import { readMiner } from '../chain/lottery.js';
import { readStaking } from '../chain/staking.js';
import {
  supabase, REMOTE_SUPABASE_URL, SUPABASE_URL, FUNCTIONS_URL, ROUNDS_API, shortWallet,
} from './config.js';
import { getSession, authedFetchJson } from './session.js';

/**
 * Profiles: the hover card, follows, and the profile editor.
 *
 * The card merges two sources that are deliberately kept apart:
 *   - social stats (message count) from Supabase
 *   - on-chain stats (BULLION / STAKED / MINED) read straight from the contracts
 *
 * The chain is authoritative for balances; Supabase never stores them. A stale
 * or hostile row in `profiles` therefore cannot misreport anyone's holdings.
 */
let host = { notify: () => {}, getAccount: () => null, requireWallet: () => false };
let myProfile = null;            // { walletAddress, displayName, avatarUrl, bio }
const followingSet = new Set();

export const configureProfile = (adapter) => { host = { ...host, ...adapter }; };
export const getMyProfile = () => myProfile;
export const getFollowingSet = () => followingSet;

/**
 * Bio has no column until migration 0003, so Supabase always returns undefined
 * for it. Fall back to the backend, which stores it meanwhile. Returns null
 * rather than throwing — a missing bio must never blank the rest of the card.
 */
async function fetchStoredBio(wallet) {
  try {
    const res = await fetch(`${ROUNDS_API}/profile/${wallet}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()).bio ?? null;
  } catch {
    return null;
  }
}

export const profileDisplayName = () => {
  const account = host.getAccount();
  return (myProfile?.displayName && String(myProfile.displayName).trim())
    || (account ? shortWallet(account) : 'Miner');
};

// ----------------------------------------------------------------- avatars
/**
 * An avatar may be a Supabase storage path, a backend URL (`/api/avatars/0x…`),
 * or missing — in which case we still probe the backend by wallet, since most
 * pictures currently exist only there (migration 0003 is not applied yet).
 */
export const avatarPublicUrl = (path, wallet) => {
  if (path) {
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    if (path.startsWith('/api/avatars/')) return `/rounds${path}`;
    if (path.startsWith('/')) return path;
    // Storage objects come from the hosted project (public bucket). Use the
    // remote URL so <img> never depends on the dev-only /supabase proxy.
    const storageBase = (REMOTE_SUPABASE_URL || SUPABASE_URL || '').replace(/\/$/, '');
    return `${storageBase}/storage/v1/object/public/${path}`;
  }
  if (wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return `/rounds/api/avatars/${wallet.toLowerCase()}`;
  }
  return null;
};

const initialsFor = (name) =>
  (name || '0x').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '0X';

/** Builds the avatar node. Never interpolates user text into markup. */
export const buildAvatar = (name, avatarUrl, wallet) => {
  const el = document.createElement('i');
  el.className = 'chat-avatar';
  el.tabIndex = 0;
  el.dataset.wallet = wallet || '';
  const url = avatarPublicUrl(avatarUrl, wallet);
  if (!url) {
    el.textContent = initialsFor(name);
    return el;
  }
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  // If the primary URL fails (missing avatar_url column, stale path), try the
  // backend shim once before falling back to initials.
  img.addEventListener('error', () => {
    const shim = wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet)
      ? `/rounds/api/avatars/${wallet.toLowerCase()}`
      : null;
    if (shim && img.src !== new URL(shim, window.location.origin).href && !img.dataset.retried) {
      img.dataset.retried = '1';
      img.src = shim;
      return;
    }
    el.replaceChildren();
    el.textContent = initialsFor(name);
  });
  el.appendChild(img);
  return el;
};

/** Repaint name + avatar on every on-screen message from this wallet. */
export const applyProfileToChat = (wallet, displayName, avatarUrl, messageIndex) => {
  if (!wallet || !messageIndex) return;
  const w = wallet.toLowerCase();
  for (const entry of messageIndex.values()) {
    const el = entry?.el;
    if (!el) continue;
    const av = el.querySelector('.chat-avatar');
    if (!av || (av.dataset.wallet || '').toLowerCase() !== w) continue;
    const nameEl = el.querySelector('header b');
    if (nameEl && displayName) nameEl.textContent = displayName;
    av.replaceWith(buildAvatar(displayName || nameEl?.textContent || shortWallet(w), avatarUrl, w));
    const nextAv = el.querySelector('.chat-avatar');
    if (nextAv) bindProfileHover(nextAv, w);
  }
};

// ------------------------------------------------------------------ follows
export async function loadFollowing() {
  const account = host.getAccount();
  if (!account) return;
  followingSet.clear();
  const session = getSession();
  try {
    if (session?.token) {
      const res = await fetch(`${ROUNDS_API}/follows/me`, {
        headers: { Authorization: `Bearer ${session.token}` },
        cache: 'no-store',
      });
      if (res.ok) {
        const json = await res.json();
        for (const w of json.followingList || []) followingSet.add(String(w).toLowerCase());
        return;
      }
    }
  } catch { /* fall through to the table */ }
  try {
    const { data } = await supabase.from('follows').select('following').eq('follower', account.toLowerCase());
    for (const row of data || []) followingSet.add(String(row.following).toLowerCase());
  } catch { /* table missing until 0003 */ }
}

// ----------------------------------------------------------- on-chain stats
const fmt = (wei, dp = 2) => {
  const n = Number(formatEther(wei ?? 0n));
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

/**
 * BULLION / STAKED / MINED for the card. Read from the chain, never cached in
 * Supabase. Failures degrade to nulls so a dead RPC can't blank the whole card.
 */
async function readOnChainStats(wallet) {
  try {
    const [miner, staking] = await Promise.all([
      readMiner(wallet).catch(() => null),
      readStaking(wallet).catch(() => null),
    ]);
    if (!miner && !staking) return null;
    const staked = staking ? (staking.flexStaked + staking.burnStaked) : null;
    return {
      bullion: miner ? fmt(miner.bullionBalance) : null,
      staked: staked != null ? fmt(staked) : null,
      mined: miner ? fmt(miner.rewardsBullion, 3) : null,
    };
  } catch (err) {
    console.warn('on-chain profile stats failed', err);
    return null;
  }
}

// --------------------------------------------------------------- hover card
let profileCardEl = null;
let profileCardWallet = null;
let profileHoverTimer = 0;
let profileCloseTimer = 0;

const onDocCloseProfile = (e) => {
  if (profileCardEl && !profileCardEl.contains(e.target)) {
    closeProfileCard();
    document.removeEventListener('click', onDocCloseProfile);
  }
};

const closeProfileCard = () => {
  window.clearTimeout(profileHoverTimer);
  window.clearTimeout(profileCloseTimer);
  document.removeEventListener('click', onDocCloseProfile);
  profileCardEl?.remove();
  profileCardEl = null;
  profileCardWallet = null;
};

const scheduleCloseProfileCard = (delayMs = 220) => {
  window.clearTimeout(profileCloseTimer);
  profileCloseTimer = window.setTimeout(() => closeProfileCard(), delayMs);
};

const cancelCloseProfileCard = () => window.clearTimeout(profileCloseTimer);

const positionCard = (anchor) => {
  if (!profileCardEl) return;
  const r = anchor.getBoundingClientRect();
  profileCardEl.style.top = `${Math.min(window.innerHeight - 280, r.bottom + 6)}px`;
  profileCardEl.style.left = `${Math.min(window.innerWidth - 300, r.left)}px`;
};

const statRow = (className, entries) => {
  const wrap = document.createElement('div');
  wrap.className = className;
  const refs = {};
  for (const [label, value, key] of entries) {
    const span = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = value == null ? '—' : String(value);
    const small = document.createElement('small');
    small.textContent = label;
    span.append(strong, small);
    wrap.appendChild(span);
    if (key) refs[key] = strong;
  }
  return { wrap, refs };
};

/** Hover (desktop) / tap (touch) to open a miner's profile. */
export function bindProfileHover(el, wallet) {
  if (!el || !wallet) return;
  const open = () => {
    window.clearTimeout(profileHoverTimer);
    cancelCloseProfileCard();
    profileHoverTimer = window.setTimeout(() => openProfileCard(wallet, el), 120);
  };
  const softClose = () => {
    window.clearTimeout(profileHoverTimer);
    scheduleCloseProfileCard(240);
  };
  el.addEventListener('mouseenter', open);
  el.addEventListener('mouseleave', softClose);
  el.addEventListener('focus', open);
  el.addEventListener('blur', softClose);
  el.addEventListener('click', (e) => {
    // Pointer-capable devices already opened it on hover.
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    e.preventDefault();
    e.stopPropagation();
    cancelCloseProfileCard();
    openProfileCard(wallet, el);
  });
}

export async function openProfileCard(walletRaw, anchor) {
  if (!walletRaw || !anchor) return;
  const wallet = String(walletRaw).toLowerCase();

  // Already showing this wallet — keep it open and reposition.
  if (profileCardEl && profileCardWallet === wallet) {
    cancelCloseProfileCard();
    positionCard(anchor);
    return;
  }

  closeProfileCard();
  profileCardWallet = wallet;

  profileCardEl = document.createElement('div');
  profileCardEl.className = 'chat-profile-card';
  profileCardEl.addEventListener('mouseenter', cancelCloseProfileCard);
  profileCardEl.addEventListener('mouseleave', () => scheduleCloseProfileCard(180));
  const loading = document.createElement('span');
  loading.className = 'muted';
  loading.textContent = 'Loading…';
  profileCardEl.appendChild(loading);
  document.body.appendChild(profileCardEl);
  positionCard(anchor);
  setTimeout(() => document.addEventListener('click', onDocCloseProfile), 0);

  // profile_stats needs migration 0003; fall back to the base profiles table.
  let data = null;
  try {
    const primary = await supabase.from('profile_stats').select('*').eq('wallet_address', wallet).maybeSingle();
    if (!primary.error) data = primary.data;
    else {
      const fallback = await supabase.from('profiles')
        .select('wallet_address,display_name,banned').eq('wallet_address', wallet).maybeSingle();
      data = fallback.data;
    }
  } catch { /* card still renders from the chain */ }

  // The /follows count lookup that used to run here is gone with the two stats it fed — it was an
  // extra request on every card open for numbers nothing renders any more. The follows data itself
  // is untouched on the backend, so restoring the stats is a matter of putting this back.

  let messageCount = Number(data?.messages);
  if (!Number.isFinite(messageCount)) {
    messageCount = 0;
    try {
      const { count, error } = await supabase
        .from('chat_messages').select('id', { count: 'exact', head: true })
        .eq('wallet_address', wallet);
      if (!error) messageCount = count ?? 0;
    } catch { /* ignore */ }
  }

  // The card may have been closed while all of that was in flight.
  const bio = data?.bio ?? await fetchStoredBio(wallet);

  if (!profileCardEl || profileCardWallet !== wallet) return;
  profileCardEl.textContent = '';

  const name = data?.display_name || shortWallet(wallet);

  const head = document.createElement('header');
  head.appendChild(buildAvatar(name, data?.avatar_url || `/api/avatars/${wallet}`, wallet));
  const who = document.createElement('div');
  const nameEl = document.createElement('b');
  nameEl.textContent = name;
  // Address row: the card shows a truncated form, so without this the full address is
  // unreachable from here — a user wanting to send funds or check an explorer had to leave
  // the card, open the chat message, and read it from somewhere else.
  const addrRow = document.createElement('span');
  addrRow.className = 'chat-profile-addr';
  const addrEl = document.createElement('code');
  addrEl.textContent = shortWallet(wallet);
  addrEl.title = wallet;
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'chat-profile-copy';
  copyBtn.setAttribute('aria-label', `Copy address ${wallet}`);
  copyBtn.title = 'Copy address';
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>';
  copyBtn.addEventListener('click', async (event) => {
    // The card sits inside the message list; without this the click also re-opens/closes it.
    event.stopPropagation();
    // Moving the pointer onto this button leaves the avatar, which arms the hover-close
    // timer. Without cancelling it the card vanishes mid-copy and the confirmation on the
    // button is never seen — you get a toast and an empty space where the profile was.
    cancelCloseProfileCard();
    const ok = await host.copyText?.(wallet);
    host.notify?.(ok ? 'Address copied' : 'Copy failed');
    if (ok) {
      copyBtn.classList.add('copied');
      setTimeout(() => copyBtn.classList.remove('copied'), 1200);
    }
  });
  addrRow.append(addrEl, copyBtn);
  who.append(nameEl, addrRow);
  head.appendChild(who);
  profileCardEl.appendChild(head);

  if (bio) {
    const bioEl = document.createElement('p');
    bioEl.className = 'chat-profile-bio';
    bioEl.textContent = bio;
    profileCardEl.appendChild(bioEl);
  }

  // On-chain row first — it is what this app is actually about.
  const chainStats = statRow('chat-profile-stats onchain', [
    ['MYNE', null, 'bullion'],   // label is the token symbol; the key stays 'bullion'
    ['STAKED', null, 'staked'],
    ['MINED', null, 'mined'],
  ]);
  profileCardEl.appendChild(chainStats.wrap);

  // Follower/following counts were removed from the card; MESSAGES is the only social stat shown.
  // The Follow button below is unaffected — its state comes from followingSet, not from these.
  const social = statRow('chat-profile-stats social', [
    ['MESSAGES', messageCount, null],
  ]);
  profileCardEl.appendChild(social.wrap);

  // Chain reads are slower than the Supabase ones — fill them in when they land.
  void readOnChainStats(wallet).then((stats) => {
    if (!profileCardEl || profileCardWallet !== wallet || !stats) return;
    if (stats.bullion != null) chainStats.refs.bullion.textContent = stats.bullion;
    if (stats.staked != null) chainStats.refs.staked.textContent = stats.staked;
    if (stats.mined != null) chainStats.refs.mined.textContent = stats.mined;
  });

  const account = host.getAccount();
  const isMe = Boolean(account && wallet === account.toLowerCase());
  // The Follow button is removed, so another wallet's card now ends at MESSAGES with no action.
  // Your own card keeps "Edit profile". The follow-toggle endpoint and followingSet are left intact
  // (see loadFollowing) so Follow can come back without rebuilding the plumbing.
  if (!isMe) return;

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'chat-profile-action';
  action.textContent = 'Edit profile';
  action.addEventListener('click', (e) => {
    e.stopPropagation();
    closeProfileCard();
    openProfileEditor();
  });
  profileCardEl.appendChild(action);
}

// -------------------------------------------------------------- my profile
export async function loadMyProfile(messageIndex) {
  const account = host.getAccount();
  if (!account) { myProfile = null; return null; }
  const wallet = account.toLowerCase();

  let data = null;
  try {
    const primary = await supabase.from('profile_stats').select('*').eq('wallet_address', wallet).maybeSingle();
    if (!primary.error) data = primary.data;
    else {
      const fallback = await supabase.from('profiles')
        .select('wallet_address,display_name,banned').eq('wallet_address', wallet).maybeSingle();
      data = fallback.data;
    }
  } catch { /* first-time wallet has no row yet */ }

  myProfile = {
    walletAddress: wallet,
    displayName: data?.display_name || null,
    avatarUrl: data?.avatar_url || `/api/avatars/${wallet}`,
    // Without this the editor opens with an empty bio field every time and
    // saving would wipe whatever was already stored.
    bio: data?.bio ?? await fetchStoredBio(wallet),
  };
  // `await loadFollowing()` used to run here. Its only consumer was the Follow button's initial
  // state, so with the button gone it was a network round-trip that delayed the profile card for
  // nothing. followingSet is therefore empty at runtime until something calls loadFollowing again.
  applyProfileToChat(wallet, profileDisplayName(), myProfile.avatarUrl, messageIndex);
  return myProfile;
}

/** Applies a realtime `profile` broadcast. */
export function applyProfileBroadcast(payload, messageIndex) {
  if (!payload?.walletAddress) return;
  applyProfileToChat(payload.walletAddress, payload.displayName, payload.avatarUrl, messageIndex);
  if (myProfile && payload.walletAddress.toLowerCase() === myProfile.walletAddress) {
    myProfile = {
      ...myProfile,
      displayName: payload.displayName ?? myProfile.displayName,
      avatarUrl: payload.avatarUrl ?? myProfile.avatarUrl,
      bio: payload.bio ?? myProfile.bio,
    };
  }
}

// ----------------------------------------------------------- profile editor
/**
 * Downscale to 256px and re-encode as WebP before upload. Keeps payloads under
 * the server's 256KB cap without asking the user to crop, and strips EXIF
 * (including GPS) as a side effect of going through a canvas.
 */
function fileToAvatarDataUrl(file, size = 256) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Use a PNG, JPEG or WebP image'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('Pick an image under 8MB'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      resolve(canvas.toDataURL('image/webp', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

/**
 * Is this display name free?
 *
 * Advisory only — it races anyone typing the same name right now, so the server
 * still enforces uniqueness and can reject with 409. This just spares the user a
 * signature on a name that is already visibly taken.
 *
 * Returns null when the answer is unknown (offline, query failed), so callers can
 * stay silent rather than claim a name is free.
 */
export async function checkNameAvailable(name) {
  const account = host.getAccount();
  const trimmed = String(name || '').trim();
  if (!trimmed || !supabase) return null;
  try {
    let query = supabase.from('profiles').select('wallet_address')
      .ilike('display_name', trimmed).limit(1);
    // Your own current name must not read as taken.
    if (account) query = query.neq('wallet_address', account.toLowerCase());
    const { data, error } = await query;
    if (error) return null;
    return !data?.length;
  } catch {
    return null;
  }
}

/**
 * Persist profile fields and refresh local state. Shared by the modal editor and
 * the header account panel so both apply updates identically.
 *
 * Only sends the fields it is given — a name change must not clear the bio.
 */
export async function saveProfile({ displayName, bio, avatarDataUrl }, messageIndex) {
  const account = host.getAccount();
  if (!account) throw new Error('Connect your wallet first');

  const payload = {};
  if (displayName !== undefined) payload.displayName = displayName;
  if (bio !== undefined) payload.bio = bio;
  if (avatarDataUrl) payload.avatar = { dataUrl: avatarDataUrl };

  const { res, data } = await authedFetchJson(`${FUNCTIONS_URL}/profile-update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 30000);
  if (!res.ok) throw new Error(data.error || 'Could not save profile');

  myProfile = {
    walletAddress: account.toLowerCase(),
    displayName: data.profile.displayName,
    avatarUrl: data.profile.avatarUrl,
    bio: data.profile.bio,
  };
  applyProfileToChat(account, profileDisplayName(), myProfile.avatarUrl, messageIndex);
  return myProfile;
}

export { fileToAvatarDataUrl };

export function openProfileEditor(messageIndex) {
  if (!host.requireWallet('Edit your profile')) return;
  const account = host.getAccount();
  document.querySelector('.profile-editor-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'profile-editor-backdrop';
  const modal = document.createElement('div');
  modal.className = 'profile-editor';

  const h = document.createElement('h2');
  h.textContent = 'Edit profile';
  modal.appendChild(h);

  const avatarRow = document.createElement('div');
  avatarRow.className = 'profile-editor-avatar';
  const preview = buildAvatar(myProfile?.displayName, myProfile?.avatarUrl, account);
  const fileBtn = document.createElement('button');
  fileBtn.type = 'button';
  fileBtn.textContent = 'Change picture';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.hidden = true;
  let pendingAvatar = null;
  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      pendingAvatar = await fileToAvatarDataUrl(file);
      preview.textContent = '';
      const img = document.createElement('img');
      img.src = pendingAvatar;
      img.alt = '';
      preview.appendChild(img);
    } catch (err) {
      host.notify(err.message);
    }
  });
  avatarRow.append(preview, fileBtn, fileInput);
  modal.appendChild(avatarRow);

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Username';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 24;
  nameInput.value = myProfile?.displayName || '';
  nameInput.placeholder = account ? shortWallet(account) : '2–24 characters';
  nameLabel.appendChild(nameInput);

  const bioLabel = document.createElement('label');
  bioLabel.textContent = 'Bio';
  const bioInput = document.createElement('textarea');
  bioInput.maxLength = 160;
  bioInput.rows = 3;
  bioInput.value = myProfile?.bio || '';
  bioInput.placeholder = 'Optional — 160 characters';
  bioLabel.appendChild(bioInput);

  modal.append(nameLabel, bioLabel);

  const err = document.createElement('p');
  err.className = 'profile-editor-error';
  err.hidden = true;
  modal.appendChild(err);

  const actions = document.createElement('div');
  actions.className = 'profile-editor-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => backdrop.remove());
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    err.hidden = true;
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const payload = { displayName: nameInput.value, bio: bioInput.value };
      if (pendingAvatar) payload.avatar = { dataUrl: pendingAvatar };
      const { res, data } = await authedFetchJson(`${FUNCTIONS_URL}/profile-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, 30000);
      if (!res.ok) throw new Error(data.error || 'Could not save profile');
      myProfile = {
        walletAddress: account.toLowerCase(),
        displayName: data.profile.displayName,
        avatarUrl: data.profile.avatarUrl,
        bio: data.profile.bio,
      };
      applyProfileToChat(account, profileDisplayName(), myProfile.avatarUrl, messageIndex);
      host.notify('Profile updated');
      backdrop.remove();
    } catch (e2) {
      err.textContent = e2.message || 'Could not save profile';
      err.hidden = false;
    } finally {
      save.disabled = false;
      save.textContent = 'Save';
    }
  });
  actions.append(cancel, save);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', onEsc); }
  });
  document.body.appendChild(backdrop);
  nameInput.focus();
}
