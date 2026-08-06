import {
  supabase, FUNCTIONS_URL, SUPABASE_ANON_KEY, CHAT_TOPIC, HISTORY_LIMIT,
  REACTIONS, shortWallet, fetchJson,
} from './config.js';
import { getSession, getGuestId, ensureSession, authedFetchJson } from './session.js';
import { encodeImageBody, decodeImageBody, mountStickerPicker } from './stickers.js';
import { buildAvatar, bindProfileHover, getMyProfile, profileDisplayName } from './profile.js';

/**
 * Live chat: history, realtime, composing, replies and reactions.
 *
 * Every piece of user text reaches the DOM through `textContent`, never
 * `innerHTML` — display names, message bodies and reply quotes are all
 * attacker-controlled strings rendered in every other user's browser.
 */
const US = '\u001f'; // ASCII unit separator — never a literal control char in source
const REPLY_MARK = `${US}R:`;

let host = { notify: () => {}, requireWallet: () => false, getAccount: () => null, setRoute: () => {} };
let stickers = null;

const seenChatIds = new Set();
const messageIndex = new Map();      // id -> { id, el, reactions: Map(emoji -> count) }
const replyPreviewCache = new Map(); // id -> { displayName, body, walletAddress }
const myReactions = new Set();       // `${id}:${emoji}` currently active for this user

let replyTarget = null;
let isChatAdmin = false;

let chatMessagesEl = null;
let chatComposeEl = null;
let chatInputEl = null;
let chatSendButtonEl = null;
let chatStatusEl = null;
let chatCharCountEl = null;
let chatHintEl = null;
let chatCanSend = true;

export const setChatAdmin = (value) => { isChatAdmin = Boolean(value); };
export const getMessageIndex = () => messageIndex;

// ------------------------------------------------------------------ status
const setChatStatus = (state) => {
  if (!chatStatusEl) return;
  const labels = { connecting: 'Connecting', live: 'Live', offline: 'Offline' };
  chatStatusEl.dataset.state = state;
  const label = chatStatusEl.querySelector('b');
  if (label) label.textContent = labels[state] || state;
};

const syncChatCharCount = () => {
  if (!chatInputEl || !chatCharCountEl) return;
  const n = chatInputEl.value.length;
  chatCharCountEl.textContent = `${n}/300`;
  chatCharCountEl.classList.toggle('near-limit', n >= 260);
  // Grow with content so Shift+Enter newlines stay visible.
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 120)}px`;
};

export const setChatComposeEnabled = (enabled, placeholder, gateMessage = 'Connect your wallet to chat.') => {
  if (!chatInputEl) return;
  chatCanSend = Boolean(enabled);
  // Never actually disabled — a dead input can't explain why it's dead.
  chatInputEl.disabled = false;
  chatInputEl.readOnly = !enabled;
  // Kept short deliberately. The composer is a single line, and its narrowest home is the
  // desktop sidebar at 1280px, where the field is only ~121px wide — the longer wording wrapped
  // and was clipped mid-word. The banner directly above already spells out what connecting does,
  // so this only has to label the field.
  chatInputEl.placeholder = placeholder
    || (enabled ? 'Send a message…' : 'Connect to chat');
  chatInputEl.classList.toggle('chat-ready', enabled);
  chatSendButtonEl?.classList.toggle('chat-ready', enabled);
  if (chatHintEl) {
    chatHintEl.textContent = enabled
      ? (getSession() ? 'Stickers · Enter send · Shift+Enter newline' : 'Guest chat · connect to unlock your profile')
      : 'Chat unavailable';
  }
  const emptyCopy = document.querySelector('#chat-empty p');
  if (emptyCopy) emptyCopy.textContent = enabled
    ? 'Say hello to the miners.'
    : 'Connect your wallet and say hello to the miners.';
  document.querySelector('.chat-gate')?.remove();

  if (!enabled && chatComposeEl?.parentElement) {
    const gate = document.createElement('div');
    gate.className = 'chat-gate';
    const text = document.createElement('span');
    text.textContent = gateMessage;
    if (!host.getAccount()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Connect wallet';
      btn.addEventListener('click', () => host.connectWallet?.());
      gate.append(text, btn);
    } else {
      gate.append(text);
    }
    chatComposeEl.parentElement.insertBefore(gate, chatComposeEl);
  }
};

// ------------------------------------------------------- body encode/decode
/** Compact reply prefix — keeps the total body within the 300-char DB check. */
const encodeReplyBody = (reply, text) => {
  if (!reply?.id) return text;
  const prefix = `${REPLY_MARK}${Number(reply.id)}${US}`;
  const budget = 300 - prefix.length;
  return prefix + String(text).slice(0, Math.max(0, budget));
};

const decodeReplyBody = (raw) => {
  if (typeof raw !== 'string' || !raw.startsWith(REPLY_MARK)) return { body: raw, replyId: null };
  const rest = raw.slice(REPLY_MARK.length);
  const sep = rest.indexOf(US);
  if (sep < 0) return { body: raw, replyId: null };
  const id = Number(rest.slice(0, sep));
  if (!Number.isInteger(id) || id <= 0) return { body: raw, replyId: null };
  return { body: rest.slice(sep + 1), replyId: id };
};

const replyFromIndex = (id) => {
  const cached = replyPreviewCache.get(id) || replyPreviewCache.get(Number(id));
  if (cached) return { id, ...cached };
  const entry = messageIndex.get(id) || messageIndex.get(Number(id)) || messageIndex.get(String(id));
  if (!entry?.el) return null;
  return {
    id,
    displayName: entry.el.querySelector('header b')?.textContent || 'Miner',
    body: entry.el.querySelector('p')?.textContent || '',
    walletAddress: entry.el.querySelector('header b')?.dataset.wallet || null,
  };
};

/** Accepts both `chat_feed` rows (snake_case) and Edge Function echoes (camelCase). */
const normaliseMessage = (row) => {
  const decodedReply = decodeReplyBody(row.body ?? '');
  const decodedImage = decodeImageBody(decodedReply.body ?? '');

  let replyTo = row.replyTo ?? (row.reply_to_id
    ? {
      id: row.reply_to_id,
      body: row.reply_body,
      displayName: row.reply_display_name,
      walletAddress: row.reply_wallet_address,
    }
    : null);

  if (!replyTo && decodedReply.replyId) {
    replyTo = replyFromIndex(decodedReply.replyId) || {
      id: decodedReply.replyId,
      displayName: 'Message',
      body: 'Tap to jump to the original',
      walletAddress: null,
    };
  }

  const textBody = decodedImage.image != null
    ? decodedImage.body
    : (decodedReply.replyId != null ? decodedReply.body : (row.body ?? ''));

  const wallet = (row.wallet_address ?? row.walletAddress ?? '').toLowerCase();
  return {
    id: row.id,
    wallet,
    name: row.display_name ?? row.displayName ?? shortWallet(wallet || '0x'),
    avatarUrl: row.avatar_url ?? row.avatarUrl ?? null,
    body: textBody,
    image: decodedImage.image || row.image || null,
    createdAt: row.created_at ?? row.createdAt,
    replyTo,
    reactions: row.reactions || [],
  };
};

// --------------------------------------------------------------- reactions
const renderReactionBar = (entry, reactions) => {
  const bar = entry.el.querySelector('.chat-reactions');
  if (!bar) return;
  bar.textContent = '';
  for (const [emoji, count] of reactions) {
    if (count <= 0) continue;
    const btn = document.createElement('button');
    btn.className = 'chat-reaction';
    btn.type = 'button';
    btn.dataset.emoji = emoji;
    btn.classList.toggle('mine', myReactions.has(`${entry.id}:${emoji}`));
    const e = document.createElement('span');
    e.textContent = emoji;
    const c = document.createElement('b');
    c.textContent = String(count);
    btn.append(e, c);
    btn.addEventListener('click', () => toggleReaction(entry.id, emoji));
    bar.appendChild(btn);
  }
  bar.hidden = !bar.childElementCount;
};

const animateReaction = (messageId, emoji) => {
  const entry = messageIndex.get(messageId)
    || messageIndex.get(Number(messageId))
    || messageIndex.get(String(messageId));
  if (!entry) return;
  const fly = document.createElement('span');
  fly.className = 'reaction-fly';
  fly.textContent = emoji;
  fly.style.setProperty('--drift', `${(Math.random() * 40 - 20).toFixed(1)}px`);
  entry.el.appendChild(fly);
  fly.addEventListener('animationend', () => fly.remove(), { once: true });
};

async function toggleReaction(messageId, emoji) {
  if (!host.requireWallet('React to messages')) return;
  const mid = Number(messageId);
  if (!Number.isInteger(mid) || mid <= 0) {
    host.notify('Cannot react to this message yet');
    return;
  }
  const key = `${mid}:${emoji}`;
  const entry = messageIndex.get(mid) || messageIndex.get(messageId) || messageIndex.get(String(messageId));
  const had = myReactions.has(key);

  // Optimistic: reflect immediately, reconcile when the broadcast lands.
  if (entry) {
    entry.reactions.set(emoji, Math.max(0, (entry.reactions.get(emoji) || 0) + (had ? -1 : 1)));
    if (had) myReactions.delete(key); else myReactions.add(key);
    renderReactionBar(entry, entry.reactions);
    if (!had) animateReaction(mid, emoji);
  }

  try {
    const session = await ensureSession();
    const { res, data } = await fetchJson(`${FUNCTIONS_URL}/chat-react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ messageId: mid, emoji }),
    });
    if (!res.ok) throw new Error(data.error || 'Reaction failed');
    if (entry) { entry.reactions.set(emoji, data.count); renderReactionBar(entry, entry.reactions); }
    if (data.reacted) myReactions.add(key); else myReactions.delete(key);
  } catch (err) {
    // Roll the optimistic update back.
    if (entry) {
      entry.reactions.set(emoji, Math.max(0, (entry.reactions.get(emoji) || 0) + (had ? 1 : -1)));
      if (had) myReactions.add(key); else myReactions.delete(key);
      renderReactionBar(entry, entry.reactions);
    }
    host.notify(err.message || 'Reaction failed');
  }
}

let pickerEl = null;
const closeEmojiPicker = () => { pickerEl?.remove(); pickerEl = null; };
const onDocClosePicker = (e) => { if (pickerEl && !pickerEl.contains(e.target)) closeEmojiPicker(); };

function openEmojiPicker(anchor, messageId) {
  if (!host.requireWallet('React to messages')) return;
  closeEmojiPicker();
  pickerEl = document.createElement('div');
  pickerEl.className = 'emoji-picker';
  for (const emoji of REACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.addEventListener('click', () => { toggleReaction(messageId, emoji); closeEmojiPicker(); });
    pickerEl.appendChild(b);
  }
  document.body.appendChild(pickerEl);
  const r = anchor.getBoundingClientRect();
  pickerEl.style.top = `${Math.max(8, r.top - pickerEl.offsetHeight - 8)}px`;
  pickerEl.style.left = `${Math.min(window.innerWidth - pickerEl.offsetWidth - 8, r.left - 8)}px`;
  setTimeout(() => document.addEventListener('click', onDocClosePicker, { once: true }), 0);
}

/** Pull reaction rollups for freshly-rendered messages. */
async function hydrateReactions(messageIds) {
  const ids = [...new Set((messageIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return;
  try {
    const headers = {};
    const session = getSession();
    if (session?.token) headers.Authorization = `Bearer ${session.token}`;
    const { res, data } = await fetchJson(`${FUNCTIONS_URL}/chat-reactions?ids=${ids.join(',')}`, { headers }, 12000);
    if (!res.ok) return;
    for (const [id, list] of Object.entries(data?.reactions || {})) {
      const entry = messageIndex.get(Number(id)) || messageIndex.get(id) || messageIndex.get(String(id));
      if (!entry) continue;
      entry.reactions = new Map();
      for (const r of list || []) entry.reactions.set(r.emoji, r.count);
      renderReactionBar(entry, entry.reactions);
    }
    for (const key of data?.mine || []) myReactions.add(key);
  } catch (err) {
    console.warn('reaction hydrate failed', err);
  }
}

// ----------------------------------------------------------------- replies
function startReply(m) {
  if (!host.requireWallet('Reply to messages')) return;
  if (!m?.id) {
    host.notify('Cannot reply to this message yet — wait for it to finish sending');
    return;
  }
  replyTarget = { id: m.id, body: m.body, displayName: m.name, wallet: m.wallet };
  replyPreviewCache.set(m.id, { displayName: m.name, body: m.body, walletAddress: m.wallet });
  renderReplyBar();
  chatInputEl?.focus();
}

function cancelReply() {
  replyTarget = null;
  document.querySelector('.chat-reply-bar')?.remove();
  chatComposeEl?.parentElement?.classList.remove('has-reply');
}

function renderReplyBar() {
  document.querySelector('.chat-reply-bar')?.remove();
  chatComposeEl?.parentElement?.classList.remove('has-reply');
  if (!replyTarget || !chatComposeEl?.parentElement) return;
  const bar = document.createElement('div');
  bar.className = 'chat-reply-bar';
  const label = document.createElement('div');
  const who = document.createElement('b');
  who.textContent = `Replying to ${replyTarget.displayName}`;
  const preview = document.createElement('span');
  preview.textContent = replyTarget.body;
  label.append(who, preview);
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Cancel reply');
  close.textContent = '✕';
  close.addEventListener('click', cancelReply);
  bar.append(label, close);
  chatComposeEl.parentElement.insertBefore(bar, chatComposeEl);
  chatComposeEl.parentElement.classList.add('has-reply');
}

const jumpToMessage = (id) => {
  const entry = messageIndex.get(id) || messageIndex.get(Number(id)) || messageIndex.get(String(id));
  if (!entry) { host.notify('That message is outside the loaded history'); return; }
  entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  entry.el.classList.add('flash');
  setTimeout(() => entry.el.classList.remove('flash'), 1200);
};

// --------------------------------------------------------------- rendering
const renderChatMessage = (row) => {
  const m = normaliseMessage(row);
  const myProfile = getMyProfile();

  const el = document.createElement('div');
  el.className = 'chat-message';
  el.dataset.id = String(m.id ?? '');
  if (myProfile && m.wallet === myProfile.walletAddress) el.classList.add('mine');

  el.appendChild(buildAvatar(m.name, m.avatarUrl, m.wallet));

  const col = document.createElement('div');
  col.className = 'chat-message-col';

  const header = document.createElement('header');
  const b = document.createElement('b');
  b.textContent = m.name;
  b.dataset.wallet = m.wallet;
  b.tabIndex = 0;

  const actions = document.createElement('span');
  actions.className = 'chat-msg-actions';
  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.title = 'Reply';
  replyBtn.setAttribute('aria-label', `Reply to ${m.name}`);
  replyBtn.textContent = '↩';
  replyBtn.addEventListener('click', (e) => { e.stopPropagation(); startReply(m); });
  const reactBtn = document.createElement('button');
  reactBtn.type = 'button';
  reactBtn.title = 'React';
  reactBtn.setAttribute('aria-label', 'Add reaction');
  reactBtn.textContent = '☺';
  reactBtn.addEventListener('click', (e) => { e.stopPropagation(); openEmojiPicker(e.currentTarget, m.id); });
  actions.append(replyBtn, reactBtn);

  if (isChatAdmin && m.id != null) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'chat-msg-delete';
    delBtn.title = 'Delete message';
    delBtn.setAttribute('aria-label', 'Delete message');
    delBtn.textContent = '⌫';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteChatMessage(m.id); });
    actions.append(delBtn);
  }

  const t = document.createElement('time');
  t.textContent = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  header.append(b, actions, t);
  col.appendChild(header);

  if (m.replyTo?.body || m.replyTo?.id) {
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.className = 'chat-quote';
    const qn = document.createElement('b');
    qn.textContent = m.replyTo.displayName || shortWallet(m.replyTo.walletAddress || '0x');
    const qb = document.createElement('span');
    qb.textContent = m.replyTo.body || 'Original message';
    quote.append(qn, qb);
    quote.addEventListener('click', () => jumpToMessage(m.replyTo.id));
    col.appendChild(quote);
  }

  if (m.image) {
    const media = document.createElement('div');
    media.className = 'chat-media';
    const img = document.createElement('img');
    img.src = m.image;
    img.alt = 'Sticker';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.width = 128;
    img.height = 128;
    media.appendChild(img);
    col.appendChild(media);
  }

  if (m.body) {
    const p = document.createElement('p');
    p.textContent = m.body;
    col.appendChild(p);
  }

  const bar = document.createElement('div');
  bar.className = 'chat-reactions';
  bar.hidden = true;
  col.appendChild(bar);

  el.appendChild(col);

  const entry = { id: m.id, el, reactions: new Map() };
  for (const r of m.reactions) entry.reactions.set(r.emoji, r.count);
  if (m.id != null) {
    // Indexed under every key shape realtime/REST might hand back.
    messageIndex.set(m.id, entry);
    messageIndex.set(Number(m.id), entry);
    messageIndex.set(String(m.id), entry);
  }
  renderReactionBar(entry, entry.reactions);

  bindProfileHover(b, m.wallet);
  bindProfileHover(el.querySelector('.chat-avatar'), m.wallet);
  return el;
};

const markHistoryStart = () => {
  if (!chatMessagesEl || chatMessagesEl.querySelector('.chat-history-status.start')) return;
  const start = document.createElement('div');
  start.className = 'chat-history-status start';
  start.textContent = `Showing last ${HISTORY_LIMIT} messages`;
  chatMessagesEl.insertBefore(start, chatMessagesEl.firstChild);
};

/** Drop the oldest rows so the pane never holds more than HISTORY_LIMIT. */
const trimChatToLimit = () => {
  if (!chatMessagesEl) return;
  const nodes = [...chatMessagesEl.querySelectorAll('.chat-message')];
  const overflow = nodes.length - HISTORY_LIMIT;
  if (overflow <= 0) return;
  for (const el of nodes.slice(0, overflow)) {
    const id = el.dataset.id;
    if (id) {
      messageIndex.delete(id);
      messageIndex.delete(Number(id));
      messageIndex.delete(String(id));
      seenChatIds.delete(id);
      seenChatIds.delete(Number(id));
      seenChatIds.delete(String(id));
    }
    el.remove();
  }
  markHistoryStart();
};

/**
 * Park the view on the NEWEST message and hold it there briefly.
 *
 * One `scrollTop = scrollHeight` is not enough in this panel, and each of these strands the reader
 * in the middle of old history instead of at the latest message:
 *   - reactions hydrate after the rows are appended, so every message carrying one grows AFTER the
 *     scroll has already been set;
 *   - the panel is MOVED between hosts on route changes (relocateChat in main.js), and moving a
 *     node resets its scrollTop to 0 — the top, i.e. the oldest message;
 *   - on a phone the drawer is display:none until it opens, and a scrollTop written to a
 *     display:none element is silently discarded.
 * So re-pin every frame for a short window. Any sign the reader is scrolling themselves releases
 * it immediately — this must never fight someone reading scrollback.
 */
let releasePin = null;
const PIN_RELEASE_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'];
export const pinChatToLatest = (holdMs = 1200) => {
  const el = chatMessagesEl;
  if (!el) return;
  releasePin?.();
  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    PIN_RELEASE_EVENTS.forEach((type) => el.removeEventListener(type, stop));
    if (releasePin === stop) releasePin = null;
  };
  releasePin = stop;
  PIN_RELEASE_EVENTS.forEach((type) => el.addEventListener(type, stop, { passive: true }));
  const deadline = performance.now() + holdMs;
  const step = () => {
    el.scrollTop = el.scrollHeight;
    if (performance.now() < deadline) raf = requestAnimationFrame(step);
    else stop();
  };
  step();
};

let pipEl = null;
const showNewMessagePip = () => {
  if (pipEl || !chatMessagesEl?.parentElement) return;
  pipEl = document.createElement('button');
  pipEl.type = 'button';
  pipEl.className = 'chat-new-pip';
  pipEl.textContent = 'New messages ↓';
  pipEl.addEventListener('click', () => {
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    pipEl?.remove();
    pipEl = null;
  });
  chatMessagesEl.parentElement.appendChild(pipEl);
};

export const appendChatMessage = (row) => {
  if (!chatMessagesEl || (!row?.body && !row?.image)) return;
  const id = row.id;
  if (id) {
    if (seenChatIds.has(id)) return;
    seenChatIds.add(id);
  }
  document.querySelector('#chat-empty')?.setAttribute('hidden', '');
  // Only auto-scroll if the reader is already at the bottom — yanking the
  // viewport while someone reads scrollback is the classic chat sin.
  const atBottom = chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 60;
  const el = renderChatMessage(row);
  chatMessagesEl.appendChild(el);
  trimChatToLimit();
  requestAnimationFrame(() => el.classList.add('entered'));
  if (atBottom) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  else showNewMessagePip();
};

export function removeChatMessageLocal(messageId) {
  const entry = messageIndex.get(messageId)
    || messageIndex.get(Number(messageId))
    || messageIndex.get(String(messageId));
  if (entry?.el) entry.el.remove();
  for (const key of [messageId, Number(messageId), String(messageId)]) {
    messageIndex.delete(key);
    seenChatIds.delete(key);
  }
}

async function deleteChatMessage(messageId) {
  if (!isChatAdmin) return;
  if (!host.requireWallet('Delete messages')) return;
  try {
    const { res, data } = await authedFetchJson(`${FUNCTIONS_URL}/chat-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: Number(messageId) }),
    });
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    removeChatMessageLocal(messageId);
    host.notify('Message deleted');
  } catch (err) {
    host.notify(err.message || 'Could not delete message');
  }
}

// ------------------------------------------------------------------ history
export async function loadChatHistory() {
  if (!chatMessagesEl || !supabase) return;
  try {
    const { data, error } = await supabase
      .from('chat_feed').select('*')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) { console.warn('chat history failed to load', error); return; }

    chatMessagesEl.textContent = '';
    messageIndex.clear();
    seenChatIds.clear();
    myReactions.clear();

    const rows = data || [];
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.id = 'chat-empty';
    const strong = document.createElement('strong');
    strong.textContent = 'No messages yet';
    const p = document.createElement('p');
    // Guest chat is intentionally open on devnet/testnet. Keep the empty state aligned with
    // the composer so visitors are not told to connect before they can send a first message.
    p.textContent = chatCanSend
      ? 'Say hello to the miners.'
      : 'Connect your wallet and say hello to the miners.';
    empty.append(strong, p);
    if (rows.length) empty.hidden = true;
    chatMessagesEl.appendChild(empty);

    [...rows].reverse().forEach(appendChatMessage);
    if (rows.length) markHistoryStart();
    pinChatToLatest();
    await hydrateReactions(rows.map((r) => r.id));
    // Reactions land after the await and add a row of chips to any message carrying one, so the
    // list is taller now than when the pin above started. Re-pin briefly rather than assume it held.
    pinChatToLatest(400);
  } catch (err) {
    console.warn('chat history request failed', err);
  }
}

// ------------------------------------------------------------------ sending
async function sendChatMessage() {
  if (!chatInputEl) return;
  if (!chatCanSend) {
    host.notify(chatHintEl?.textContent || 'Chat access is not available yet');
    return;
  }

  const caption = chatInputEl.value.trim();
  const imagePath = stickers?.getPending() || null;
  if (!caption && !imagePath) return;

  const pendingReply = replyTarget;
  // Encode the image first, then the reply wrapper — keeps it under 300 chars.
  let outboundBody = imagePath ? encodeImageBody(imagePath, caption) : caption;
  outboundBody = encodeReplyBody(pendingReply, outboundBody);

  const restore = () => {
    chatInputEl.value = caption;
    if (imagePath) stickers?.setPending(imagePath);
    syncChatCharCount();
    if (pendingReply) { replyTarget = pendingReply; renderReplyBar(); }
  };

  chatInputEl.value = '';
  stickers?.clearPending();
  syncChatCharCount();
  cancelReply();
  if (chatSendButtonEl) chatSendButtonEl.disabled = true;

  try {
    const session = host.getAccount() ? await ensureSession() : null;
    const headers = { 'Content-Type': 'application/json', 'X-Guest-Id': getGuestId() };
    if (session?.token) headers.Authorization = `Bearer ${session.token}`;
    setChatComposeEnabled(true, 'Send a message…');

    const { res, data } = await fetchJson(`${FUNCTIONS_URL}/chat-send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: outboundBody }),
    });
    if (!res.ok) {
      host.notify(data.error || 'Message failed to send');
      restore();
      return;
    }
    // Realtime echoes our own message back (broadcast self:true), but render the
    // server's copy immediately so sending feels instant on a slow socket.
    appendChatMessage(data.message ?? {
      body: outboundBody,
      walletAddress: session?.walletAddress || null,
      displayName: session ? profileDisplayName() : 'Guest',
      avatarUrl: getMyProfile()?.avatarUrl || null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    restore();
    host.notify(err.message || 'Message failed to send');
  } finally {
    if (chatSendButtonEl) chatSendButtonEl.disabled = false;
  }
}

// ----------------------------------------------------------------- realtime
let chatChannel = null;
let chatReconnectTimer = 0;

export async function wireChatRealtime(handlers = {}) {
  if (!supabase) return;
  setChatStatus('connecting');
  try { chatChannel?.unsubscribe(); } catch { /* ignore */ }

  // Authenticate the socket with the anon key *before* phx_join. A floating
  // setAuth() races subscribe() and leaves the badge stuck on Offline.
  try {
    await supabase.realtime.setAuth(SUPABASE_ANON_KEY);
  } catch (err) {
    console.warn('realtime setAuth failed', err);
  }

  chatChannel = supabase.channel(CHAT_TOPIC, {
    config: { broadcast: { self: true }, private: false },
  })
    .on('broadcast', { event: 'message' }, ({ payload }) => appendChatMessage(payload))
    .on('broadcast', { event: 'reaction' }, ({ payload }) => {
      const mid = payload.messageId;
      const entry = messageIndex.get(mid) || messageIndex.get(Number(mid)) || messageIndex.get(String(mid));
      if (!entry) return;
      entry.reactions.set(payload.emoji, payload.count);
      renderReactionBar(entry, entry.reactions);
      if (payload.reacted && payload.walletAddress !== getMyProfile()?.walletAddress) {
        animateReaction(mid, payload.emoji);
      }
    })
    .on('broadcast', { event: 'profile' }, ({ payload }) => handlers.onProfile?.(payload))
    .on('broadcast', { event: 'message_delete' }, ({ payload }) => {
      if (payload?.id != null) removeChatMessageLocal(payload.id);
    })
    .on('broadcast', { event: 'news' }, ({ payload }) => { if (payload) handlers.onNews?.(payload); })
    .on('broadcast', { event: 'news_delete' }, ({ payload }) => {
      if (payload?.id != null) handlers.onNewsDelete?.(payload.id);
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') { setChatStatus('live'); return; }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn('chat realtime', status, err?.message || err || '');
        setChatStatus('offline');
        window.clearTimeout(chatReconnectTimer);
        chatReconnectTimer = window.setTimeout(() => { void wireChatRealtime(handlers); }, 2500);
        return;
      }
      setChatStatus('connecting');
    });
}

// -------------------------------------------------------------------- mount
export function mountChat(hostAdapter, handlers = {}) {
  host = { ...host, ...hostAdapter };

  chatMessagesEl = document.querySelector('.chat-messages');
  chatComposeEl = document.querySelector('.chat-compose');
  chatInputEl = document.querySelector('.chat-compose textarea');
  chatSendButtonEl = document.querySelector('.chat-compose .chat-send-btn');
  chatStatusEl = document.querySelector('#chat-status');
  chatCharCountEl = document.querySelector('#chat-char-count');
  chatHintEl = document.querySelector('#chat-hint');

  if (!chatMessagesEl) return null;

  stickers = mountStickerPicker({
    notify: host.notify,
    requireWallet: host.requireWallet,
    focusInput: () => chatInputEl?.focus(),
  });

  chatSendButtonEl?.addEventListener('click', sendChatMessage);
  chatInputEl?.addEventListener('input', syncChatCharCount);
  chatInputEl?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (stickers?.isOpen()) { event.preventDefault(); stickers.close(); return; }
      if (replyTarget) { event.preventDefault(); cancelReply(); return; }
    }
    // Enter sends; Shift+Enter inserts a newline (textarea default).
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });
  chatInputEl?.addEventListener('focus', () => {});

  chatMessagesEl.addEventListener('scroll', () => {
    const atBottom = chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 60;
    if (atBottom && pipEl) { pipEl.remove(); pipEl = null; }
  });

  syncChatCharCount();
  void wireChatRealtime(handlers);
  void loadChatHistory();

  return { loadChatHistory, appendChatMessage, setChatComposeEnabled };
}
