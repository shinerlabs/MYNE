import { formatEther, parseEther } from './units.js';

import {
  UNLIMITED_PLAYS, approveClaimDelegate, cancelPlan, configurePlan, depositToPlan,
  autoPlanSetupReserve, isClaimDelegate, maxAutoPlanFundingLamports, readFeeParams, readPlan, requiredDeposit,
} from './autocommit.js';

export { UNLIMITED_PLAYS };

import { ACCOUNT_DEPOSIT, economics, explorerTx, MIN_ROUND_DEPLOYMENT, protocolReady } from './config.js';
import {
  connect, disconnect, discoverWallets, getAccount, getLastWalletRdns, hasInjectedWallet,
  onAccountChange, readableError, restoreConnection, syncChainClock,
} from './client.js';
import {
  claimRound, claimManyRounds, placeBet, readJackpot, readMiner, readMyBets, readRound, netClaimable, passiveOnRounds,
  verifyFeeEconomics, verifyPremine, verifyRoundTiming, waitForTx, withdrawUnrefined,
  burnUnclaimedMyne, claimManyEthOnly, syncRoundGenesis,
} from './lottery.js';
import { getProtocolConfig } from './anchor-client.js';
import {
  loadLatestIndexedRoundId, loadLatestPlayedSettledRoundId, loadLatestSettledRoundId,
} from './rounds-index.js';
import { ROUND_DURATION, BETTING_DURATION, isPremine } from './config.js';
import { formatClock, nowSeconds, roundPhaseLabel, roundPresentation, roundState } from './round.js';
import { claimStakingRewards as withdrawClaimableSol } from './staking.js';

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
  // Distinct miners per tile, straight from the chain. Public — populated with or without a
  // connected wallet, because the crowd on a tile informs where to deploy.
  squareMiners: Array(25).fill(0n),
  myBets: Array(25).fill(0n),
  totalWager: 0n,
  jackpot: { native: 0n, bullion: 0n },
  balance: 0n,
  bullionBalance: 0n,
  unclaimed: 0n,
  claimableSol: 0n,
  refinedAccrued: 0n,
  // Global redistribution accumulator. Needed to value the passive share of rounds that were won
  // but never claimed — those are not in `unclaimed`/`refinedAccrued` yet. See passiveOnRounds().
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
  plan: null, // MYNE auto-plan for the connected account (null = none configured)
  autoPlanMaxFee: null, // live rent for one BetReceipt; null means the RPC quote is unavailable
  autoPlanFundingReserve: 0n, // setup rent + configured fee budget excluded before applying 90%
  // Live maintenance status, refreshed with the round. `null` means the config
  // read has not completed; only an authoritative on-chain `true` disables Mine.
  protocolPaused: null,
  // Last Round PDA that actually existed when the authoritative pause was
  // observed. Unlike `roundId`, this does not advance with wall-clock time.
  pausedRoundId: null,
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
  if (!live || document.hidden) return;
  void syncChainClock();
  tick();
  void refreshRound();
  void refreshJackpot();
  if (state.account) void refreshMiner();
};

// --- polling -------------------------------------------------------------------------

/**
 * Tile totals only change when someone bets, so a 5s poll is plenty. The countdown is
 * arithmetic (see round.js) and ticks locally every second without any RPC traffic.
 */
let roundRefreshRequest = null;
async function refreshRound() {
  if (roundRefreshRequest) return roundRefreshRequest;
  roundRefreshRequest = (async () => {
  try {
    const { roundId } = state;
    // One Round PDA contains both tile totals and tile participant counts. Reading it once avoids
    // two duplicate getAccountInfo calls on every five-second refresh (and during the result poll).
    const [roundResult, configResult] = await Promise.allSettled([
      readRound(roundId),
      // A temporary config read failure must not hide public round data. Leave
      // the previous pause value intact and let the next five-second poll retry.
      getProtocolConfig(),
    ]);
    if (configResult.status === 'fulfilled') {
      state.protocolPaused = Boolean(configResult.value.paused);
      if (!state.protocolPaused) {
        state.pausedRoundId = null;
      } else if (roundResult.status === 'fulfilled' && roundResult.value.requestedAt > 0n) {
        state.pausedRoundId = roundResult.value.id ?? roundId;
      } else {
        const indexedRoundId = await loadLatestIndexedRoundId(roundId);
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
    const round = roundResult.value;
    state.squareTotals = round.tileLamports ?? Array(25).fill(0n);
    state.squareMiners = round.tileReceipts ?? Array(25).fill(0n);
    state.totalWager = round.totalWager;
    state.currentRound = round;
    // A current-round settlement drives the final five-second winner reveal through
    // `currentRound`. It must not replace the durable result pointers yet: those advance only
    // after the next round starts and separately track the latest result and latest played result.
    if (state.account) state.myBets = await readMyBets(roundId, state.account);
    emit();
  } catch (error) {
    console.warn('round refresh failed', error);
  }
  })().finally(() => { roundRefreshRequest = null; });
  return roundRefreshRequest;
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
    // Keep a DISABLED plan visible while it still holds a balance. An exhausted plan keeps
    // its unspent deposit until cancelPlan() refunds it, so hiding it here stranded the
    // user's SOL with no way to withdraw from the UI.
    state.plan = plan && (plan.enabled || plan.balance > 0n) ? plan : null;
    emit();
  } catch (error) {
    console.warn('plan refresh failed', error);
  }
}

let minerRefreshId = 0;

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
  const requestId = ++minerRefreshId;
  const requestedAccount = state.account;
  if (!requestedAccount) {
    clearMinerState();
    return emit();
  }
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
    state.refinedAccrued = miner.refinedAccrued; // dividends from other miners' refining fees
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
}

/**
 * Ticks every second. When the slot number rolls over, the previous round has closed —
 * fetch its result so the UI can show the winning tile.
 */
let lastRevealPoll = 0;
function tick() {
  const next = roundState();
  const rolled = next.roundId !== state.roundId;

  state.phase = next.phase;
  state.secondsLeft = next.secondsLeft;

  if (rolled) {
    state.roundId = next.roundId;
    // Use the new chain round as the anchor. If the tab was backgrounded, `state.roundId` may
    // be multiple rounds behind and is not necessarily the previous round anymore.
    const previous = next.roundId > 0n ? next.roundId - 1n : null;
    state.squareTotals = Array(25).fill(0n);
    state.squareMiners = Array(25).fill(0n);
    state.myBets = Array(25).fill(0n);
    state.totalWager = 0n;
    state.currentRound = null; // fresh round: not resolved, no winner yet
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

/**
 * At rollover the previous round should already be settled. Retry briefly if RPC confirmation
 * lags so the result tile and latest-played miners card update from known-good records.
 */
async function loadResolved(roundId, attempt = 0) {
  // A suspended/background tab can skip several elapsed ids between ticks. Discard late
  // responses for an older current-round snapshot, then resolve the newest settled round at or
  // before this target. Zero-bid rounds are full results with a winning tile.
  if (state.roundId !== BigInt(roundId) + 1n) return;
  try {
    // Use the production index to locate the newest resolved round at or before
    // the elapsed id. It includes zero-bid rounds instead of skipping their
    // verifiable winning tiles.
    const [indexedRoundId, indexedPlayedRoundId] = await Promise.all([
      loadLatestSettledRoundId(roundId),
      loadLatestPlayedSettledRoundId(roundId),
    ]);
    const resolvedRoundId = indexedRoundId ?? roundId;
    const playedRoundId = indexedPlayedRoundId ?? resolvedRoundId;
    const [round, playedRound] = await Promise.all([
      readRound(resolvedRoundId),
      BigInt(playedRoundId) === BigInt(resolvedRoundId)
        ? Promise.resolve(null)
        : readRound(playedRoundId).catch(() => null),
    ]);
    if (round.resolved && state.roundId === BigInt(roundId) + 1n) {
      state.lastResolved = { roundId: BigInt(resolvedRoundId), ...round };
      const participantRound = playedRound?.resolved && playedRound.totalWager > 0n
        ? { roundId: BigInt(playedRoundId), ...playedRound }
        : round.totalWager > 0n
          ? state.lastResolved
          : null;
      if (participantRound) state.lastPlayedResolved = participantRound;
      emit();
      // Receipt settlement is permissionless and may land just after the round
      // result. Pull the miner ledger alongside the result so newly credited
      // MYNE is immediately available to Claim All / Stake + Burn.
      if (state.account) void refreshMiner();
      if (BigInt(resolvedRoundId) === BigInt(roundId)) return;
    }
  } catch (error) {
    console.warn('resolved round read failed', error);
  }
  // Settlement can land a few hundred milliseconds after the round rolls over. Retry quickly so
  // a fresh page load or RPC race never leaves the previous-miners panel blank for a full poll
  // interval; once a roster is rendered, later failures leave that confirmed roster untouched.
  if (attempt < 24) window.setTimeout(() => loadResolved(roundId, attempt + 1), 500);
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
  rewardMode = 'accumulate',
}) {
  if (!getAccount()) return connectWallet();
  if (!tiles.length) return notify('Select at least one tile');
  if (!(ethPerTile > 0)) return notify('Enter an SOL amount');
  // Reapply the aggregate floor at the transaction boundary. UI previews are not authority, and
  // both manual bets and keeper-funded plans must sign the same minimum-safe amount.
  ethPerTile = effectiveEthPerTile(ethPerTile, tiles.length);

  // Auto-round doesn't bet directly — it prepays a plan the keeper executes each round, so
  // unlike a manual bet it can be set up while betting is closed (it starts next round).
  if (auto) return configureAutoPlan({ tiles, ethPerTile, plays, fundRounds, autoClaim, rewardMode });

  // The lottery rejects future round ids and rejects the current id after betting closes. A
  // finite one-play keeper plan is the safe on-chain queue: fund it now, execute next round.
  if (state.phase !== 'betting') {
    if (state.plan?.balance > 0n) {
      return notify('Withdraw or finish the existing Auto-round plan before queuing another bid');
    }
    return configureAutoPlan({
      tiles, ethPerTile, plays: 1, fundRounds: 1, autoClaim: false, queueOnly: true,
    });
  }

  await runTx(
    `Deploying to ${tiles.length} tile${tiles.length === 1 ? '' : 's'}…`,
    () => placeBet({ roundId: state.roundId, tiles, ethPerTile, hasAccount: state.hasAccount }),
    async () => { await Promise.all([refreshRound(), refreshMiner()]); },
  );
}

/**
 * Set up an auto-round plan. `autoClaim` forces unlimited plays in the contract, so callers
 * must reconcile that beforehand rather than promising "N rounds with auto-claim".
 */
async function configureAutoPlan({ tiles, ethPerTile, plays, fundRounds, autoClaim, rewardMode = 'accumulate', queueOnly = false }) {
  const unlimited = autoClaim || plays === UNLIMITED_PLAYS;
  const effectivePlays = unlimited ? UNLIMITED_PLAYS : plays;

  const feeParams = await readFeeParams();
  const { accountDeposit, maxFee } = feeParams;
  const amountPerPlay = parseEther(String(ethPerTile)) * BigInt(tiles.length);
  // Funding is independent of play count: an unlimited plan runs until its balance drains,
  // so the user chooses how many rounds to prepay and can top up at any time.
  const deposit = requiredDeposit({
    amountPerPlay, fundRounds, maxFee, accountDeposit, needsAccount: !state.hasAccount,
  });

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

  // Auto-claim needs AutoCommit approved as a lottery delegate, otherwise the executor's
  // claims silently no-op. One-time, so only prompt when it isn't already granted.
  if (unlimited && autoClaim && !(await isClaimDelegate())) {
    const approved = await runTx(
      'Approving auto-claim (one-time)…',
      approveClaimDelegate,
    );
    if (approved === false) return; // user rejected — don't configure a plan that can't claim
  }

  await runTx(
    queueOnly
      ? 'Queuing bid for the next round…'
      : unlimited ? 'Setting up auto-round…' : `Setting up ${plays} auto rounds…`,
    () => configurePlan({ tiles, ethPerTile, plays: effectivePlays, autoClaim, deposit, rewardMode }),
    async () => { await Promise.all([refreshPlan(), refreshMiner()]); },
  );
}

/**
 * Add funds to a running plan. An unlimited plan keeps going as long as its balance covers
 * the next wager plus the executor-fee reserve, so topping up is how you extend it.
 */
export async function topUpPlan(rounds = 10) {
  if (!getAccount()) return connectWallet();
  if (!state.plan) return notify('No active plan');

  const { maxFee, transactionFeeReserve } = await readFeeParams();
  const value = state.plan.amountPerPlay * BigInt(rounds) + maxFee * BigInt(rounds);
  if (value > state.balance) return notify(`Need ${formatEther(value)} SOL to add ${rounds} rounds`);
  const maximumFunding = maxAutoPlanFundingLamports(state.balance, transactionFeeReserve);
  if (value > maximumFunding) {
    return notify(`Auto-round top-ups can use at most ${formatEther(maximumFunding)} SOL (90% of your wallet balance)`);
  }

  await runTx(`Adding ~${rounds} rounds…`, () => depositToPlan(value), async () => {
    await Promise.all([refreshPlan(), refreshMiner()]);
  });
}

/** Grant the delegate approval an existing auto-claim plan is missing. */
export async function approveAutoClaim() {
  if (!getAccount()) return connectWallet();
  await runTx('Approving auto-claim…', approveClaimDelegate, refreshPlan);
}

export async function cancelAutoPlan() {
  if (!getAccount()) return connectWallet();
  await runTx('Cancelling auto-round…', cancelPlan, async () => {
    await Promise.all([refreshPlan(), refreshMiner()]);
  });
}

export async function claim(roundId) {
  if (!getAccount()) return connectWallet();
  const processed = await runTx('Processing round rewards…', () => claimRound(roundId), refreshMiner);
  if (!processed || state.claimableSol <= 0n) return processed;
  return runTx('Claiming SOL…', withdrawClaimableSol, refreshMiner);
}

/**
 * Rounds settled per claim transaction.
 *
 * `claimMany` loops `_claimSimpleFor` once per round, and every iteration does its own SOL
 * transfer, bribe handling and `Claimed` event — the cost is linear in rounds, not amortised
 * across the batch. Measured single-round claims ran 111k–195k gas, so once the ~25k of
 * transaction overhead is excluded the marginal cost is up to ~170k per round. Fifteen rounds is
 * therefore ~2.6M gas, which is bounded and comfortably below anything this chain has rejected.
 *
 * Left unbounded, a miner who never claimed would eventually build a backlog whose batch cannot
 * fit in a block at all — and because the panel lists every unclaimed win across all history, that
 * backlog only ever grows. The cap is what stops the Claim button from becoming permanently
 * un-pressable for exactly the users who have won the most.
 *
 * Anyone with 15 or fewer claimable rounds still signs exactly once, as before.
 */
const CLAIM_CHUNK = 15;

const chunkRounds = (ids, size = CLAIM_CHUNK) =>
  Array.from({ length: Math.ceil(ids.length / size) }, (_, i) => ids.slice(i * size, i * size + size));

/**
 * Send one claim transaction per batch, stopping at the first failure.
 *
 * Each round is settled independently on-chain, so batches that already confirmed stay claimed —
 * a failure partway through is real progress, not a rollback. Returns how many rounds actually
 * landed so the caller can say so rather than implying the whole set succeeded.
 */
async function claimBatched(roundIds, send, verb) {
  const batches = chunkRounds(roundIds);
  let claimed = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const step = batches.length > 1 ? ` · batch ${i + 1} of ${batches.length}` : '';
    const ok = await runTx(
      `${verb} ${batch.length} round${batch.length === 1 ? '' : 's'}…${step}`,
      () => send(batch),
      null, // refresh once at the end instead of after every batch
    );
    if (!ok) break;
    claimed += batch.length;
  }
  if (claimed) await refreshMiner();
  return claimed;
}

/** Claim every supplied round, batched so a large backlog still fits in a transaction. */
export async function claimMany(roundIds) {
  if (!getAccount()) return connectWallet();
  if (!roundIds.length) return 0;
  const claimed = await claimBatched(roundIds, claimManyRounds, 'Claiming');
  if (claimed && claimed < roundIds.length) {
    notify(`Claimed ${claimed} of ${roundIds.length} rounds — press Claim again for the rest`);
  }
  return claimed;
}

/**
 * Claim the SOL from every supplied round, leaving the MYNE unrefined.
 *
 * The contract batches this natively (claimManyAdvanced), so this is ordinary runTx work — no
 * wallet-capability probing. The only loop is the gas-bounded batching above, which costs a
 * signature per 15 rounds instead of the one-per-round it replaced.
 */
export async function claimEthOnly(roundIds) {
  if (!getAccount()) return connectWallet();
  const processed = roundIds.length
    ? await claimBatched(roundIds, claimManyEthOnly, 'Processing')
    : 0;
  // A keeper may process a receipt between the pre-click refresh and this
  // transaction. Re-read the durable ledger even when no receipt instruction
  // landed locally, then withdraw only through the owner-signed claim path.
  await refreshMiner();
  if (state.claimableSol <= 0n) {
    if (roundIds.length && processed !== roundIds.length) return false;
    // The original v6 Mainnet receipt processor transfers SOL directly when
    // the owner signs claimReceipt. The later claim-vault release instead
    // leaves the same amount in StakePosition.pendingSol for a second,
    // owner-signed withdrawal. Support both deployed semantics without
    // pretending a successful direct claim failed just because no pending
    // ledger balance remains afterwards.
    if (processed > 0) {
      notify('Claimed SOL to your wallet');
      return true;
    }
    notify('No SOL available to claim');
    return false;
  }
  const withdrawn = await runTx('Claiming SOL…', withdrawClaimableSol, refreshMiner);
  if (withdrawn && processed < roundIds.length) {
    notify(`Claimed accrued SOL · ${roundIds.length - processed} round${roundIds.length - processed === 1 ? '' : 's'} still processing`);
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
  if (roundIds.length > 0) {
    const claimed = await claimMany(roundIds);
    // Do not present a partial receipt settlement as "Claim All". Already-confirmed batches remain
    // safe and claimable MYNE stays in the miner account; the user can retry the remaining batch.
    if (claimed !== roundIds.length) return false;
    handled = true;
  }
  const miner = roundIds.length > 0 ? await freshRewardAccount(account) : initialMiner;
  if (!miner) return false;
  if (miner.claimableSol > 0n) {
    const withdrawn = await runTx('Claiming SOL…', withdrawClaimableSol, refreshMiner);
    if (!withdrawn) return false;
    handled = true;
  }
  if (miner.rewardsBullion > 0n) return refine();
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
  if (roundIds.length > 0) {
    const claimed = await claimMany(roundIds);
    if (claimed !== roundIds.length) return false;
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
  if (miner.rewardsBullion === 0n) return notify('No MYNE available to stake and burn');
  if (!miner.hasPosition) {
    notify('This wallet’s staking reward account is unavailable — no transaction was submitted');
    return false;
  }
  return runTx('Staking + burning MYNE…', burnUnclaimedMyne, refreshMiner);
}

// --- boot ----------------------------------------------------------------------------

export function start() {
  if (!protocolReady) {
    state.roundId = roundState().roundId;
    onAccountChange((account) => { state.account = account; emit(); });
    restoreConnection().catch(() => {});
    window.setInterval(tick, 1000);
    tick();
    return Promise.resolve(null);
  }
  // Anchor to the chain BEFORE the first roundId is derived. Ordering matters: computing it
  // from the raw device clock and correcting a moment later makes a skewed device paint the
  // wrong round, then jump — and any bet placed in that window carries the wrong id.
  const clockReady = Promise.all([syncChainClock(), syncRoundGenesis()]).then(([skew]) => {
    // Only worth reporting once it exceeds the sub-second measurement noise.
    if (skew !== null && Math.abs(skew) >= 1) {
      console.info(`[clock] device is ${skew > 0 ? 'behind' : 'ahead of'} chain by ${Math.abs(skew).toFixed(1)}s — corrected`);
    }
    state.roundId = roundState().roundId;
    tick();
    if (live) refreshRound();
    // refreshRound() only sets `lastResolved` if the CURRENT round is already resolved, which is
    // true only inside its reveal window — so on a fresh load the "Last round" row had nothing to
    // render for ~3s and sat on its placeholder. Read the previous round explicitly. Deliberately
    // inside clockReady: a skewed device's uncorrected id can be off by one, and seeding the wrong
    // round is worse than seeding a moment later.
    if (live && state.roundId > 0n) loadResolved(state.roundId - 1n);
  }).catch(() => {});

  state.roundId = roundState().roundId;

  onAccountChange((account) => {
    state.account = account;
    // Invalidate in-flight reads and remove the previous wallet's actionable
    // balances synchronously, before the replacement RPC read completes.
    minerRefreshId += 1;
    clearMinerState();
    void refreshMiner();
    refreshPlan();
    if (account && live) refreshRound();
    emit();
  });

  restoreConnection().catch(() => {});
  verifyRoundTiming(ROUND_DURATION, BETTING_DURATION);
  verifyFeeEconomics(economics);
  // The premine copy is baked in at build time (see verifyPremine). Check it against the chain so a
  // stale build is loud rather than quietly telling users their MYNE is locked after launch.
  verifyPremine(isPremine);
  if (live) {
    refreshRound();
    refreshJackpot();
  }

  window.setInterval(tick, 1000);
  window.setInterval(() => {
    if (!live || document.hidden) return;
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
      if (live) {
        void refreshRound();
        void refreshJackpot();
      }
    }
  });
  tick();
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
