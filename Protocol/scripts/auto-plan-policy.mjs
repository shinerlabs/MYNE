import assert from 'node:assert/strict';

export const BET_RECEIPT_ACCOUNT_BYTES = 468;
export const AUTO_PLAN_FUNDING_BPS = 9_000n;
export const BPS_DENOMINATOR = 10_000n;

const asBigInt = (value, label) => {
  let parsed;
  try {
    parsed = BigInt(value?.toString?.() ?? value);
  } catch {
    throw new Error(`${label} must be an integer`);
  }
  assert.ok(parsed >= 0n, `${label} cannot be negative`);
  return parsed;
};

/**
 * Maximum initial/follow-up Auto-round funding shown by clients.
 *
 * The 90% ceiling is a funding guard only. It must never be used to scale the
 * 25 amounts in an existing plan: execute_auto_plan moves the exact stored
 * per-round amount or does nothing.
 */
export function maxAutoPlanFundingLamports(walletBalanceLamports, feeReserveLamports = 0n) {
  const walletBalance = asBigInt(walletBalanceLamports, 'wallet balance');
  const feeReserve = asBigInt(feeReserveLamports, 'fee reserve');
  if (walletBalance <= feeReserve) return 0n;
  return ((walletBalance - feeReserve) * AUTO_PLAN_FUNDING_BPS) / BPS_DENOMINATOR;
}

/**
 * Mirror the keeper-relevant execute_auto_plan invariants without mutating a
 * plan. The program remains authoritative and re-checks every condition.
 */
export function evaluateAutoPlan({ plan, authority, roundId, receiptRentLamports }) {
  if (!plan) return { executable: false, reason: 'plan-account-missing' };
  if (!plan.authority?.equals?.(authority)) {
    return { executable: false, reason: 'authority-mismatch' };
  }
  if (!plan.active) return { executable: false, reason: 'inactive' };

  const perRoundLamports = (plan.amounts || []).reduce(
    (sum, amount) => sum + asBigInt(amount, 'plan amount'),
    0n,
  );
  if (perRoundLamports === 0n) {
    return { executable: false, reason: 'zero-per-round-amount', perRoundLamports };
  }

  const trackedBalanceLamports = asBigInt(plan.balanceLamports, 'plan balance');
  const receiptRent = asBigInt(receiptRentLamports, 'receipt rent');
  const requiredLamports = perRoundLamports + receiptRent;
  if (trackedBalanceLamports < requiredLamports) {
    return {
      executable: false,
      reason: 'insufficient-plan-balance',
      perRoundLamports,
      receiptRentLamports: receiptRent,
      requiredLamports,
      trackedBalanceLamports,
      shortfallLamports: requiredLamports - trackedBalanceLamports,
    };
  }

  const lastRound = asBigInt(plan.lastRound, 'last round');
  if (lastRound === asBigInt(roundId, 'round id')) {
    return {
      executable: false,
      reason: 'already-executed-this-round',
      perRoundLamports,
      requiredLamports,
      trackedBalanceLamports,
    };
  }

  return {
    executable: true,
    reason: 'ready',
    perRoundLamports,
    receiptRentLamports: receiptRent,
    requiredLamports,
    trackedBalanceLamports,
    nextNonce: asBigInt(plan.nextNonce, 'next nonce'),
  };
}

export function publicAutoPlanDiagnostic(authority, evaluation) {
  const diagnostic = {
    event: evaluation.executable ? 'auto-plan-ready' : 'auto-plan-skipped',
    authority: authority?.toBase58?.() ?? String(authority || ''),
    reason: evaluation.reason,
  };
  for (const key of [
    'perRoundLamports',
    'receiptRentLamports',
    'requiredLamports',
    'trackedBalanceLamports',
    'shortfallLamports',
    'nextNonce',
  ]) {
    if (evaluation[key] !== undefined) diagnostic[key] = evaluation[key].toString();
  }
  return diagnostic;
}
