/**
 * Solana market boundary.
 *
 * MYNE launches through a manually-created Meteora MYNE/SOL pool. Browser trading remains
 * deliberately fail-closed until a reviewed quote/swap adapter is supplied. The read-only market
 * quote below is narrower: it accepts only the exact pool registered in the protocol's immutable
 * liquidity gate, decodes the live price directly from the on-chain Meteora LbPair, and checks both
 * registered reserves against the gate's minimum balances. No transaction depends on this quote.
 */

import { PublicKey } from '@solana/web3.js';

import { PROGRAMS } from '../app-config.js';
import { fetchProtocolAccount, protocolPdas } from './anchor-client.js';
import { connection } from './client.js';

const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const SPL_TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const LB_PAIR_DISCRIMINATOR = Uint8Array.from([33, 11, 49, 98, 181, 101, 177, 13]);
export const METEORA_LB_PAIR_ACCOUNT_LEN = 904;
const SPL_TOKEN_ACCOUNT_MIN_LEN = 165;
const OFFSETS = Object.freeze({
  pairType: 75,
  activeId: 76,
  binStep: 80,
  status: 82,
  activationType: 86,
  tokenXMint: 88,
  tokenYMint: 120,
  reserveX: 152,
  reserveY: 184,
});

export const poolAvailable = false;

const unavailable = () => {
  throw new Error('Trading opens after the canonical MYNE/SOL Meteora pool is configured.');
};

export async function readSwapState() { return unavailable(); }
export async function approveGld() { return unavailable(); }
export async function swapSolForGld() { return unavailable(); }
export async function swapGldForSol() { return unavailable(); }

export const quote = () => 0n;
export const spotMynePerSol = () => 0;
export const withSlippage = (amount, slippageBps = 100) => (
  BigInt(amount) * BigInt(10_000 - Number(slippageBps))
) / 10_000n;

const addressOf = (value, label = 'address') => {
  try { return new PublicKey(value).toBase58(); }
  catch { throw new Error(`Meteora ${label} is not a valid Solana address`); }
};

const bytesOf = (data, label) => {
  if (!(data instanceof Uint8Array)) throw new Error(`${label} data is unavailable`);
  return data;
};

const hasDiscriminator = (data) => data?.length >= LB_PAIR_DISCRIMINATOR.length
  && LB_PAIR_DISCRIMINATOR.every((byte, index) => data[index] === byte);

const publicKeyAt = (data, offset, label) => {
  try { return new PublicKey(data.subarray(offset, offset + 32)).toBase58(); }
  catch { throw new Error(`Meteora LbPair contains an invalid ${label}`); }
};

/**
 * Decode the stable prefix of Meteora's current 904-byte LbPair account.
 *
 * Meteora defines active-bin price per lamport as
 * `(1 + binStep / 10_000) ** activeId`, denominated as Token Y per Token X.
 * MYNE and WSOL both use nine decimals, so no decimal conversion is required.
 */
export function decodeMeteoraLbPair(data) {
  const bytes = bytesOf(data, 'Meteora LbPair');
  if (bytes.length !== METEORA_LB_PAIR_ACCOUNT_LEN) {
    throw new Error(`Meteora LbPair has unsupported length ${bytes.length}`);
  }
  if (!hasDiscriminator(bytes)) throw new Error('Meteora account is not an LbPair');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const activeId = view.getInt32(OFFSETS.activeId, true);
  const binStep = view.getUint16(OFFSETS.binStep, true);
  const status = bytes[OFFSETS.status];
  if (binStep === 0) throw new Error('Meteora LbPair bin step is invalid');
  // Meteora's official SDK maps enabled -> 0 and disabled -> 1.
  if (status !== 0) throw new Error('Meteora LbPair is not enabled');

  const tokenYPerTokenX = Math.pow(1 + binStep / 10_000, activeId);
  if (!Number.isFinite(tokenYPerTokenX) || tokenYPerTokenX <= 0) {
    throw new Error('Meteora LbPair active-bin price is outside the supported range');
  }

  return Object.freeze({
    activeId,
    binStep,
    status,
    pairType: bytes[OFFSETS.pairType],
    activationType: bytes[OFFSETS.activationType],
    tokenXMint: publicKeyAt(bytes, OFFSETS.tokenXMint, 'Token X mint'),
    tokenYMint: publicKeyAt(bytes, OFFSETS.tokenYMint, 'Token Y mint'),
    reserveX: publicKeyAt(bytes, OFFSETS.reserveX, 'Token X reserve'),
    reserveY: publicKeyAt(bytes, OFFSETS.reserveY, 'Token Y reserve'),
    tokenYPerTokenX,
  });
}

/** Decode an initialized SPL Token or Token-2022 account without pulling in the SPL SDK. */
export function decodeTokenReserve(accountInfo, expectedMint, label) {
  if (!accountInfo || accountInfo.executable) throw new Error(`${label} account is unavailable`);
  const owner = addressOf(accountInfo.owner, `${label} owner`);
  if (!SPL_TOKEN_PROGRAMS.has(owner)) throw new Error(`${label} is not owned by an SPL token program`);
  const data = bytesOf(accountInfo.data, label);
  if (data.length < SPL_TOKEN_ACCOUNT_MIN_LEN) throw new Error(`${label} token account is malformed`);
  const mint = publicKeyAt(data, 0, `${label} mint`);
  if (mint !== addressOf(expectedMint, `${label} expected mint`)) {
    throw new Error(`${label} mint does not match the registered pool`);
  }
  if (data[108] !== 1) throw new Error(`${label} token account is not initialized and usable`);
  const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
  return Object.freeze({ amount, mint, tokenProgram: owner });
}

const gateMinimum = (value, label) => {
  try {
    const minimum = BigInt(value?.toString());
    if (minimum <= 0n) throw new Error();
    return minimum;
  } catch {
    throw new Error(`Liquidity gate ${label} is invalid`);
  }
};

/**
 * Purely validate and orient one on-chain pool snapshot as MYNE per SOL.
 */
export function decodeMeteoraPoolSnapshot({ poolData, myneVaultInfo, solVaultInfo }, expected) {
  const pair = decodeMeteoraLbPair(poolData);
  const myneMint = addressOf(expected.myneMint, 'MYNE mint');
  const myneVault = addressOf(expected.myneVault, 'MYNE reserve');
  const solVault = addressOf(expected.solVault, 'WSOL reserve');
  const myneIsX = pair.tokenXMint === myneMint && pair.tokenYMint === WRAPPED_SOL_MINT;
  const myneIsY = pair.tokenYMint === myneMint && pair.tokenXMint === WRAPPED_SOL_MINT;
  if (!myneIsX && !myneIsY) throw new Error('Registered Meteora pool is not the MYNE/WSOL pair');

  if (myneIsX && (pair.reserveX !== myneVault || pair.reserveY !== solVault)) {
    throw new Error('Meteora pool reserves do not match the registered liquidity gate');
  }
  if (myneIsY && (pair.reserveY !== myneVault || pair.reserveX !== solVault)) {
    throw new Error('Meteora pool reserves do not match the registered liquidity gate');
  }

  const myneReserve = decodeTokenReserve(myneVaultInfo, myneMint, 'MYNE reserve');
  const solReserve = decodeTokenReserve(solVaultInfo, WRAPPED_SOL_MINT, 'WSOL reserve');
  const minMyne = gateMinimum(expected.minMyneBaseUnits, 'MYNE minimum');
  const minSol = gateMinimum(expected.minSolLamports, 'SOL minimum');
  if (myneReserve.amount < minMyne || solReserve.amount < minSol) {
    throw new Error('Meteora pool liquidity is below the registered minimum');
  }

  const mynePerSol = myneIsX ? 1 / pair.tokenYPerTokenX : pair.tokenYPerTokenX;
  if (!Number.isFinite(mynePerSol) || mynePerSol <= 0) {
    throw new Error('Meteora MYNE/SOL price is outside the supported range');
  }
  return Object.freeze({ mynePerSol, myneReserve: myneReserve.amount, solReserve: solReserve.amount, pair });
}

/**
 * Read the live price without enabling browser swaps.
 *
 * A missing/unverified gate is an expected pre-launch state and returns null. A configured but
 * malformed gate fails closed so financial metrics never silently use an unrelated market.
 */
export async function readMeteoraMynePerSol() {
  if (!protocolPdas.liquidityGate || !PROGRAMS.tokenMint) return null;
  const gate = await fetchProtocolAccount('LiquidityGate', protocolPdas.liquidityGate);
  if (!gate?.verified) return null;

  const pool = new PublicKey(gate.pool);
  if (!new PublicKey(gate.poolProgram).equals(METEORA_DLMM_PROGRAM)) {
    throw new Error('Liquidity gate is not bound to Meteora DLMM');
  }
  const myneVault = new PublicKey(gate.myneVault);
  const solVault = new PublicKey(gate.solVault);
  const [poolAccount, myneVaultInfo, solVaultInfo] = await connection.getMultipleAccountsInfo(
    [pool, myneVault, solVault],
    { commitment: 'confirmed' },
  );
  if (!poolAccount || poolAccount.executable || !poolAccount.owner.equals(METEORA_DLMM_PROGRAM)) {
    throw new Error('Registered liquidity pool is not a Meteora LbPair account');
  }
  return decodeMeteoraPoolSnapshot({ poolData: poolAccount.data, myneVaultInfo, solVaultInfo }, {
    myneMint: PROGRAMS.tokenMint,
    myneVault,
    solVault,
    minMyneBaseUnits: gate.minMyneBaseUnits,
    minSolLamports: gate.minSolLamports,
  }).mynePerSol;
}
