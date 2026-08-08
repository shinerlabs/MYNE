import { connection, assertConfiguredCluster } from './client.js';

const accountSubscriptions = new Map();

const scheduleAccountRetry = (entry) => {
  if (!entry.listeners.size || entry.retryTimer !== null) return;
  entry.retryTimer = globalThis.setTimeout(() => {
    entry.retryTimer = null;
    void startAccountSubscription(entry);
  }, entry.retryDelayMs);
  entry.retryDelayMs = Math.min(15_000, entry.retryDelayMs * 2);
};

async function startAccountSubscription(entry) {
  if (entry.id !== null || entry.startRequest || !entry.listeners.size) return;
  const request = (async () => {
    try {
      await assertConfiguredCluster();
      const id = await connection.onAccountChange(entry.address, (account, context) => {
        for (const listener of entry.listeners) {
          try { listener({ address: entry.address, account, slot: context?.slot ?? null }); }
          catch (error) { console.warn('account realtime listener failed', error); }
        }
      }, 'confirmed');
      if (!entry.listeners.size) {
        await connection.removeAccountChangeListener(id).catch(() => {});
        return;
      }
      entry.id = id;
      entry.retryDelayMs = 1_000;
    } catch (error) {
      // The page's existing bounded poll remains active while the socket retries. web3.js handles
      // reconnecting an established subscription; this path covers an initial WSS failure.
      console.warn(`account realtime unavailable for ${entry.key}; polling remains active`, error);
      scheduleAccountRetry(entry);
    }
  })().finally(() => {
    if (entry.startRequest === request) entry.startRequest = null;
  });
  entry.startRequest = request;
  await request;
}

/** Share one accountSubscribe registration between every consumer of the same PDA. */
export function subscribeAccountActivity(address, listener) {
  if (!address || typeof listener !== 'function') return () => {};
  const key = address.toBase58?.() ?? String(address);
  let entry = accountSubscriptions.get(key);
  if (!entry) {
    entry = {
      key, address, listeners: new Set(), id: null, startRequest: null,
      retryTimer: null, retryDelayMs: 1_000,
    };
    accountSubscriptions.set(key, entry);
  }
  entry.listeners.add(listener);
  void startAccountSubscription(entry);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size) return;
    accountSubscriptions.delete(key);
    if (entry.retryTimer !== null) globalThis.clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    if (entry.id !== null) {
      const id = entry.id;
      entry.id = null;
      void connection.removeAccountChangeListener(id).catch(() => {});
    }
  };
}
