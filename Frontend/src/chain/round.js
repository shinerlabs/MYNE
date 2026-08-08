import {
  genesisTime, ROUND_DURATION, BETTING_DURATION,
  RESOLUTION_COUNTDOWN_DURATION, WINNER_DISPLAY_DURATION,
} from './config.js';

/**
 * Rounds are fixed time-slots measured from GENESIS_TIME, so every timing question is
 * arithmetic — no RPC call, no polling. `currentRoundId` advances whether or not anyone
 * plays; empty rounds are no-ops that carry the pot forward.
 */
/**
 * Seconds between the CHAIN's clock and this device's, applied to every time question below.
 *
 * Round boundaries are decided by `block.timestamp`, but the browser only has `Date.now()` —
 * a number the user can set to anything and which phones routinely get wrong by tens of
 * seconds. Left uncorrected, two devices at the same instant compute different round ids,
 * because `roundIdAt` is pure arithmetic over a clock that is not shared. Measured: a device
 * 45s fast showed "Round #2208" while a correct one showed #2207, and this id is passed
 * straight into `bet(roundId, …)` — so a skewed clock does not merely mis-render a countdown,
 * it wagers into the wrong round.
 *
 * `syncChainClock` in client.js owns the measurement; this module stays pure arithmetic.
 *
 * Held as a FLOAT and added BEFORE the floor, which is not a detail — it is the difference
 * between devices agreeing and not. Flooring the device clock first and adding a whole-second
 * skew afterwards quantizes twice, and the two roundings compound: a device 45s fast rendered
 * a second ahead of a correct one and crossed the roll boundary a tick late, even though both
 * had measured their own offset correctly. Adding first means every device floors the SAME
 * absolute chain time, so they agree exactly whenever their estimates do.
 */
let chainSkew = 0;
export const setChainSkew = (seconds) => { chainSkew = seconds; };
export const getChainSkew = () => chainSkew;

export const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000 + chainSkew));

export const roundIdAt = (time = nowSeconds()) =>
  time < genesisTime ? 0n : (time - genesisTime) / ROUND_DURATION;

export const roundStart = (roundId) => genesisTime + roundId * ROUND_DURATION;
export const roundEnd = (roundId) => roundStart(roundId) + ROUND_DURATION;
export const bettingEnd = (roundId) => roundStart(roundId) + BETTING_DURATION;
export const winnerReveal = (roundId) => bettingEnd(roundId) + RESOLUTION_COUNTDOWN_DURATION;

/**
 * Everything the Mine page needs to render the clock, in one shot.
 * `phase` is betting for 60 seconds, then result for the final 5. Settlement becomes eligible
 * at the exact betting boundary, so there is deliberately no client-visible resolving phase.
 */
export function roundState(time = nowSeconds()) {
  const roundId = roundIdAt(time);
  const closes = bettingEnd(roundId);
  const reveals = winnerReveal(roundId);
  const ends = roundEnd(roundId);
  const betting = time < closes;
  const phase = betting ? 'betting' : 'result';
  const phaseEnd = betting ? closes : ends;

  return {
    roundId,
    phase,
    betting,
    secondsLeft: Number(phaseEnd - time),
    secondsToRoundEnd: Number(ends - time),
    bettingEnd: closes,
    winnerReveal: reveals,
    roundEnd: ends,
  };
}

export const roundPhaseLabel = (phase) => (phase === 'result' ? 'RESULT' : 'TIME LEFT');

/**
 * Convert the chain round state into the timer's visible state.
 *
 * A protocol pause stops every mining action, so continuing to present the wall-clock
 * countdown makes it look as though rounds are still running. Keep the underlying schedule
 * untouched for transaction safety, but replace the visible countdown with an explicit,
 * non-advancing maintenance state until the authoritative on-chain pause is lifted.
 */
export const roundCountdownView = ({ phase, secondsLeft, protocolPaused = false }) => {
  if (protocolPaused) {
    return {
      paused: true,
      phase: 'paused',
      betting: false,
      showingResult: false,
      label: 'STATUS',
      value: 'PAUSED',
    };
  }

  return {
    paused: false,
    phase,
    betting: phase === 'betting',
    showingResult: phase === 'result',
    label: roundPhaseLabel(phase),
    value: formatClock(secondsLeft),
  };
};

/**
 * Round number to freeze in the timer while mining is paused.
 *
 * Prefer an account read for the scheduled round, then the newest finalized
 * indexed Round PDA. A verified settlement is safer than the advancing
 * wall-clock id when either live source is temporarily unavailable.
 */
export const displayedPausedRoundId = ({
  currentRound = null, pausedRoundId = null, lastResolved = null, roundId = 0n,
}) => (currentRound?.requestedAt > 0n ? currentRound.id : null)
  ?? pausedRoundId
  ?? lastResolved?.roundId
  ?? roundId;

/**
 * Result presentation is deliberately split: the grid reveals the winning tile, while the
 * control-column takeover stays disabled. Full participant details move to the previous-round
 * miners panel after rollover.
 */
export const roundPresentation = (phase) => ({
  showWinningTile: phase === 'result',
  showResultTakeover: false,
});

/**
 * Select the verified round whose winner may be painted on the live grid.
 *
 * During normal operation an older winner must never cover a board that is
 * accepting bids, so only the resolved current round is visible in its result
 * window. A protocol pause is different: no bid can be accepted, and the
 * scheduled current Round PDA may not exist. Keep the newest resolved result
 * visible for transparency until mining resumes.
 */
export const displayedWinningRound = ({
  phase,
  protocolPaused = false,
  roundId = null,
  currentRound = null,
  lastResolved = null,
}) => {
  if (protocolPaused) {
    if (currentRound?.resolved) return currentRound;
    if (lastResolved?.resolved) return lastResolved;
    return null;
  }
  const isExactCurrentRound = currentRound?.resolved
    && roundId !== null
    && currentRound.id !== null
    && currentRound.id !== undefined
    && BigInt(currentRound.id) === BigInt(roundId);
  return roundPresentation(phase).showWinningTile && isExactCurrentRound ? currentRound : null;
};

if (BETTING_DURATION + RESOLUTION_COUNTDOWN_DURATION + WINNER_DISPLAY_DURATION !== ROUND_DURATION) {
  throw new Error('Frontend round phases do not add up to the configured round duration');
}

export const formatClock = (seconds) => {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};
