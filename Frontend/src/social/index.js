import { isSocialConfigured } from './config.js';
import { configureSession, getSession, clearSession } from './session.js';
import {
  mountChat, setChatComposeEnabled, setChatAdmin, getMessageIndex, loadChatHistory,
  pinChatToLatest,
} from './chat.js';
import {
  configureProfile, loadMyProfile, openProfileEditor, applyProfileBroadcast, getMyProfile,
  buildAvatar, avatarPublicUrl, saveProfile, fileToAvatarDataUrl, checkNameAvailable,
} from './profile.js';
import {
  mountNews, upsertNewsCard, removeNewsCard, refreshChatAdmin, loadNewsFeed,
} from './news.js';

/**
 * Single entry point for the social layer.
 *
 * `mountSocial` takes a small host adapter so this whole subsystem stays
 * independent of how the app connects wallets or shows toasts:
 *
 *   notify(message)      — surface a short message to the user
 *   getAccount()         — currently connected address, or null
 *   connectWallet()      — start the app's connect flow
 *   setRoute(name, opts) — navigate (news cards can deep-link)
 *   subscribe(fn)        — call fn whenever the connected account changes
 *   copyText(text)       — copy to clipboard, resolving true on success
 *
 * Nothing here reaches back into main.js directly.
 */
export function mountSocial(host) {
  if (!isSocialConfigured) {
    console.warn('[social] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — chat and profiles are disabled.');
    const compose = document.querySelector('.chat-compose textarea');
    if (compose) {
      compose.readOnly = true;
      compose.placeholder = 'Chat unavailable';
    }
    return null;
  }

  /**
   * A wallet must be connected before anything that writes. Returns false and
   * nudges the user when it isn't, so callers read as a guard clause.
   */
  const requireWallet = (action = 'Join the chat') => {
    if (host.getAccount()) return true;
    host.notify(`${action} — connect your wallet first`);
    host.connectWallet?.();
    const btn = document.querySelector('#connect-wallet');
    btn?.classList.add('nudge');
    setTimeout(() => btn?.classList.remove('nudge'), 1200);
    return false;
  };

  const adapter = {
    notify: host.notify,
    getAccount: host.getAccount,
    connectWallet: host.connectWallet,
    setRoute: host.setRoute,
    copyText: host.copyText,
    requireWallet,
  };

  configureSession({ getConnectedWallet: host.getAccount, notify: host.notify });
  configureProfile(adapter);

  mountChat(adapter, {
    onProfile: (payload) => applyProfileBroadcast(payload, getMessageIndex()),
    onNews: (item) => upsertNewsCard(item),
    onNewsDelete: (id) => removeNewsCard(id),
  });

  mountNews(adapter);

  /**
   * Re-resolve everything that depends on who is connected.
   *
   * The host's subscribe() fires on every poll tick, not only on account
   * changes, so this bails unless the address actually moved — otherwise every
   * tick would refetch the profile and re-render the whole history.
   */
  let lastAccount;
  const syncAccount = async ({ force = false } = {}) => {
    const account = host.getAccount();
    const key = account ? account.toLowerCase() : null;
    if (!force && key === lastAccount) return;
    const previous = lastAccount;
    lastAccount = key;

    setChatComposeEnabled(Boolean(account));

    if (!account) {
      // Only a REAL disconnect drops the session (previous held an address).
      // At page load the account is briefly null while the wallet connection is
      // being restored — clearing here would destroy a valid 24h session on
      // every reload and force a pointless re-signature.
      if (previous) {
        clearSession();
        setChatAdmin(false);
        document.querySelector('#news-admin')?.setAttribute('hidden', '');
      }
      return;
    }

    const session = getSession();
    if (session && session.walletAddress.toLowerCase() !== account.toLowerCase()) {
      clearSession();
    }
    await loadMyProfile(getMessageIndex());
    const admin = await refreshChatAdmin();
    // Admin controls are per-message, so re-render once the answer is known.
    if (admin) { setChatAdmin(true); await loadChatHistory(); await loadNewsFeed(); }
  };

  void syncAccount({ force: true });
  host.subscribe?.(() => { void syncAccount(); });

  return {
    syncAccount,
    /**
     * Jump the message list to the newest message. main.js calls this whenever it shows or MOVES
     * the panel, because both leave the list scrolled to the oldest message. See pinChatToLatest.
     */
    showLatestMessages: pinChatToLatest,
    getMyProfile,
    buildAvatar,
    /** Resolve a stored avatar path (or the per-wallet shim) to a usable URL. */
    avatarUrlFor: (wallet, path = null) => avatarPublicUrl(path, wallet),
    fileToAvatarDataUrl,
    checkNameAvailable,
    /** Constraints are enforced by the server and the 0003 CHECK — mirror, don't invent. */
    nameLimits: { min: 2, max: 24 },
    saveProfile: (fields) => saveProfile(fields, getMessageIndex()),
    reloadProfile: () => loadMyProfile(getMessageIndex()),
    openProfileEditor: () => openProfileEditor(getMessageIndex()),
  };
}
