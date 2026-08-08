import assert from 'node:assert/strict';
import { normalizeAnchorEventData, normalizeAnchorEventName } from './anchor-event-data.mjs';
import { settlementConfirmedWithinResultWindow } from './round-schedule-policy.mjs';

const asRoundId = (value) => String(value?.toString?.() ?? value ?? '');

/**
 * Reconstruct the finalized settlement transaction for one exact Round PDA.
 *
 * This is the restart path for a keeper that finds `round.settled = true` but
 * did not survive long enough to report whether settlement landed inside the
 * winner interval. The Round PDA is touched by the canonical settlement, and
 * the decoded RoundSettled event binds the evidence to the exact round id.
 */
export async function findFinalizedRoundSettlementEvidence({
  connection,
  eventParser,
  roundAddress,
  roundId,
  rpcCall = (_label, operation) => operation(),
  maxPages = 4,
  pageSize = 1_000,
}) {
  const expectedRoundId = asRoundId(roundId);
  assert.match(expectedRoundId, /^\d+$/, 'Settlement evidence round id is invalid');
  assert.ok(connection && typeof connection.getSignaturesForAddress === 'function');
  assert.ok(connection && typeof connection.getTransaction === 'function');
  assert.ok(eventParser && typeof eventParser.parseLogs === 'function');
  assert.ok(roundAddress && typeof roundAddress.toBase58 === 'function');
  assert.ok(Number.isSafeInteger(maxPages) && maxPages >= 1 && maxPages <= 32);
  assert.ok(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 1_000);

  let before;
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await rpcCall(
      `Finalized round settlement signature page ${page + 1}`,
      () => connection.getSignaturesForAddress(roundAddress, {
        limit: pageSize,
        ...(before ? { before } : {}),
      }, 'finalized'),
    );
    assert.ok(Array.isArray(rows), 'Finalized round settlement signature response is invalid');
    assert.ok(rows.length <= pageSize, 'Finalized round settlement signature page is oversized');

    for (const row of rows) {
      if (!row || row.err != null || typeof row.signature !== 'string') continue;
      let transaction;
      try {
        transaction = await rpcCall(
          `Finalized round settlement transaction ${row.signature}`,
          () => connection.getTransaction(row.signature, {
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
          }),
        );
      } catch {
        // An unavailable unrelated transaction must not hide an older valid
        // settlement. If the unavailable row was the settlement, the bounded
        // scan returns no evidence and the caller fails closed.
        continue;
      }
      if (transaction?.meta?.err != null || !Array.isArray(transaction?.meta?.logMessages)) continue;
      let events;
      try {
        events = [...eventParser.parseLogs(transaction.meta.logMessages)];
      } catch {
        continue;
      }
      const exactSettlement = events.some((event) => {
        if (normalizeAnchorEventName(event.name) !== 'RoundSettled') return false;
        const data = normalizeAnchorEventData(event.data);
        return asRoundId(data.roundId) === expectedRoundId;
      });
      if (!exactSettlement) continue;
      assert.ok(
        Number.isSafeInteger(transaction.blockTime),
        `Finalized RoundSettled transaction ${row.signature} has no block time`,
      );
      return {
        roundId: expectedRoundId,
        signature: row.signature,
        slot: transaction.slot,
        blockTime: transaction.blockTime,
      };
    }

    if (rows.length < pageSize) return null;
    before = rows.at(-1)?.signature;
    assert.ok(before, 'Finalized round settlement pagination cursor is missing');
  }
  return null;
}

/** Missing evidence is deliberately classified as a missed deadline. */
export function classifyFinalizedRoundSettlementEvidence({
  evidence,
  roundId,
  resultDeadlineAt,
}) {
  const expectedRoundId = asRoundId(roundId);
  assert.match(expectedRoundId, /^\d+$/, 'Settlement evidence round id is invalid');
  assert.ok(Number.isSafeInteger(resultDeadlineAt), 'Settlement result deadline is invalid');
  if (!evidence) {
    return {
      deadlineMet: false,
      outcome: `finalized-settlement-evidence-unavailable;deadline-exclusive:${resultDeadlineAt}`,
    };
  }
  assert.equal(evidence.roundId, expectedRoundId, 'Settlement evidence belongs to another round');
  assert.ok(Number.isSafeInteger(evidence.blockTime), 'Settlement evidence block time is invalid');
  const deadlineMet = settlementConfirmedWithinResultWindow({
    confirmedAt: evidence.blockTime,
    resultDeadlineAt,
  });
  return {
    deadlineMet,
    outcome: deadlineMet
      ? evidence.signature
      : `confirmed-at:${evidence.blockTime};deadline-exclusive:${resultDeadlineAt};signature:${evidence.signature}`,
  };
}
