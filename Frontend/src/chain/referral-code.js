import { PublicKey } from '@solana/web3.js';

// Ten Base58 characters keep social links compact while leaving roughly 58 bits of
// address-derived namespace. Five characters would collide at protocol scale and cannot safely
// identify a Solana account. The indexed mapping is constrained to this exact wallet suffix.
export const REFERRAL_CODE_LENGTH = 10;
export const DEFAULT_SOLANA_ADDRESS = PublicKey.default.toBase58();
const REFERRAL_CODE_PATTERN = new RegExp(`^[1-9A-HJ-NP-Za-km-z]{${REFERRAL_CODE_LENGTH}}$`);

export function canonicalSolanaAddress(value) {
  try {
    return new PublicKey(String(value ?? '').trim()).toBase58();
  } catch {
    return null;
  }
}

export function referralCodeFor(address) {
  const canonical = canonicalSolanaAddress(address);
  return canonical ? canonical.slice(-REFERRAL_CODE_LENGTH) : null;
}

export function isReferralCode(value) {
  return REFERRAL_CODE_PATTERN.test(String(value ?? '').trim());
}

export function referralLinkFor(base, address) {
  const code = referralCodeFor(address);
  return code ? `${base}?ref=${code}` : base;
}

export function compactReferralLink(base, address) {
  return referralLinkFor(base, address).replace(/^https?:\/\//, '');
}
