const toBig = (value) => {
  try { return BigInt(value?.toString?.() ?? value ?? 0); } catch { return 0n; }
};

/**
 * Pure lifecycle classification for one indexed or direct-chain Round row.
 * Result publication, receipt processing, projection completeness and archival
 * are separate facts; collapsing them into `wager === 0 ? no-bids : resolving`
 * made stale rows look final when no result had actually been published.
 */
export function classifyRoundLifecycle(round, {
  nowSeconds = 0n,
  isLive = false,
  phase = null,
} = {}) {
  const now = toBig(nowSeconds);
  const totalReceipts = toBig(round?.totalReceipts);
  const processedReceipts = toBig(round?.processedReceipts);
  const bettingEndsAt = toBig(round?.bettingEndsAt);
  const settlesAt = toBig(round?.settlesAt);
  const refundAt = toBig(round?.refundAt);
  const projectionComplete = round?.projectionComplete === true;

  if (round?.resolved) {
    const storage = round?.closedSignature
      ? 'closed'
      : round?.archiveVerified ? 'archived' : 'open';
    return {
      status: 'settled',
      stage: storage,
      label: projectionComplete ? 'settled' : 'settled · indexing miners',
      outcomePublished: true,
      projectionComplete,
      participantCountsKnown: projectionComplete,
      receiptsComplete: processedReceipts >= totalReceipts,
      archiveVerified: Boolean(round?.archiveVerified),
    };
  }

  if (isLive) {
    const acceptingBids = phase === 'betting';
    return {
      status: acceptingBids ? 'live' : 'resolving',
      stage: acceptingBids ? 'betting' : 'result-window',
      label: acceptingBids ? 'live' : 'resolving',
      outcomePublished: false,
      projectionComplete,
      participantCountsKnown: false,
      receiptsComplete: totalReceipts === 0n,
      archiveVerified: false,
    };
  }

  if (processedReceipts >= totalReceipts && refundAt > 0n && now >= refundAt) {
    return {
      status: 'refunded', stage: round?.closedSignature ? 'closed' : 'refunded',
      label: 'refunded', outcomePublished: false, projectionComplete,
      participantCountsKnown: false, receiptsComplete: true,
      archiveVerified: Boolean(round?.archiveVerified),
    };
  }
  if (refundAt > 0n && now >= refundAt) {
    return {
      status: 'refund-ready', stage: 'refund-ready', label: 'refund available',
      outcomePublished: false, projectionComplete, participantCountsKnown: false,
      receiptsComplete: totalReceipts === 0n, archiveVerified: false,
    };
  }
  if ((settlesAt > 0n && now >= settlesAt) || (bettingEndsAt > 0n && now >= bettingEndsAt)) {
    return {
      status: 'resolving', stage: 'awaiting-settlement', label: 'resolving',
      outcomePublished: false, projectionComplete, participantCountsKnown: false,
      receiptsComplete: totalReceipts === 0n, archiveVerified: false,
    };
  }
  return {
    status: 'scheduled', stage: 'scheduled', label: 'scheduled',
    outcomePublished: false, projectionComplete, participantCountsKnown: false,
    receiptsComplete: totalReceipts === 0n, archiveVerified: false,
  };
}
