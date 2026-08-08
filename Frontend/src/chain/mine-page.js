import { formatEther, parseEther } from './units.js';
import { PublicKey } from '@solana/web3.js';

import {
  UNLIMITED_PLAYS, cancelPlan, configurePlan, depositToPlan,
  autoPlanSetupReserve, maxAutoPlanFundingLamports, readFeeParams, readPlan, requiredDeposit,
} from './autocommit.js';

export { UNLIMITED_PLAYS };

import { ACCOUNT_DEPOSIT, economics, explorerTx, MIN_ROUND_DEPLOYMENT, protocolReady } from './config.js';
import {
  connect, disconnect, discoverWallets, getAccount, getLastWalletRdns, hasInjectedWallet,
  onAccountChange, readableError, restoreConnection, syncChainClock,
} from './client.js';
import {
  claimManyRounds, decodeRoundAccountData, invalidateReceiptCache, NO_UNCLAIMED_RECEIPTS, placeBet, readJackpot, readMiner, readMyBets, readRound, readRoundWithContext, netClaimable, passiveOnRounds,
  verifyFeeEconomics, verifyPremine, verifyRoundTiming, waitForTx, withdrawUnrefined,
  burnUnclaimedMyne, claimManyEthOnly, syncRoundGenesis,
} from './lottery.js';
import {
  derivePda, getProtocolConfig, invalidateProtocolConfig, protocolPdas, u64Seed,
} from './anchor-client.js';
import { minerPda, stakePositionPda } from './miner-registration.js';
import { subscribeAccountActivity } from './protocol-realtime.js';
import {
  loadLatestIndexedRoundId, loadLatestPlayedSettledRound, loadLatestSettledRound,
} from './rounds-index.js';
import {
  ROUND_DURATION, BETTING_DURATION, isPremine,
} from './config.js';
import { formatClock, nowSeconds, roundPhaseLabel, roundPresentation, roundState } from './round.js';
import { claimStakingRewards as withdrawClaimableSol } from './staking.js';
import { mergeConfirmedTileBets } from './confirmed-tile-bets.js';

const short = (address) => `${address.slice(0, 6)}...${address.slice(-4)}`;
const eth = (value, digits = 3) => Number(formatEther(value)).toFixed(digits);

/** Compact two-decimal SOL display used consistently across the site. Raw lamports remain exact. */
const ethSmart = (value) => {
  const n = Number(formatEther(value));
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
};
const $ = (selector) => document.querySelector(selector);

/**
 * Live chain state for the Mine page. `main.js` renders from this; nothing here touches
 * layout, so the mockup's visual design is untouched.
 */
export const state = {
  roundId: 0n,
  phase: 'betting',
  secondsLeft: 0,
  squareTotals: Array(25).fill(0n),
  // Receipt positions per tile, straight from the chain. One wallet may submit
  // more than one receipt, so this must not be presented as a unique-wallet count.
  squareMiners: Array(25).fill(0n),
  myBets: Array(25).fill(0n),
  totalWager: 0n,
  jackpot: { native: 0n, bullion: 0n },
  balance: 0n,
  bullionBalance: 0n,
  unclaimed: 0n,
  claimableSol: 0n,
  refinedAccrued: 0n,
  // Outstanding mining-share supply. Unsettled rounds do not own shares and cannot receive fees
  // paid before their receipt is processed; see passiveOnRounds().
  minerIndex: 0n,
  // Decide the claim fee (0% / 1% / 10%) — see netClaimable in lottery.js.
  totalUnclaimed: 0n,
  hasReferrer: false,
  hasAccount: false,
  hasPosition: false,
  account: null,
  lastResolved: null,
  // Latest settled round with a real deployment. Empty rounds still advance
  // lastResolved and publish their winning tile, but must not erase the most
  // recent participant/reward card.
  lastPlayedResolved: null,
  currentRound: null, // full readRound() of state.roundId — carries its own `resolved`/winner
  currentRoundSlot: 0,
  plan: null, // MYNE auto-plan for the connected account (null = none configured)
  autoPlanMaxFee: null, // live rent for one BetReceipt; null means the RPC quote is unavailable
  autoPlanFundingReserve: 0n, // setup rent + configured fee budget excluded before applying 90%
  // Live maintenance status, refreshed with the round. `null` means the config
  // read has not completed; only an authoritative on-chain `true` disables Mine.
  protocolPaused: null,
  // No transaction may derive a round id until both the chain clock and
  // protocol genesis have been synchronized.
  clockReady: false,
  // Last Round PDA that actually existed when the authoritative pause was
  // observed. Unlike `roundId`, this does not advance with wall-clock time.
  pausedRoundId: null,
};

const nonDecreasingVector = (next = [], previous = []) => previous.every(
  (value, index) => BigInt(next[index] ?? 0) >= BigInt(value ?? 0),
);

/**
 * Apply a same-round confirmed snapshot without allowing an older HTTP response
 * to erase a newer websocket bid or settlement. Round counters are monotonic by
 * construction, so a decrease is always a stale/inconsistent read.
 */
const applyRoundSnapshot = (round, slot = 0) => {
  if (!round || BigInt(round.id ?? state.roundId) !== BigInt(state.roundId)) return false;
  const current = state.currentRound;
  const incomingSlot = Number(slot || 0);
  if (current) {
    if (incomingSlot > 0 && state.currentRoundSlot > 0 && incomingSlot < state.currentRoundSlot) return false;
    if (current.resolved && !round.resolved) return false;
    if (BigInt(current.requestedAt ?? 0) > 0n && BigInt(round.requestedAt ?? 0) === 0n) return false;
    if (BigInt(round.totalWager ?? 0) < BigInt(current.totalWager ?? 0)) return false;
    if (BigInt(round.totalReceipts ?? 0) < BigInt(current.totalReceipts ?? 0)) return false;
    if (!nonDecreasingVector(round.tileLamports, current.tileLamports)) return false;
    if (!nonDecreasingVector(round.tileReceipts, current.tileReceipts)) return false;
  }
  state.squareTotals = round.tileLamports ?? Array(25).fill(0n);
  state.squareMiners = round.tileReceipts ?? Array(25).fill(0n);
  state.totalWager = round.totalWager;
  state.currentRound = round;
  if (incomingSlot > 0) state.currentRoundSlot = Math.max(state.currentRoundSlot, incomingSlot);
  if (round.resolved) publishResolvedRound(state.roundId, round);
  return true;
};

const emptyTileBets = () => Array(25).fill(0n);
let confirmedTileBets = { roundId: null, account: null, amounts: emptyTileBets() };

const confirmedTileStorageKey = (roundId, account) => (
  roundId === null || !account ? null : `myne-confirmed-tiles-v1:${account}:${roundId}`
);

const persistConfirmedTileBets = () => {
  const key = confirmedTileStorageKey(confirmedTileBets.roundId, confirmedTileBets.account);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(confirmedTileBets.amounts.map(String)));
  } catch { /* private storage or quota; in-memory locking remains authoritative */ }
};

const restoreConfirmedTileBets = ({ roundId, account }) => {
  const key = confirmedTileStorageKey(roundId, account);
  if (!key) return false;
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    if (!Array.isArray(stored) || stored.length !== 25 || stored.some((value) => !/^\d+$/.test(String(value)))) {
      return false;
    }
    confirmedTileBets = { roundId, account, amounts: stored.map(BigInt) };
    return true;
  } catch { return false; }
};

const clearConfirmedTileBets = ({ removeStored = false } = {}) => {
  const key = confirmedTileStorageKey(confirmedTileBets.roundId, confirmedTileBets.account);
  if (removeStored && key) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
  confirmedTileBets = { roundId: null, account: null, amounts: emptyTileBets() };
};

const rememberConfirmedTileBets = ({ roundId, account, tiles, amountPerTile, baseAmounts = emptyTileBets() }) => {
  if (confirmedTileBets.roundId !== roundId || confirmedTileBets.account !== account) {
    confirmedTileBets = { roundId, account, amounts: emptyTileBets() };
  }
  for (const tile of tiles) {
    const index = Number(tile) - 1;
    if (index >= 0 && index < confirmedTileBets.amounts.length) {
      const priorTotal = BigInt(baseAmounts[index] ?? 0n);
      if (priorTotal > confirmedTileBets.amounts[index]) confirmedTileBets.amounts[index] = priorTotal;
      confirmedTileBets.amounts[index] += amountPerTile;
    }
  }
  persistConfirmedTileBets();
};

const reconcileConfirmedTileBets = ({ roundId, account, onChainBets }) => {
  if (confirmedTileBets.roundId !== roundId || confirmedTileBets.account !== account) {
    if (!restoreConfirmedTileBets({ roundId, account })) return onChainBets;
  }
  const merged = mergeConfirmedTileBets(onChainBets, confirmedTileBets.amounts);
  confirmedTileBets.amounts = confirmedTileBets.amounts.map((amount, index) => (
    BigInt(onChainBets[index] ?? 0n) >= amount ? 0n : amount
  ));
  if (confirmedTileBets.amounts.every((amount) => amount === 0n)) {
    clearConfirmedTileBets({ removeStored: true });
  } else {
    persistConfirmedTileBets();
  }
  return merged;
};

const subscribers = new Set();
export const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
const emit = () => subscribers.forEach((fn) => fn(state));

let notify = () => {};
export const setNotifier = (fn) => { notify = fn; };
let live = protocolReady;

/**
 * Mine is the only route that needs five-second tile reads. Other pages have their own scoped
 * refreshers, so pause this stream off-route and catch up immediately when Mine becomes active.
 */
export const setLive = (next) => {
  const active = protocolReady && Boolean(next);
  if (active === live) return;
  live = active;
  if (!live || document.hidden || !state.clockReady) return;
  void syncChainClock();
  tick();
  void refreshRound();
  void refreshJackpot();
  if (state.account) void refreshMiner();
};

// --- polling -------------------------------------------------------------------------

/**
 * Confirmed account subscriptions publish bids and results immediately. This
 * five-second snapshot is the bounded reconnect/missed-notification fallback;
 * the countdown itself ticks locally without RPC traffic.
 */
let roundRefreshRequest = null;
let walletBetsRefreshRequest = null;

const boundedWalletRead = (promise, timeoutMs = 8_000) => new Promise((resolve, reject) => {
  const timer = window.setTimeout(
    () => reject(new Error('Wallet receipt read timed out')),
    timeoutMs,
  );
  Promise.resolve(promise).then(
    (value) => { window.clearTimeout(timer); resolve(value); },
    (error) => { window.clearTimeout(timer); reject(error); },
  );
});

const refreshWalletBets = (roundId, account) => {
  const key = `${roundId}:${account}`;
  if (walletBetsRefreshRequest?.key === key) return walletBetsRefreshRequest.promise;
  const request = { key, promise: null };
  request.promise = (async () => {
    try {
      const myBets = await boundedWalletRead(readMyBets(roundId, account));
      if (state.roundId !== roundId || state.account !== account) return;
      state.myBets = reconcileConfirmedTileBets({
        roundId,
        account,
        onChainBets: myBets,
      });
      emit();
    } catch (error) {
      console.warn('wallet receipt refresh failed; public round remains current', error);
    }
  })().finally(() => {
    if (walletBetsRefreshRequest === request) walletBetsRefreshRequest = null;
  });
  walletBetsRefreshRequest = request;
  return request.promise;
};

async function refreshRound() {
  if (!state.clockReady) return;
  const requestedRoundId = BigInt(state.roundId);
  if (roundRefreshRequest?.roundId === requestedRoundId) return roundRefreshRequest.promise;

  const request = { roundId: requestedRoundId, promise: null };
  request.promise = (async () => {
    try {
      // One Round PDA contains both tile totals and tile participant counts. Reading it once avoids
      // two duplicate getAccountInfo calls on every five-second refresh (and during the result poll).
      const [roundResult, configResult] = await Promise.allSettled([
        readRoundWithContext(requestedRoundId),
        // A temporary config read failure must not hide public round data. Leave
        // the previous pause value intact and let the next five-second poll retry.
        getProtocolConfig(),
      ]);
      // A read started before the 65-second boundary belongs to the old board. Never let it
      // overwrite the newly rolled round, even if the RPC response arrives after tick() clears it.
      if (state.roundId !== requestedRoundId) return;

      if (configResult.status === 'fulfilled') {
        state.protocolPaused = Boolean(configResult.value.paused);
        if (!state.protocolPaused) {
          state.pausedRoundId = null;
        } else if (roundResult.status === 'fulfilled' && roundResult.value.round.requestedAt > 0n) {
          state.pausedRoundId = roundResult.value.round.id ?? requestedRoundId;
        } else {
          const indexedRoundId = await loadLatestIndexedRoundId(requestedRoundId);
          if (state.roundId !== requestedRoundId) return;
          if (indexedRoundId !== null) state.pausedRoundId = indexedRoundId;
        }
      }
      // A paused schedule may have no current Round PDA. Preserve the separately
      // fetched pause flag so the renderer can pin the latest verified winner,
      // then surface the round read failure through the existing retry path.
      if (roundResult.status === 'rejected') {
        emit();
        throw roundResult.reason;
      }
      const { round, slot } = roundResult.value;
      if (!applyRoundSnapshot(round, slot)) return;
      // Publish the authoritative public board before any wallet-specific receipt
      // lookup. A throttled receipt index/RPC must never delay bids or a winner.
      emit();
      const requestedAccount = state.account;
      if (!requestedAccount) {
        state.myBets = Array(25).fill(0n);
        emit();
        return;
      }
      // Wallet receipt enrichment is deliberately detached from the public
      // Round read. A slow/disabled account scan cannot hold the five-second
      // board/config reconciliation single-flight open.
      void refreshWalletBets(requestedRoundId, requestedAccount);
    } catch (error) {
      console.warn('round refresh failed', error);
    }
  })().finally(() => {
    if (roundRefreshRequest === request) roundRefreshRequest = null;
  });
  roundRefreshRequest = request;
  return request.promise;
}

async function refreshJackpot() {
  try {
    state.jackpot = await readJackpot();
    emit();
  } catch (error) {
    console.warn('jackpot refresh failed', error);
  }
}

/** Auto-round plan state. Only meaningful with a wallet connected. */
async function refreshPlan() {
  if (!state.account) {
    state.plan = null;
    state.autoPlanMaxFee = null;
    state.autoPlanFundingReserve = 0n;
    return emit();
  }
  try {
    const [planResult, feeResult] = await Promise.allSettled([
      readPlan(state.account),
      readFeeParams(),
    ]);
    if (feeResult.status === 'fulfilled') {
      state.autoPlanMaxFee = feeResult.value.maxFee;
      state.autoPlanFundingReserve = autoPlanSetupReserve({
        hasMiner: state.hasAccount,
        hasPlan: Boolean(planResult.status === 'fulfilled' && planResult.value),
        feeParams: feeResult.value,
      });
    } else {
      state.autoPlanMaxFee = null;
      state.autoPlanFundingReserve = 0n;
    }
    if (planResult.status === 'rejected') throw planResult.reason;
    const plan = planResult.value;
    // Keep a DISABLED plan visible while it still holds a balance. An exhausted
    // plan keeps its unspent deposit until cancelPlan() refunds it, so hiding it
    // here would strand the user's SOL with no withdrawal control.
    state.plan = plan && (plan.enabled || plan.balance > 0n) ? plan : null;
    emit();
  } catch (error) {
    console.warn('plan refresh failed', error);
  }
}

let minerRefreshId = 0;
let minerRefreshRequest = null;
let minerRefreshDirty = false;
let minerRefreshTimer = null;

const clearMinerState = () => {
    // Clear refinedAccrued / totalUnclaimed / hasReferrer too: they are per-ACCOUNT, and leaving
    // them behind on disconnect showed the previous wallet's passive balance to whoever connected
    // next. Harmless while the figure was folded into a net total; now that it has its own row it
    // would be read as the new wallet's earnings.
    Object.assign(state, {
      balance: 0n, bullionBalance: 0n, unclaimed: 0n, claimableSol: 0n,
      hasAccount: false, hasPosition: false,
      refinedAccrued: 0n, minerIndex: 0n, totalUnclaimed: 0n, hasReferrer: false,
      myBets: Array(25).fill(0n),
    });
};

export async function refreshMiner() {
  const requestedAccount = state.account;
  if (!requestedAccount) {
    clearMinerState();
    return emit();
  }
  if (minerRefreshRequest?.account === requestedAccount) {
    minerRefreshDirty = true;
    return minerRefreshRequest.promise;
  }
  const requestId = ++minerRefreshId;
  const request = { account: requestedAccount, promise: null };
  request.promise = (async () => {
  try {
    const miner = await readMiner(requestedAccount);
    // Wallet reads can resolve out of order when the user changes account or
    // reconnects while an RPC request is in flight. Never publish wallet A's
    // rewards into wallet B's action state.
    if (requestedAccount !== state.account) return null;
    // A newer refresh for the same wallet owns publication, but this caller
    // can still use its own verified snapshot for an in-progress action.
    if (requestId !== minerRefreshId) return miner;
    state.balance = miner.balance;
    state.bullionBalance = miner.bullionBalance;
    state.unclaimed = miner.rewardsBullion;
    state.claimableSol = miner.claimableSol ?? 0n;
    state.refinedAccrued = miner.refinedAccrued; // other miners' claim fees backing these shares
    state.minerIndex = miner.minerIndex ?? 0n;
    state.totalUnclaimed = miner.totalUnclaimed ?? 0n;
    state.hasReferrer = Boolean(miner.hasReferrer);
    state.hasAccount = miner.hasAccount;
    state.hasPosition = miner.hasPosition;
    emit();
    return miner;
  } catch (error) {
    if (requestId === minerRefreshId && requestedAccount === state.account) {
      console.warn('miner refresh failed', error);
    }
    return null;
  }
  })().finally(() => {
    if (minerRefreshRequest !== request) return;
    minerRefreshRequest = null;
    if (minerRefreshDirty && state.account === requestedAccount) {
      minerRefreshDirty = false;
      queueMicrotask(() => { void refreshMiner(); });
    }
  });
  minerRefreshRequest = request;
  return request.promise;
}

const scheduleMinerRefresh = () => {
  if (!state.account || minerRefreshTimer !== null) return;
  // A settlement mutates several subscribed accounts in one transaction.
  // Coalesce their notifications into one wallet-ledger read instead of one
  // read per changed PDA; direct user actions still refresh immediately.
  minerRefreshTimer = window.setTimeout(() => {
    minerRefreshTimer = null;
    if (!document.hidden && state.account) void refreshMiner();
  }, 100);
};

/**
 * Ticks every second. When the slot number rolls over, the previous round has closed —
 * fetch its result so the UI can show the winning tile.
 */
let lastRevealPoll = 0;
function tick() {
  if (protocolReady && !state.clockReady) {
    emit();
    return;
  }
  const next = roundState();
  const rolled = next.roundId !== state.roundId;

  state.phase = next.phase;
  state.secondsLeft = next.secondsLeft;

  if (rolled) {
    clearConfirmedTileBets({ removeStored: true });
    state.roundId = next.roundId;
    syncRoundRealtime(next.roundId);
    // Use the new chain round as the anchor. If the tab was backgrounded, `state.roundId` may
    // be multiple rounds behind and is not necessarily the previous round anymore.
    const previous = next.roundId > 0n ? next.roundId - 1n : null;
    state.squareTotals = Array(25).fill(0n);
    state.squareMiners = Array(25).fill(0n);
    state.myBets = Array(25).fill(0n);
    state.totalWager = 0n;
    state.currentRound = null; // fresh round: not resolved, no winner yet
    state.currentRoundSlot = 0;
    if (live && previous !== null) loadResolved(previous);
    if (live) {
      refreshRound();
      refreshMiner();
    }
    // The keeper executes plans per round, so plays/balance change every rollover.
    if (state.plan) refreshPlan();
  }

  // Settlement is eligible the instant bidding closes. Poll quickly through the five-second
  // result window so the confirmed winner occupies as much of that window as RPC permits.
  if (live && state.phase === 'result' && !state.currentRound?.resolved && Date.now() - lastRevealPoll > 500) {
    lastRevealPoll = Date.now();
    refreshRound();
  }
  emit();
}

// Keep the live round and the immediately previous round subscribed at the
// same time. Settlement is intentionally asynchronous: the previous Round PDA
// may change a fraction of a second after the wall-clock id rolls forward. A
// single-current-round subscription drops that exact update and leaves the
// winner dependent on the slower database index.
const roundRealtimeStops = new Map();
let walletRealtimeStops = [];
let globalRealtimeStops = [];

const clearWalletRealtime = () => {
  for (const stop of walletRealtimeStops) stop();
  walletRealtimeStops = [];
};

const syncWalletRealtime = (account) => {
  clearWalletRealtime();
  if (!account) return;
  const authority = new PublicKey(account);
  const onRewardAccountChange = () => {
    invalidateReceiptCache();
    window.dispatchEvent(new Event('myne:reward-ledger-changed'));
    if (!document.hidden) scheduleMinerRefresh();
  };
  walletRealtimeStops = [
    subscribeAccountActivity(minerPda(authority), onRewardAccountChange),
    subscribeAccountActivity(stakePositionPda(authority), onRewardAccountChange),
    subscribeAccountActivity(derivePda('auto_plan', authority), () => {
      if (document.hidden) return;
      // execute_auto_plan mutates the plan and creates this wallet's receipt in
      // the same confirmed transaction. Refreshing only the plan made a
      // successful Auto Mine look as though no tile had been bid until the
      // next background poll. Keep the plan, board and wallet ledger aligned
      // with that single on-chain state change.
      void Promise.all([refreshPlan(), refreshRound(), refreshMiner()]);
    }),
  ];
};

const syncRoundRealtime = (roundId) => {
  const id = BigInt(roundId);
  const observed = new Set([id, ...(id > 0n ? [id - 1n] : [])].map(String));
  for (const [key, stop] of roundRealtimeStops) {
    if (observed.has(key)) continue;
    stop();
    roundRealtimeStops.delete(key);
  }
  for (const key of observed) {
    if (roundRealtimeStops.has(key)) continue;
    const observedId = BigInt(key);
    const stop = subscribeAccountActivity(derivePda('round', u64Seed(observedId)), ({ account, slot }) => {
      if (document.hidden || !live) return;
      try {
        // accountSubscribe already delivered the authoritative confirmed bytes.
        // Decode them immediately instead of waiting for a second HTTP RPC round
        // trip; the regular refresh below still reconciles wallet-specific bets
        // and acts as the fallback if a websocket payload cannot be decoded.
        const round = decodeRoundAccountData(observedId, account.data);
        if (observedId === state.roundId) {
          if (applyRoundSnapshot(round, slot)) emit();
        } else if (publishResolvedRound(observedId, round)) {
          emit();
          if (state.account) scheduleMinerRefresh();
        }
      } catch {
        if (observedId === state.roundId) void refreshRound();
        else void loadResolved(observedId);
      }
    });
    roundRealtimeStops.set(key, stop);
  }
};

const startGlobalRealtime = () => {
  if (globalRealtimeStops.length) return;
  globalRealtimeStops = [
    // Pause/provider/admin changes are rare, but when they happen the Mine controls must reflect
    // the authoritative config immediately rather than waiting for its 15-second cache.
    subscribeAccountActivity(protocolPdas.config, () => {
      invalidateProtocolConfig();
      if (!document.hidden && live) void refreshRound();
      if (!document.hidden) void refreshJackpot();
    }),
    // Passive MYNE and pending SOL can change when somebody else claims or a round distributes its
    // staking allocation. Both affect this wallet even when its own PDA bytes do not change.
    subscribeAccountActivity(protocolPdas.miningPool, () => {
      if (!document.hidden && state.account) scheduleMinerRefresh();
    }),
    subscribeAccountActivity(protocolPdas.stakePool, () => {
      if (!document.hidden && state.account) scheduleMinerRefresh();
    }),
  ];
};

/**
 * At rollover the previous round should already be settled. Retry briefly if RPC confirmation
 * lags so the result tile and latest-played miners card update from known-good records.
 */
const publishResolvedRound = (roundId, round) => {
  const resolvedId = BigInt(roundId);
  if (!round?.resolved || resolvedId > state.roundId) return false;
  const latestId = state.lastResolved?.roundId == null
    ? -1n
    : BigInt(state.lastResolved.roundId);
  if (resolvedId >= latestId) state.lastResolved = { roundId: resolvedId, ...round };
  if (round.totalWager > 0n) {
    const latestPlayedId = state.lastPlayedResolved?.roundId == null
      ? -1n
      : BigInt(state.lastPlayedResolved.roundId);
    if (resolvedId >= latestPlayedId) {
      state.lastPlayedResolved = { roundId: resolvedId, ...round };
    }
  }
  return true;
};

const resolvedLoaders = new Map();
const resolvedRetryDelay = () => new Promise((resolve) => window.setTimeout(resolve, 500));

async function loadResolved(roundId) {
  // Read the exact Round PDA first. The chain owns the winner; Supabase is a
  // rebuildable history/read model and must never be a prerequisite for the
  // five-second reveal or latest-result pointer.
  const targetId = BigInt(roundId);
  if (targetId > state.roundId) return;
  const key = targetId.toString();
  if (resolvedLoaders.has(key)) return resolvedLoaders.get(key);
  const request = (async () => {
    const publishDirect = async () => {
      try {
        const directRound = await readRound(targetId);
        if (!publishResolvedRound(targetId, directRound)) return false;
        emit();
        if (state.account) void refreshMiner();
        return true;
      } catch {
        // A skipped/unopened id has no PDA; preserve the last verified result.
        return false;
      }
    };
    // The chain owns the result and gets the first attempt.
    if (await publishDirect()) return;

    // Read the durable projection once, so a fresh page can restore a result
    // even after rent cleanup. It never gates the live direct-account reveal.
    try {
      const [indexedLatest, indexedPlayed] = await Promise.all([
        loadLatestSettledRound(targetId),
        loadLatestPlayedSettledRound(targetId),
      ]);
      let changed = false;
      for (const candidate of [indexedLatest, indexedPlayed]) {
        if (!candidate) continue;
        changed = publishResolvedRound(candidate.roundId, candidate) || changed;
      }
      if (changed) emit();
    } catch (error) {
      console.warn('indexed resolved-round fallback failed', error);
    }

    // Settlement normally confirms inside the five-second result period. Burst
    // only the exact PDA while accountSubscribe remains the primary path.
    for (let attempt = 1; attempt < 10; attempt += 1) {
      await resolvedRetryDelay();
      if (await publishDirect()) return;
    }
  })().finally(() => resolvedLoaders.delete(key));
  resolvedLoaders.set(key, request);
  return request;
}

// --- actions -------------------------------------------------------------------------

/** Wrap a write so every path reports the same way: pending → explorer link, or reason. */
async function runTx(pendingMessage, action, onDone) {
  try {
    notify(pendingMessage);
    const hash = await action();
    notify('Submitted — waiting for confirmation…');
    const receipt = await waitForTx(hash);
    if (receipt.status !== 'success') { notify('Transaction reverted'); return false; }
    notify(`Confirmed · ${explorerTx(hash).split('/').pop().slice(0, 10)}…`);
    await onDone?.();
    return true; // callers may chain a second tx only if this one landed
  } catch (error) {
    notify(readableError(error));
    return false;
  }
}

/**
 * The connect picker, supplied by the UI layer via `setWalletChooser`.
 *
 * Kept as an injected callback for the same reason the social layer takes a host adapter:
 * this module talks to chains, not to the DOM. Given the discovered wallets and the connect
 * callback, it starts the selected wallet connection inside the trusted picker click and
 * resolves when that connection finishes (or null if the user backed out).
 */
let walletChooser = null;
export const setWalletChooser = (fn) => { walletChooser = fn; };

/**
 * Connect, asking WHICH wallet first.
 *
 * Discovery remains multi-wallet so Phantom, Solflare and Backpack users can explicitly choose
 * the account provider they want to use.
 *
 * `rdns` short-circuits the picker for callers that already know the wallet (a retry, say).
 * With no chooser registered this falls back to the previous auto-pick, so nothing that
 * imports this module in isolation breaks.
 */
export async function connectWallet(rdns) {
  try {
    if (rdns) return void await connect(rdns);
    if (!walletChooser) {
      if (!hasInjectedWallet()) return notify('No Solana wallet found — install Phantom, Solflare, or Backpack');
      return void await connect();
    }
    // Discover BEFORE the picker opens so the sheet renders its final list at once rather
    // than growing an entry at a time while the user is already reading it.
    const wallets = await discoverWallets();
    await walletChooser(wallets, getLastWalletRdns(), connect);
  } catch (error) {
    notify(readableError(error));
  }
}

export function disconnectWallet() {
  disconnect();
  notify('Wallet disconnected');
}

export { getAccount };
/** Net MYNE a claim would deliver, after whichever fee applies. Used by the REWARDS panel. */
export { netClaimable };
/** Passive MYNE accrued by won-but-unclaimed rounds. Also used by the REWARDS panel. */
export { passiveOnRounds };
// Re-exported so the UI layer reads the SAME chain-anchored clock as the round math,
// rather than reaching for Date.now() and quietly reintroducing device skew.
export { nowSeconds };

/**
 * Minimum aggregate wager per round. The per-tile amount is the ceiling of 0.05 / tile count,
 * in wei, so non-even splits (three tiles, for example) can never round one wei below the floor.
 */
export const MIN_ETH_PER_ROUND = Number(formatEther(MIN_ROUND_DEPLOYMENT));
export const effectiveEthPerTile = (entered, tileCount = 1) => {
  const n = Number(entered) || 0;
  if (n <= 0) return 0;
  const count = BigInt(Math.max(1, Number(tileCount) || 1));
  const minimumPerTileWei = (MIN_ROUND_DEPLOYMENT + count - 1n) / count;
  let enteredWei = 0n;
  try { enteredWei = parseEther(String(entered)); } catch { return Number(formatEther(minimumPerTileWei)); }
  return enteredWei * count < MIN_ROUND_DEPLOYMENT
    ? Number(formatEther(minimumPerTileWei))
    : n;
};

export async function mine({
  tiles, ethPerTile, auto = false, plays = 1, fundRounds = 1, autoClaim = false,
  rewardMode = 'accumulate', fundingMode = 'max', fixedFundingSol = '',
}) {
  if (!state.clockReady) return notify('Synchronizing with Solana — please try again in a moment');
  if (!getAccount()) return connectWallet();
  if (!tiles.length) return notify('Select at least one tile');
  if (!(ethPerTile > 0)) return notify('Enter an SOL amount');
  // Reapply the aggregate floor at the transaction boundary. UI previews are not authority, and
  // both manual bets and keeper-funded plans must sign the same minimum-safe amount.
  ethPerTile = effectiveEthPerTile(ethPerTile, tiles.length);

  // Auto-round doesn't bet directly — it prepays a plan the keeper executes each round, so
  // unlike a manual bet it can be set up while betting is closed (it starts next round).
  if (auto) {
    if (state.plan?.enabled) {
      const mode = state.plan.rewardMode === 'burn' ? 'Auto-burn' : 'Auto-mine';
      return notify(`${mode} is already active. Use the plan controls to top up or cancel it.`);
    }
    if ((state.plan?.balance ?? 0n) > 0n) {
      return notify('Withdraw the previous Auto-round balance before starting another plan');
    }
    return configureAutoPlan({
      tiles, ethPerTile, plays, fundRounds, autoClaim, rewardMode, fundingMode, fixedFundingSol,
    });
  }

  // The lottery rejects future round ids and rejects the current id after betting closes. A
  // finite one-play keeper plan is the safe on-chain queue: fund it now, execute next round.
  if (state.phase !== 'betting') {
    if (state.plan?.balance > 0n) {
      return notify('Withdraw or finish the existing Auto-round plan before queuing another bid');
    }
    return configureAutoPlan({
      tiles, ethPerTile, plays: 1, fundRounds: 1, autoClaim: false,
      fundingMode: 'rounds', queueOnly: true,
    });
  }

  const submittedRoundId = BigInt(state.roundId);
  const submittedAccount = getAccount();
  const submittedAmountPerTile = parseEther(String(ethPerTile));
  await runTx(
    `Deploying to ${tiles.length} tile${tiles.length === 1 ? '' : 's'}…`,
    () => placeBet({ roundId: submittedRoundId, tiles, ethPerTile, hasAccount: state.hasAccount }),
    async () => {
      // Solana has confirmed payment at this point. Lock the exact submitted
      // tiles immediately instead of waiting for a separate receipt RPC read,
      // which can briefly return the pre-transaction snapshot.
      if (state.roundId === submittedRoundId && state.account === submittedAccount) {
        rememberConfirmedTileBets({
          roundId: submittedRoundId,
          account: submittedAccount,
          tiles,
          amountPerTile: submittedAmountPerTile,
          baseAmounts: state.myBets,
        });
        state.myBets = mergeConfirmedTileBets(state.myBets, confirmedTileBets.amounts);
        emit();
      }
      await Promise.all([refreshRound(), refreshMiner()]);
    },
  );
}

/**
 * Set up an unlimited prepaid auto-round plan. Maximum funding derives an exact round count;
 * fixed funding preserves the user's exact SOL budget and may leave a withdrawable remainder.
 */
async function configureAutoPlan({
  tiles, ethPerTile, plays, fundRounds, autoClaim, rewardMode = 'accumulate',
  fundingMode = 'max', fixedFundingSol = '', queueOnly = false,
}) {
  const feeParams = await readFeeParams();
  const { accountDeposit, maxFee } = feeParams;
  const amountPerPlay = parseEther(String(ethPerTile)) * BigInt(tiles.length);
  const perRoundCost = amountPerPlay + maxFee;
  let deposit;
  if (fundingMode === 'fixed') {
    try { deposit = parseEther(String(fixedFundingSol)); }
    catch (error) { return notify(error.message); }
    if (deposit <= 0n) return notify('Enter the SOL amount you want to fund');
    if (deposit < perRoundCost) {
      return notify(`Fixed funding must cover at least one round (${formatEther(perRoundCost)} SOL incl. receipt rent)`);
    }
  } else {
    // Funding is independent of play count: an unlimited plan runs until its balance drains,
    // so Max and one-round queues prepay an exact number of full executions.
    deposit = requiredDeposit({
      amountPerPlay, fundRounds, maxFee, accountDeposit, needsAccount: !state.hasAccount,
    });
  }
  if (deposit < perRoundCost) {
    return notify(`This wallet cannot safely fund one Auto-round (${formatEther(perRoundCost)} SOL incl. receipt rent)`);
  }

  if (deposit > state.balance) {
    return notify(`Need ${formatEther(deposit)} SOL to fund this plan (incl. executor fees)`);
  }
  const setupReserve = autoPlanSetupReserve({
    hasMiner: state.hasAccount, hasPlan: Boolean(state.plan), feeParams,
  });
  const maximumFunding = maxAutoPlanFundingLamports(state.balance, setupReserve);
  if (deposit > maximumFunding) {
    return notify(`Auto-round can use at most ${formatEther(maximumFunding)} SOL (90% of your wallet balance)`);
  }

  await runTx(
    queueOnly
      ? 'Queuing bid for the next round…'
      : fundingMode === 'fixed'
        ? `Funding Auto-round with ${formatEther(deposit)} SOL…`
        : plays === UNLIMITED_PLAYS ? 'Setting up auto-round…' : `Setting up ${plays} auto rounds…`,
    () => configurePlan({ tiles, ethPerTile, autoClaim, deposit, rewardMode }),
    async () => { await Promise.all([refreshPlan(), refreshMiner()]); },
  );
}

/**
 * Add a user-selected SOL amount to a running plan. An unlimited plan keeps going as long as its
 * balance covers the next wager plus the executor-fee reserve, so topping up extends it without
 * creating or reconfiguring a second plan.
 */
export async function topUpPlan(amountSol) {
  if (!getAccount()) return connectWallet();
  if (!state.plan) return notify('No active plan');

  let value;
  try { value = parseEther(amountSol); } catch (error) { return notify(error.message); }
  if (value <= 0n) return notify('Enter the SOL amount you want to add');

  const { transactionFeeReserve } = await readFeeParams();
  if (value > state.balance) return notify(`Need ${formatEther(value)} SOL for this top-up`);
  const maximumFunding = maxAutoPlanFundingLamports(state.balance, transactionFeeReserve);
  if (value > maximumFunding) {
    return notify(`Auto-round top-ups can use at most ${formatEther(maximumFunding)} SOL (90% of your wallet balance)`);
  }

  await runTx(`Adding ${formatEther(value)} SOL to Auto-round…`, () => depositToPlan(value), async () => {
    await Promise.all([refreshPlan(), refreshMiner()]);
  });
}

export async function cancelAutoPlan() {
  if (!getAccount()) return connectWallet();
  await runTx('Cancelling auto-round…', cancelPlan, async () => {
    await Promise.all([refreshPlan(), refreshMiner()]);
  });
}

export async function claim(roundId) {
  return claimEthOnly([roundId]);
}

/**
 * Rounds processed per visible Claim-All work unit.
 *
 * Receipt processing has a fixed Solana compute/account cost. The low-level
 * client simulates and confirms groups of at most four receipt instructions;
 * this outer bound prevents a large backlog from becoming one unmanageable UI
 * action while still making deterministic progress on every confirmation.
 */
const CLAIM_CHUNK = 15;

const chunkRounds = (ids, size = CLAIM_CHUNK) =>
  Array.from({ length: Math.ceil(ids.length / size) }, (_, i) => ids.slice(i * size, i * size + size));

/**
 * Process one bounded round group at a time, stopping at the first failure.
 *
 * The low-level sender may use several four-receipt Solana transactions. Every
 * confirmed transaction is durable even if a later wallet prompt fails; the
 * final refresh discovers that exact progress and leaves remaining receipts
 * available for the next click.
 */
async function claimBatched(roundIds, send, verb) {
  const requestedRoundIds = [
    ...new Map(roundIds.map((roundId) => [BigInt(roundId).toString(), roundId])).values(),
  ];
  const batches = chunkRounds(requestedRoundIds);
  const processedRoundKeys = new Set();
  let interrupted = null;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const step = batches.length > 1 ? ` · batch ${i + 1} of ${batches.length}` : '';
    let outcome;
    try {
      notify(`${verb} ${batch.length} round${batch.length === 1 ? '' : 's'}…${step}`);
      outcome = await send(batch);
      if (outcome.signature) {
        // The shared sender confirms every inner transaction before returning.
        // A second status request here could fail after durable progress and
        // incorrectly turn confirmed chunks back into a zero-progress result.
        notify(`Confirmed · ${explorerTx(outcome.signature).split('/').pop().slice(0, 10)}…`);
      }
    } catch (error) {
      if (error?.code === NO_UNCLAIMED_RECEIPTS) {
        // The permissionless worker won the race after the panel refresh. The
        // reward is already in the durable wallet ledger, so this batch is
        // complete and the owner-signed withdrawal below must still proceed.
        notify('Rewards already processed — refreshing your claim balance…');
        outcome = { status: 'complete', processedRoundIds: batch };
      } else {
        notify(readableError(error));
        interrupted = { failure: error, reconciled: false, confirmedReceiptCount: 0 };
        break;
      }
    }

    for (const roundId of outcome.processedRoundIds ?? []) {
      processedRoundKeys.add(BigInt(roundId).toString());
    }
    if (outcome.status === 'complete') {
      if (outcome.failure) notify('Rewards already processed — refreshing your claim balance…');
      continue;
    }

    const processed = processedRoundKeys.size;
    const remaining = requestedRoundIds.length - processed;
    if (!outcome.reconciled) {
      const confirmed = Number(outcome.confirmedReceiptCount ?? 0);
      const knownProgress = processed > 0
        ? `At least ${processed} of ${requestedRoundIds.length} rounds processed`
        : null;
      const confirmedProgress = confirmed > 0
        ? `${confirmed} receipt${confirmed === 1 ? '' : 's'} confirmed in the interrupted batch`
        : null;
      notify(knownProgress || confirmedProgress
        ? `${[knownProgress, confirmedProgress].filter(Boolean).join(' · ')} · reward refresh failed, so other rounds were not assumed complete`
        : readableError(outcome.failure ?? outcome.reconciliationError));
    } else if (processed > 0) {
      notify(`Processed ${processed} of ${requestedRoundIds.length} rounds · ${remaining} remain · ${readableError(outcome.failure)}`);
    } else {
      notify(readableError(outcome.failure));
    }
    interrupted = outcome;
    break;
  }
  if (processedRoundKeys.size) await refreshMiner();
  return {
    processedRounds: processedRoundKeys.size,
    requestedRounds: requestedRoundIds.length,
    remainingRounds: requestedRoundIds.length - processedRoundKeys.size,
    complete: processedRoundKeys.size === requestedRoundIds.length,
    failure: interrupted?.failure ?? null,
    reconciliationError: interrupted?.reconciliationError ?? null,
    reconciled: interrupted?.reconciled ?? true,
    confirmedReceiptCount: Number(interrupted?.confirmedReceiptCount ?? 0),
  };
}

const noClaimProgress = () => ({
  processedRounds: 0,
  requestedRounds: 0,
  remainingRounds: 0,
  complete: true,
  failure: null,
  reconciliationError: null,
  reconciled: true,
  confirmedReceiptCount: 0,
});

const incompleteClaimMessage = (progress, completedPrefix = 'Claimed available rewards') => {
  const reason = readableError(progress.failure ?? progress.reconciliationError);
  if (!progress.reconciled && (progress.processedRounds > 0 || progress.confirmedReceiptCount > 0)) {
    const knownProgress = progress.processedRounds > 0
      ? `at least ${progress.processedRounds} of ${progress.requestedRounds} rounds processed`
      : null;
    const confirmedProgress = progress.confirmedReceiptCount > 0
      ? `${progress.confirmedReceiptCount} receipt${progress.confirmedReceiptCount === 1 ? '' : 's'} confirmed in the interrupted batch`
      : null;
    return `${completedPrefix} · ${[knownProgress, confirmedProgress].filter(Boolean).join(' · ')} · other rounds were not assumed complete`;
  }
  if (progress.processedRounds > 0) {
    return `${completedPrefix} · processed ${progress.processedRounds} of ${progress.requestedRounds} rounds · ${progress.remainingRounds} remain · ${reason}`;
  }
  return `Claim incomplete · ${progress.remainingRounds} round${progress.remainingRounds === 1 ? '' : 's'} remain · ${reason}`;
};

/** Claim every supplied round, batched so a large backlog still fits in a transaction. */
export async function claimMany(roundIds) {
  if (!getAccount()) return connectWallet();
  if (!roundIds.length) return noClaimProgress();
  return claimBatched(roundIds, claimManyRounds, 'Claiming');
}

/**
 * Process supplied rewards and withdraw accrued SOL, leaving MYNE unrefined.
 */
export async function claimEthOnly(roundIds) {
  if (!getAccount()) return connectWallet();
  const progress = roundIds.length
    ? await claimBatched(roundIds, claimManyEthOnly, 'Processing')
    : noClaimProgress();
  // A keeper may process a receipt between the pre-click refresh and this
  // transaction. Re-read the durable ledger even when no receipt instruction
  // landed locally, then withdraw only through the owner-signed claim path.
  await refreshMiner();
  if (state.claimableSol <= 0n) {
    if (roundIds.length && !progress.complete) return false;
    // The original v6 Mainnet receipt processor transfers SOL directly when
    // the owner signs claimReceipt. The later claim-vault release instead
    // leaves the same amount in StakePosition.pendingSol for a second,
    // owner-signed withdrawal. Support both deployed semantics without
    // pretending a successful direct claim failed just because no pending
    // ledger balance remains afterwards.
    if (progress.processedRounds > 0) {
      notify('Claimed SOL to your wallet');
      return true;
    }
    notify('No SOL available to claim');
    return false;
  }
  const withdrawn = await runTx('Claiming SOL…', withdrawClaimableSol, refreshMiner);
  if (withdrawn && !progress.complete) {
    notify(incompleteClaimMessage(progress, 'Claimed accrued SOL'));
  }
  return withdrawn;
}

export async function refine() {
  if (!getAccount()) return connectWallet();
  if (state.unclaimed === 0n) return notify('Nothing to refine');
  return runTx('Claiming MYNE…', withdrawUnrefined, refreshMiner);
}

async function freshRewardAccount(account) {
  const miner = await refreshMiner();
  if (getAccount() !== account || state.account !== account) {
    notify('Wallet changed — review the current rewards and try again');
    return null;
  }
  if (!miner) {
    notify('Could not verify this wallet’s reward accounts — please try again');
    return null;
  }
  return miner;
}

/** Settle every selected receipt, then complete the liquid MYNE claim with its 10% fee. */
export async function claimAll(roundIds) {
  const account = getAccount();
  if (!account) return connectWallet();
  const initialMiner = await freshRewardAccount(account);
  if (!initialMiner) return false;
  if (roundIds.length > 0 && (!initialMiner.hasAccount || !initialMiner.hasPosition)) {
    notify('This wallet has no complete mining reward account — no transaction was submitted');
    return false;
  }
  let handled = false;
  let allReceiptsProcessed = true;
  let claimProgress = noClaimProgress();
  if (roundIds.length > 0) {
    claimProgress = await claimMany(roundIds);
    allReceiptsProcessed = claimProgress.complete;
    handled = claimProgress.processedRounds > 0;
  }
  const miner = roundIds.length > 0 ? await freshRewardAccount(account) : initialMiner;
  if (!miner) return false;
  if (miner.claimableSol > 0n) {
    const withdrawn = await runTx('Claiming SOL…', withdrawClaimableSol, refreshMiner);
    if (!withdrawn) return false;
    handled = true;
  }
  if (miner.rewardsBullion > 0n) {
    const refined = await refine();
    if (refined && !allReceiptsProcessed) notify(incompleteClaimMessage(claimProgress));
    return refined && allReceiptsProcessed;
  }
  if (!allReceiptsProcessed) {
    notify(incompleteClaimMessage(claimProgress));
    return false;
  }
  if (handled) return true;
  notify('Nothing available to claim');
  return false;
}

/** Settle every selected receipt, then convert all accumulated MYNE into permanent 5x weight. */
export async function stakeAndBurnRewards(roundIds) {
  const account = getAccount();
  if (!account) return connectWallet();
  const initialMiner = await freshRewardAccount(account);
  if (!initialMiner) return false;
  if (!initialMiner.hasAccount || !initialMiner.hasPosition) {
    notify('This wallet has no complete mining reward account — no transaction was submitted');
    return false;
  }
  let allReceiptsProcessed = true;
  let claimProgress = noClaimProgress();
  if (roundIds.length > 0) {
    claimProgress = await claimMany(roundIds);
    allReceiptsProcessed = claimProgress.complete;
    if (!allReceiptsProcessed) {
      // Already-confirmed receipt accrual remains withdrawable/burnable. Do not
      // strand it merely because a later receipt or wallet prompt failed.
      notify('Processing available rewards · some receipts will remain for the next attempt');
    }
  }
  const miner = roundIds.length > 0 ? await freshRewardAccount(account) : initialMiner;
  if (!miner) return false;
  // Before receipt accrual, this action implicitly received SOL because the
  // receipt processor paid it directly. Preserve that product behavior while
  // requiring the owner signature explicitly under the claim-vault model.
  if (miner.claimableSol > 0n) {
    const withdrawn = await runTx('Claiming SOL…', withdrawClaimableSol, refreshMiner);
    if (!withdrawn) return false;
  }
  if (miner.rewardsBullion === 0n) {
    if (!allReceiptsProcessed) {
      notify(incompleteClaimMessage(claimProgress, 'Processed available rewards'));
      return false;
    }
    return notify('No MYNE available to stake and burn');
  }
  if (!miner.hasPosition) {
    notify('This wallet’s staking reward account is unavailable — no transaction was submitted');
    return false;
  }
  const burned = await runTx('Staking + burning MYNE…', burnUnclaimedMyne, refreshMiner);
  if (burned && !allReceiptsProcessed) {
    notify(incompleteClaimMessage(claimProgress, 'Staked + burned available MYNE'));
    return false;
  }
  return burned;
}

// --- boot ----------------------------------------------------------------------------

export function start() {
  if (!protocolReady) {
    state.roundId = roundState().roundId;
    onAccountChange((account) => { clearConfirmedTileBets(); state.account = account; emit(); });
    restoreConnection().catch(() => {});
    window.setInterval(tick, 1000);
    tick();
    return Promise.resolve(null);
  }
  // Anchor to the chain BEFORE the first roundId is derived. Ordering matters: computing it
  // from the raw device clock and correcting a moment later makes a skewed device paint the
  // wrong round, then jump — and any bet placed in that window carries the wrong id.
  const clockReady = (async () => {
    let attempt = 0;
    while (!state.clockReady) {
      try {
        const [skew] = await Promise.all([syncChainClock(), syncRoundGenesis()]);
        // Only worth reporting once it exceeds the sub-second measurement noise.
        if (skew !== null && Math.abs(skew) >= 1) {
          console.info(`[clock] device is ${skew > 0 ? 'behind' : 'ahead of'} chain by ${Math.abs(skew).toFixed(1)}s — corrected`);
        }
        state.clockReady = true;
        state.roundId = roundState().roundId;
        syncRoundRealtime(state.roundId);
        tick();
        if (live) refreshRound();
        // Read the previous verified result only after the chain-derived id is known.
        if (live && state.roundId > 0n) loadResolved(state.roundId - 1n);
        return true;
      } catch (error) {
        attempt += 1;
        console.warn('Solana clock/genesis synchronization failed; retrying', error);
        emit();
        const delay = Math.min(15_000, 1_000 * (2 ** Math.min(attempt - 1, 4)));
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
    }
    return true;
  })();

  startGlobalRealtime();

  onAccountChange((account) => {
    clearConfirmedTileBets();
    state.account = account;
    syncWalletRealtime(account);
    // Invalidate in-flight reads and remove the previous wallet's actionable
    // balances synchronously, before the replacement RPC read completes.
    minerRefreshId += 1;
    minerRefreshDirty = false;
    clearMinerState();
    void refreshMiner();
    refreshPlan();
    if (account && live && state.clockReady) refreshRound();
    emit();
  });

  restoreConnection().catch(() => {});
  verifyRoundTiming(ROUND_DURATION, BETTING_DURATION);
  verifyFeeEconomics(economics);
  // The premine copy is baked in at build time (see verifyPremine). Check it against the chain so a
  // stale build is loud rather than quietly telling users their MYNE is locked after launch.
  verifyPremine(isPremine);
  if (live) {
    refreshJackpot();
  }

  window.setInterval(tick, 1000);
  window.setInterval(() => {
    if (!live || document.hidden || !state.clockReady) return;
    void refreshRound();
    // The lifecycle keeper can settle a receipt between round-boundary reads.
    // Keep the account-specific reward ledger current on the same bounded poll
    // so an accrued receipt cannot leave either claimable balance stale.
    if (state.account) void refreshMiner();
  }, 5000);
  window.setInterval(() => { if (live && !document.hidden) void refreshJackpot(); }, 30000);
  // Re-anchor periodically: device clocks drift, and NTP corrections land as step changes.
  window.setInterval(() => { void syncChainClock(); }, 60000);
  // A laptop resuming from sleep can be seconds off the moment it wakes, which is exactly
  // when the user looks at the timer again.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void syncChainClock();
      if (live && state.clockReady) {
        void refreshRound();
        void refreshJackpot();
      }
    }
  });
  return clockReady;
}

export const format = {
  short, eth, ethSmart,
  // Public Solana-facing aliases used by the frontend view model. Keep the legacy keys as
  // compatibility adapters for existing chain clients while the UI migrates to SOL terminology.
  solIcon: eth,
  solSmart: ethSmart,
  formatClock, roundPhaseLabel, roundPresentation, ACCOUNT_DEPOSIT,
};
