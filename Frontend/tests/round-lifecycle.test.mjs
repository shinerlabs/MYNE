import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRoundLifecycle } from '../src/chain/round-lifecycle.js';

test('a zero-wager row is not called no-bids before a result is published', () => {
  const lifecycle = classifyRoundLifecycle({
    resolved: false,
    totalReceipts: 0n,
    bettingEndsAt: 100n,
    settlesAt: 105n,
    refundAt: 200n,
  }, { nowSeconds: 110n });
  assert.equal(lifecycle.status, 'resolving');
  assert.equal(lifecycle.outcomePublished, false);
  assert.equal(lifecycle.participantCountsKnown, false);
});

test('a published result keeps participant counts unknown until its projection is exact', () => {
  const incomplete = classifyRoundLifecycle({
    resolved: true,
    projectionComplete: false,
    totalReceipts: 3n,
    processedReceipts: 1n,
  });
  assert.equal(incomplete.status, 'settled');
  assert.equal(incomplete.label, 'settled · indexing miners');
  assert.equal(incomplete.outcomePublished, true);
  assert.equal(incomplete.participantCountsKnown, false);

  const complete = classifyRoundLifecycle({
    resolved: true,
    projectionComplete: true,
    totalReceipts: 3n,
    processedReceipts: 3n,
    archiveVerified: true,
    closedSignature: 'close',
  });
  assert.equal(complete.participantCountsKnown, true);
  assert.equal(complete.stage, 'closed');
  assert.equal(complete.receiptsComplete, true);
});

test('unsettled recovery distinguishes refundable and fully refunded rounds', () => {
  const ready = classifyRoundLifecycle({
    resolved: false,
    totalReceipts: 2n,
    processedReceipts: 1n,
    refundAt: 150n,
  }, { nowSeconds: 151n });
  assert.equal(ready.status, 'refund-ready');

  const refunded = classifyRoundLifecycle({
    resolved: false,
    totalReceipts: 2n,
    processedReceipts: 2n,
    refundAt: 150n,
  }, { nowSeconds: 151n });
  assert.equal(refunded.status, 'refunded');

  const emptyClosed = classifyRoundLifecycle({
    resolved: false,
    totalReceipts: 0n,
    processedReceipts: 0n,
    refundAt: 150n,
    closedSignature: 'close',
  }, { nowSeconds: 151n });
  assert.equal(emptyClosed.status, 'refunded');
  assert.equal(emptyClosed.stage, 'closed');
});

test('the active phase is explicit and independent from index completeness', () => {
  assert.equal(classifyRoundLifecycle({}, {
    nowSeconds: 10n, isLive: true, phase: 'betting',
  }).status, 'live');
  assert.equal(classifyRoundLifecycle({}, {
    nowSeconds: 10n, isLive: true, phase: 'result',
  }).status, 'resolving');
});
