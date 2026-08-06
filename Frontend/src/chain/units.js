export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function parseSol(value) {
  const text = String(value ?? 0).trim();
  if (!/^\d*(\.\d*)?$/.test(text)) throw new Error('Enter a valid SOL amount');
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > 9) throw new Error('SOL supports up to 9 decimal places');
  return BigInt(whole || 0) * LAMPORTS_PER_SOL + BigInt((fraction + '000000000').slice(0, 9));
}

export function formatSol(lamports) {
  const value = BigInt(lamports || 0);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = (absolute % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// Compatibility names for the existing view model. These now use lamports, not wei.
export const parseEther = parseSol;
export const formatEther = formatSol;

