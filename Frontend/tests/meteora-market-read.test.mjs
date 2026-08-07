import assert from 'node:assert/strict';
import test from 'node:test';

import { PublicKey } from '@solana/web3.js';

import {
  decodeMeteoraDammV2Pool,
  decodeMeteoraLbPair,
  decodeMeteoraPoolSnapshot,
  decodeTokenReserve,
  METEORA_DAMM_V2_POOL_ACCOUNT_LEN,
  METEORA_LB_PAIR_ACCOUNT_LEN,
} from '../src/chain/swap.js';

const LB_PAIR_DISCRIMINATOR = Uint8Array.from([33, 11, 49, 98, 181, 101, 177, 13]);
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const DAMM_V2_PROGRAM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const key = (byte) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte));
const myneMint = key(2);
const poolAddress = key(5);
const dlmmVault = (mint) => PublicKey.findProgramAddressSync(
  [poolAddress.toBuffer(), mint.toBuffer()],
  DLMM_PROGRAM,
)[0];
const dammVault = (mint) => PublicKey.findProgramAddressSync(
  [Buffer.from('token_vault'), mint.toBuffer(), poolAddress.toBuffer()],
  DAMM_V2_PROGRAM,
)[0];
const myneVault = dlmmVault(myneMint);
const solVault = dlmmVault(WSOL);

const writeKey = (data, offset, value) => data.set(new PublicKey(value).toBytes(), offset);

function lbPair({
  activeId = 100,
  binStep = 25,
  status = 0,
  tokenXMint = myneMint,
  tokenYMint = WSOL,
  reserveX = myneVault,
  reserveY = solVault,
} = {}) {
  const data = new Uint8Array(METEORA_LB_PAIR_ACCOUNT_LEN);
  const view = new DataView(data.buffer);
  data.set(LB_PAIR_DISCRIMINATOR, 0);
  data[75] = 2;
  view.setInt32(76, activeId, true);
  view.setUint16(80, binStep, true);
  data[82] = status;
  data[86] = 1;
  writeKey(data, 88, tokenXMint);
  writeKey(data, 120, tokenYMint);
  writeKey(data, 152, reserveX);
  writeKey(data, 184, reserveY);
  return data;
}

function writeU128(data, offset, value) {
  const view = new DataView(data.buffer);
  const amount = BigInt(value);
  view.setBigUint64(offset, amount & ((1n << 64n) - 1n), true);
  view.setBigUint64(offset + 8, amount >> 64n, true);
}

function dammPool({
  sqrtPrice = 2n << 64n,
  status = 0,
  poolType = 0,
  activationType = 0,
  activationPoint = 0n,
  tokenXMint = myneMint,
  tokenYMint = WSOL,
  reserveX = dammVault(tokenXMint),
  reserveY = dammVault(tokenYMint),
} = {}) {
  const data = new Uint8Array(METEORA_DAMM_V2_POOL_ACCOUNT_LEN);
  const view = new DataView(data.buffer);
  data.set(Uint8Array.from([241, 154, 109, 4, 17, 177, 109, 188]), 0);
  writeKey(data, 168, tokenXMint);
  writeKey(data, 200, tokenYMint);
  writeKey(data, 232, reserveX);
  writeKey(data, 264, reserveY);
  writeU128(data, 456, sqrtPrice);
  view.setBigUint64(472, activationPoint, true);
  data[480] = activationType;
  data[481] = status;
  data[485] = poolType;
  return data;
}

function tokenAccount(mint, amount, { owner = TOKEN_PROGRAM, state = 1, length = 165 } = {}) {
  const data = new Uint8Array(length);
  if (length >= 32) writeKey(data, 0, mint);
  if (length >= 72) new DataView(data.buffer).setBigUint64(64, BigInt(amount), true);
  if (length > 108) data[108] = state;
  return { data, executable: false, owner };
}

const expected = (overrides = {}) => ({
  poolAddress,
  poolProgram: DLMM_PROGRAM,
  myneMint,
  myneVault,
  solVault,
  minMyneBaseUnits: 1_000n,
  minSolLamports: 500n,
  ...overrides,
});

const snapshot = (overrides = {}) => ({
  poolData: lbPair(),
  myneVaultInfo: tokenAccount(myneMint, 5_000n),
  solVaultInfo: tokenAccount(WSOL, 2_000n),
  ...overrides,
});

test('decodes the documented LbPair offsets and active-bin price', () => {
  const decoded = decodeMeteoraLbPair(lbPair({ activeId: -321, binStep: 17 }));
  assert.equal(decoded.activeId, -321);
  assert.equal(decoded.binStep, 17);
  assert.equal(decoded.status, 0);
  assert.equal(decoded.pairType, 2);
  assert.equal(decoded.activationType, 1);
  assert.equal(decoded.tokenXMint, myneMint.toBase58());
  assert.equal(decoded.tokenYMint, WSOL.toBase58());
  assert.equal(decoded.reserveX, myneVault.toBase58());
  assert.equal(decoded.reserveY, solVault.toBase58());
  assert.equal(decoded.tokenYPerTokenX, Math.pow(1 + 17 / 10_000, -321));
});

test('decodes the pinned DAMM v2 Pool layout and Q64.64 price', () => {
  const decoded = decodeMeteoraDammV2Pool(dammPool({
    sqrtPrice: 3n << 64n,
    poolType: 1,
    activationType: 1,
    activationPoint: 123n,
  }));
  assert.equal(decoded.tokenXMint, myneMint.toBase58());
  assert.equal(decoded.tokenYMint, WSOL.toBase58());
  assert.equal(decoded.reserveX, dammVault(myneMint).toBase58());
  assert.equal(decoded.reserveY, dammVault(WSOL).toBase58());
  assert.equal(decoded.tokenYPerTokenX, 9);
  assert.equal(decoded.poolType, 1);
  assert.equal(decoded.activationType, 1);
  assert.equal(decoded.activationPoint, 123n);
});

test('orients both DAMM v2 mint orders to the same MYNE-per-SOL quote', () => {
  const forwardMyneVault = dammVault(myneMint);
  const forwardSolVault = dammVault(WSOL);
  const forward = decodeMeteoraPoolSnapshot({
    poolData: dammPool(),
    myneVaultInfo: tokenAccount(myneMint, 5_000n),
    solVaultInfo: tokenAccount(WSOL, 2_000n),
  }, expected({
    poolProgram: DAMM_V2_PROGRAM,
    myneVault: forwardMyneVault,
    solVault: forwardSolVault,
  }));
  const reverse = decodeMeteoraPoolSnapshot({
    poolData: dammPool({
      sqrtPrice: 1n << 63n,
      tokenXMint: WSOL,
      tokenYMint: myneMint,
    }),
    myneVaultInfo: tokenAccount(myneMint, 5_000n),
    solVaultInfo: tokenAccount(WSOL, 2_000n),
  }, expected({
    poolProgram: DAMM_V2_PROGRAM,
    myneVault: forwardMyneVault,
    solVault: forwardSolVault,
  }));
  assert.equal(forward.mynePerSol, 0.25);
  assert.equal(reverse.mynePerSol, 0.25);
});

test('orients MYNE/WSOL and WSOL/MYNE pools to the same MYNE-per-SOL quote', () => {
  const forward = decodeMeteoraPoolSnapshot(snapshot(), expected());
  const reverse = decodeMeteoraPoolSnapshot(snapshot({
    poolData: lbPair({
      activeId: -100,
      tokenXMint: WSOL,
      tokenYMint: myneMint,
      reserveX: solVault,
      reserveY: myneVault,
    }),
  }), expected());
  assert.ok(Math.abs(forward.mynePerSol - reverse.mynePerSol) < 1e-12);
  assert.equal(forward.myneReserve, 5_000n);
  assert.equal(forward.solReserve, 2_000n);
});

test('rejects malformed lengths, the wrong discriminator, disabled pools and invalid price inputs', () => {
  assert.throws(() => decodeMeteoraLbPair(new Uint8Array(903)), /unsupported length/);
  assert.throws(() => decodeMeteoraLbPair(new Uint8Array(905)), /unsupported length/);

  const wrongDiscriminator = lbPair();
  wrongDiscriminator[0] ^= 0xff;
  assert.throws(() => decodeMeteoraLbPair(wrongDiscriminator), /not an LbPair/);
  assert.throws(() => decodeMeteoraLbPair(lbPair({ status: 1 })), /not enabled/);
  assert.throws(() => decodeMeteoraLbPair(lbPair({ binStep: 0 })), /bin step/);
  assert.throws(
    () => decodeMeteoraLbPair(lbPair({ activeId: 2_147_483_647, binStep: 65_535 })),
    /outside the supported range/,
  );
  assert.throws(() => decodeMeteoraDammV2Pool(new Uint8Array(1_111)), /unsupported length/);
  assert.throws(() => decodeMeteoraDammV2Pool(dammPool({ status: 1 })), /not enabled/);
  assert.throws(() => decodeMeteoraDammV2Pool(dammPool({ poolType: 2 })), /type is unsupported/);
  assert.throws(() => decodeMeteoraDammV2Pool(dammPool({ sqrtPrice: 0n })), /outside the supported range/);
});

test('rejects unrelated mints or a reserve key moved from its documented offset', () => {
  assert.throws(() => decodeMeteoraPoolSnapshot(snapshot({
    poolData: lbPair({ tokenXMint: key(9) }),
  }), expected()), /not the MYNE\/WSOL pair/);

  const movedReserve = lbPair();
  writeKey(movedReserve, 152, key(8));
  assert.throws(() => decodeMeteoraPoolSnapshot(snapshot({ poolData: movedReserve }), expected()), /reserves/);
});

test('decodes SPL reserve balances and rejects unusable reserve accounts', () => {
  assert.equal(decodeTokenReserve(tokenAccount(myneMint, 123n), myneMint, 'MYNE reserve').amount, 123n);
  assert.throws(
    () => decodeTokenReserve(tokenAccount(key(9), 123n), myneMint, 'MYNE reserve'),
    /mint does not match/,
  );
  assert.throws(
    () => decodeTokenReserve(tokenAccount(myneMint, 123n, { owner: key(8) }), myneMint, 'MYNE reserve'),
    /not owned by an SPL token program/,
  );
  assert.throws(
    () => decodeTokenReserve(tokenAccount(myneMint, 123n, { state: 2 }), myneMint, 'MYNE reserve'),
    /not initialized and usable/,
  );
  assert.throws(
    () => decodeTokenReserve(tokenAccount(myneMint, 0n, { length: 164 }), myneMint, 'MYNE reserve'),
    /malformed/,
  );
});

test('requires both live reserve balances to meet the immutable gate thresholds', () => {
  assert.throws(() => decodeMeteoraPoolSnapshot(snapshot({
    myneVaultInfo: tokenAccount(myneMint, 999n),
  }), expected()), /below the registered minimum/);
  assert.throws(() => decodeMeteoraPoolSnapshot(snapshot({
    solVaultInfo: tokenAccount(WSOL, 499n),
  }), expected()), /below the registered minimum/);
  assert.throws(
    () => decodeMeteoraPoolSnapshot(snapshot(), expected({ minSolLamports: 0n })),
    /SOL minimum is invalid/,
  );
});
