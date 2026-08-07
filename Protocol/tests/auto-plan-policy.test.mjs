import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  evaluateAutoPlan,
  maxAutoPlanFundingLamports,
  publicAutoPlanDiagnostic,
} from '../scripts/auto-plan-policy.mjs';

const authority = Keypair.generate().publicKey;
const plan = (overrides = {}) => ({
  authority,
  active: true,
  amounts: [20n, 30n, ...Array(23).fill(0n)],
  balanceLamports: 150n,
  lastRound: 4n,
  nextNonce: 9n,
  ...overrides,
});

test('Auto-round funding is capped at 90% after the fee reserve', () => {
  assert.equal(maxAutoPlanFundingLamports(1_000n), 900n);
  assert.equal(maxAutoPlanFundingLamports(1_000n, 100n), 810n);
  assert.equal(maxAutoPlanFundingLamports(100n, 100n), 0n);
  assert.equal(maxAutoPlanFundingLamports(90n, 100n), 0n);
});

test('Auto-round evaluation preserves the exact selected per-round amounts', () => {
  const evaluation = evaluateAutoPlan({
    plan: plan(),
    authority,
    roundId: 5n,
    receiptRentLamports: 100n,
  });
  assert.deepEqual(evaluation, {
    executable: true,
    reason: 'ready',
    perRoundLamports: 50n,
    receiptRentLamports: 100n,
    requiredLamports: 150n,
    trackedBalanceLamports: 150n,
    nextNonce: 9n,
  });
});

test('Auto-round skips are explicit and never downscale an underfunded plan', () => {
  const evaluation = evaluateAutoPlan({
    plan: plan({ balanceLamports: 149n }),
    authority,
    roundId: 5n,
    receiptRentLamports: 100n,
  });
  assert.equal(evaluation.executable, false);
  assert.equal(evaluation.reason, 'insufficient-plan-balance');
  assert.equal(evaluation.perRoundLamports, 50n);
  assert.equal(evaluation.requiredLamports, 150n);
  assert.equal(evaluation.shortfallLamports, 1n);
  assert.deepEqual(publicAutoPlanDiagnostic(authority, evaluation), {
    event: 'auto-plan-skipped',
    authority: authority.toBase58(),
    reason: 'insufficient-plan-balance',
    perRoundLamports: '50',
    receiptRentLamports: '100',
    requiredLamports: '150',
    trackedBalanceLamports: '149',
    shortfallLamports: '1',
  });
});

test('Auto-round rejects inactive, duplicate, zero-value and mismatched plans', () => {
  const evaluate = (candidate) => evaluateAutoPlan({
    plan: candidate,
    authority,
    roundId: 5n,
    receiptRentLamports: 100n,
  }).reason;
  assert.equal(evaluate(plan({ active: false })), 'inactive');
  assert.equal(evaluate(plan({ lastRound: 5n })), 'already-executed-this-round');
  assert.equal(evaluate(plan({ amounts: Array(25).fill(0n) })), 'zero-per-round-amount');
  assert.equal(evaluate(plan({ authority: Keypair.generate().publicKey })), 'authority-mismatch');
  assert.equal(evaluate(null), 'plan-account-missing');
});
