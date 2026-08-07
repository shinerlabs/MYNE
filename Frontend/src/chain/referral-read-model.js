export const MAX_REFERRAL_PAGE_SIZE = 100;
export const MAX_REFERRAL_OFFSET = 10_000;

const exactUnits = (value) => BigInt(value ?? 0);

function safeCount(value, label) {
  const count = BigInt(value ?? 0);
  if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is outside the safe UI count range`);
  }
  return Number(count);
}

/** Clamp all public index reads so caller-controlled values cannot become unbounded queries. */
export function boundedReferralPage({ limit = 50, offset = 0 } = {}) {
  const requestedLimit = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 50;
  const requestedOffset = Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0;
  return {
    limit: Math.min(MAX_REFERRAL_PAGE_SIZE, Math.max(1, requestedLimit)),
    offset: Math.min(MAX_REFERRAL_OFFSET, Math.max(0, requestedOffset)),
  };
}

export function referralStatsFromRow(row) {
  return {
    lifetime: exactUnits(row?.earned_base_units),
    referrals: safeCount(row?.referrals, 'Referral count'),
    active: safeCount(row?.active, 'Active referral count'),
  };
}

export function referralNetworkFromRow(row) {
  return {
    addr: String(row.referred_wallet),
    active: Boolean(row.active),
    earned: exactUnits(row.earned_base_units),
  };
}

export function referralLeaderFromRow(row) {
  const stats = referralStatsFromRow(row);
  return {
    addr: String(row.wallet_address),
    referrals: stats.referrals,
    active: stats.active,
    lifetime: stats.lifetime,
  };
}
