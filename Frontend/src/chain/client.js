import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getWallets } from '@wallet-standard/app';
import { StandardConnect, StandardDisconnect, StandardEvents } from '@wallet-standard/features';
import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  SolanaSignTransaction,
} from '@solana/wallet-standard-features';
import bs58 from 'bs58';
import { NETWORK, PROTOCOL_READY } from '../app-config.js';
import { createClusterGenesisGuard } from './cluster-genesis.js';
import { setChainSkew } from './round.js';

export const connection = new Connection(NETWORK.rpcUrl, 'confirmed');
const ENV = import.meta.env ?? {};
const clusterGenesisGuard = createClusterGenesisGuard({
  cluster: NETWORK.cluster,
  fetchGenesisHash: () => connection.getGenesisHash(),
  expectedLocalGenesisHash: ENV.VITE_SOLANA_GENESIS_HASH || '',
});
export const assertConfiguredCluster = (options) => clusterGenesisGuard.verify(options);
export const getVerifiedCluster = () => clusterGenesisGuard.current();
const unavailable = () => { throw new Error('Solana protocol programs have not been deployed yet'); };

// Legacy chain modules consume this name. It intentionally cannot issue Solana calls.
export const publicClient = new Proxy({}, { get: () => unavailable });
export const withGasHeadroom = async (request) => request;
export const syncChainClock = async () => {
  await assertConfiguredCluster();
  const startedAt = Date.now() / 1000;
  const slot = await connection.getSlot('confirmed');
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) return null;
  const measuredAt = (startedAt + Date.now() / 1000) / 2;
  const skew = blockTime - measuredAt;
  setChainSkew(skew);
  return skew;
};

const STORAGE_KEY = 'gld.solana.wallet';
let account = null;
let active = null;
const listeners = new Set();

const standardChain = ({ cluster }) => cluster === 'mainnet-beta'
  ? 'solana:mainnet'
  : cluster === 'testnet' ? 'solana:testnet' : 'solana:devnet';

function standardCandidates() {
  let wallets;
  try { wallets = getWallets().get(); } catch { return []; }
  // Wallet Standard implementations are expected to expose a feature record, but a few
  // older adapters shipped a Map-like object instead. Read both shapes so those wallets
  // remain connectable while the ecosystem finishes converging on the standard record.
  const feature = (wallet, key) => wallet?.features?.[key] || wallet?.features?.get?.(key);
  return wallets
    .filter((wallet) => feature(wallet, StandardConnect)?.connect
      && (feature(wallet, SolanaSignTransaction)?.signTransaction
        || feature(wallet, SolanaSignAndSendTransaction)?.signAndSendTransaction))
    .map((wallet) => {
      const id = `standard:${wallet.name}`;
      let selectedAccount = wallet.accounts?.[0] ?? null;
      const eventListeners = new Set();
      const provider = {
        async connect(options = {}) {
          const result = await feature(wallet, StandardConnect).connect(
            options.onlyIfTrusted ? { silent: true } : undefined,
          );
          selectedAccount = result.accounts?.[0] ?? wallet.accounts?.[0] ?? null;
          if (!selectedAccount) throw new Error(`${wallet.name} did not return a Solana account`);
          return { publicKey: new PublicKey(selectedAccount.address) };
        },
        async disconnect() {
          await feature(wallet, StandardDisconnect)?.disconnect?.();
        },
        async signTransaction(transaction) {
          const signer = feature(wallet, SolanaSignTransaction);
          if (!signer?.signTransaction) throw new Error(`${wallet.name} does not support transaction signing`);
          const signed = await signer.signTransaction({
            account: selectedAccount ?? wallet.accounts?.[0],
            transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
            chain: standardChain(NETWORK),
          });
          return Transaction.from(signed[0].signedTransaction);
        },
        async signAllTransactions(transactions) {
          const signer = feature(wallet, SolanaSignTransaction);
          if (!signer?.signTransaction) throw new Error(`${wallet.name} does not support transaction signing`);
          const signed = await Promise.all(transactions.map((transaction) => signer.signTransaction({
            account: selectedAccount ?? wallet.accounts?.[0],
            transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
            chain: standardChain(NETWORK),
          })));
          return signed.map((result) => Transaction.from(result[0].signedTransaction));
        },
        async signMessage(message) {
          const signer = feature(wallet, SolanaSignMessage);
          if (!signer?.signMessage) throw new Error(`${wallet.name} does not support message signing`);
          const signed = await signer.signMessage({
            account: selectedAccount ?? wallet.accounts?.[0],
            message: message instanceof Uint8Array ? message : new Uint8Array(message),
          });
          const signature = signed?.[0]?.signature;
          if (!signature) throw new Error(`${wallet.name} did not return a message signature`);
          return signature;
        },
        async signAndSendTransaction(transaction, options = {}) {
          const signer = feature(wallet, SolanaSignAndSendTransaction);
          if (!signer?.signAndSendTransaction) {
            const signed = await this.signTransaction(transaction);
            return connection.sendRawTransaction(signed.serialize(), {
              preflightCommitment: 'confirmed', maxRetries: 3, ...options,
            });
          }
          const sent = await signer.signAndSendTransaction({
            account: selectedAccount ?? wallet.accounts?.[0],
            transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
            chain: standardChain(NETWORK),
            options: { commitment: 'confirmed', ...options },
          });
          return bs58.encode(sent[0].signature);
        },
        on(event, callback) {
          if (event !== 'accountChanged') return () => {};
          eventListeners.add(callback);
          return () => eventListeners.delete(callback);
        },
      };
      feature(wallet, StandardEvents)?.on?.('change', ({ accounts }) => {
        selectedAccount = accounts?.[0] ?? wallet.accounts?.[0] ?? null;
        eventListeners.forEach((callback) => callback(selectedAccount ? new PublicKey(selectedAccount.address) : null));
      });
      return { id, name: wallet.name, provider, icon: wallet.icon };
    });
}

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
  const standards = standardCandidates();
  const standardNames = new Set(standards.map((wallet) => wallet.name.toLowerCase()));
  // Prefer Wallet Standard entries when a wallet exposes both APIs, while retaining legacy
  // fallbacks for older extensions.
  return [...standards, ...found.filter((wallet) => !standardNames.has(wallet.name.toLowerCase()))];
};

export async function discoverWallets() {
  return candidates().map(({ id, name, provider, icon }) => ({ rdns: id, name, icon: provider?.icon || icon || null }));
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
  if (!wallet) throw new Error('No Solana wallet found — install a compatible Solana wallet');
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
  const messages = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause ?? current.error) {
    seen.add(current);
    if (typeof current === 'string') messages.push(current);
    else if (current?.message) messages.push(current.message);
  }
  const detail = messages.join(' · ');
  if (/reject|cancel/i.test(detail)) return 'Transaction rejected';
  if (/extension-created tab.*blocked|popup|pop-up|user activation|user gesture|notallowederror|window.*(?:blocked|open)/i.test(detail)) {
    return 'Wallet popup was blocked — click Connect and choose your wallet again';
  }
  return (error?.message || 'Transaction failed').split('\n')[0];
}
