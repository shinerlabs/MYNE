import { isSocialConfigured } from './config.js';
import { configureSession, getSession, clearSession } from './session.js';
import {
  mountChat, setChatComposeEnabled, getMessageIndex,
  pinChatToLatest,
} from './chat.js';
import {
  configureProfile, loadMyProfile, openProfileEditor, applyProfileBroadcast, getMyProfile,
  buildAvatar, avatarPublicUrl, saveProfile, fileToAvatarDataUrl, checkNameAvailable,
  loadPublicProfile,
} from './profile.js';

/**
 * Single entry point for the social layer.
 *
 * `mountSocial` takes a small host adapter so this whole subsystem stays
 * independent of how the app connects wallets or shows toasts:
 *
 *   notify(message)      — surface a short message to the user
 *   getAccount()         — currently connected address, or null
 *   connectWallet()      — start the app's connect flow
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
    chatRequiresMinedRounds: Boolean(host.chatRequiresMinedRounds),
  };

  configureSession({ getConnectedWallet: host.getAccount, notify: host.notify });
  configureProfile(adapter);

  mountChat(adapter, {
    onProfile: (payload) => applyProfileBroadcast(payload, getMessageIndex()),
  });

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
    const key = account || null;
    if (!force && key === lastAccount) return;
    const previous = lastAccount;
    lastAccount = key;

    // Every chat message is wallet-authenticated on every cluster so moderation can identify
    // and block the sender. Once the production mining gate is enabled, five mined rounds are
    // required in addition to the wallet connection.
    let chatAllowed = Boolean(account);
    let chatGate = '';
    if (account && host.chatRequiresMinedRounds) {
      const mined = await host.getMinedRoundCount?.(account);
      chatAllowed = Number.isFinite(mined) && mined >= 5;
      if (!chatAllowed) chatGate = mined == null
        ? 'Your mined-round history could not be verified yet.'
        : `Mine ${Math.max(0, 5 - mined)} more round${5 - mined === 1 ? '' : 's'} to unlock chat.`;
    }
    setChatComposeEnabled(chatAllowed, undefined, chatGate);

    if (!account) {
      // Only a REAL disconnect drops the session (previous held an address).
      // At page load the account is briefly null while the wallet connection is
      // being restored — clearing here would destroy a valid 24h session on
      // every reload and force a pointless re-signature.
      if (previous) {
        clearSession();
      }
      return;
    }

    const session = getSession();
    if (session && session.walletAddress !== account) {
      clearSession();
    }
    await loadMyProfile(getMessageIndex());
  };

  void syncAccount({ force: true });
  host.subscribe?.(() => { void syncAccount(); });
  // A connected mainnet miner can cross the five-round threshold while remaining on the page.
  // Recheck periodically without tying an RPC/index query to every chain clock tick.
  if (host.chatRequiresMinedRounds) {
    window.setInterval(() => {
      if (host.getAccount()) void syncAccount({ force: true });
    }, 60_000);
  }

  return {
    syncAccount,
    /**
     * Jump the message list to the newest message. main.js calls this whenever it shows or MOVES
     * the panel, because both leave the list scrolled to the oldest message. See pinChatToLatest.
     */
    showLatestMessages: pinChatToLatest,
    getMyProfile,
    loadPublicProfile,
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
