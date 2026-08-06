import { Connection, PublicKey } from '@solana/web3.js';
import { NETWORK, PROTOCOL_READY } from '../app-config.js';

export const connection = new Connection(NETWORK.rpcUrl, 'confirmed');
const unavailable = () => { throw new Error('Solana protocol programs have not been deployed yet'); };

// Legacy chain modules consume this name. It intentionally cannot issue Solana calls.
export const publicClient = new Proxy({}, { get: () => unavailable });
export const withGasHeadroom = async (request) => request;
export const syncChainClock = async () => {
  const startedAt = Date.now() / 1000;
  const slot = await connection.getSlot('confirmed');
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) return null;
  const measuredAt = (startedAt + Date.now() / 1000) / 2;
  const skew = blockTime - measuredAt;
  const { setChainSkew } = await import('./round.js');
  setChainSkew(skew);
  return skew;
};

const STORAGE_KEY = 'gld.solana.wallet';
let account = null;
let active = null;
const listeners = new Set();

const candidates = () => {
  if (typeof window === 'undefined') return [];
  const found = [];
  const add = (id, name, provider) => {
    if (provider?.connect && !found.some((x) => x.provider === provider)) found.push({ id, name, provider });
  };
  add('phantom', 'Phantom', window.phantom?.solana);
  add('solflare', 'Solflare', window.solflare);
  add('backpack', 'Backpack', window.backpack);
  add('injected', 'Solana wallet', window.solana);
  return found;
};

export async function discoverWallets() {
  return candidates().map(({ id, name, provider }) => ({ rdns: id, name, icon: provider?.icon || null }));
}
export const getLastWalletRdns = () => typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
export const getAccount = () => account;
export const getWalletClient = () => active?.provider ?? null;
export const getWalletInfo = () => active ? { rdns: active.id, name: active.name } : null;
export const getProvider = () => active?.provider ?? null;
export const listWallets = () => candidates().map(({ id, name }) => ({ rdns: id, name }));
export const hasInjectedWallet = () => candidates().length > 0;
export const onAccountChange = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };

function setAccount(value) {
  account = value || null;
  listeners.forEach((listener) => listener(account));
}
function bind(wallet, publicKey) {
  active = wallet;
  localStorage.setItem(STORAGE_KEY, wallet.id);
  setAccount(new PublicKey(publicKey).toBase58());
  wallet.provider.on?.('accountChanged', (key) => setAccount(key ? new PublicKey(key).toBase58() : null));
  wallet.provider.on?.('disconnect', () => disconnect());
}

export async function connect(id) {
  const wallets = candidates();
  const wallet = wallets.find((x) => x.id === id) || wallets.find((x) => x.id === getLastWalletRdns()) || wallets[0];
  if (!wallet) throw new Error('No Solana wallet found — install Phantom, Solflare, or Backpack');
  const result = await wallet.provider.connect();
  const key = result?.publicKey || wallet.provider.publicKey;
  if (!key) throw new Error('The wallet did not return a Solana public key');
  bind(wallet, key);
  return account;
}

export async function restoreConnection() {
  const id = getLastWalletRdns();
  if (!id) return null;
  const wallet = candidates().find((x) => x.id === id);
  if (!wallet) return null;
  try {
    const result = await wallet.provider.connect({ onlyIfTrusted: true });
    const key = result?.publicKey || wallet.provider.publicKey;
    if (!key) return null;
    bind(wallet, key);
    return account;
  } catch { return null; }
}

export function disconnect() {
  active?.provider?.disconnect?.().catch?.(() => {});
  localStorage.removeItem(STORAGE_KEY);
  active = null;
  setAccount(null);
}

export const protocolAvailable = () => PROTOCOL_READY;
export function readableError(error) {
  if (/reject|cancel/i.test(error?.message || '')) return 'Transaction rejected';
  return (error?.message || 'Transaction failed').split('\n')[0];
}
