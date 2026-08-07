import assert from 'node:assert/strict';
import test from 'node:test';

import { PublicKey } from '@solana/web3.js';

import {
  decodeMeteoraLbPair,
  decodeMeteoraPoolSnapshot,
  decodeTokenReserve,
  METEORA_LB_PAIR_ACCOUNT_LEN,
} from '../src/chain/swap.js';

const LB_PAIR_DISCRIMINATOR = Uint8Array.from([33, 11, 49, 98, 181, 101, 177, 13]);
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const key = (byte) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte));
const myneMint = key(2);
const myneVault = key(3);
const solVault = key(4);

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

function tokenAccount(mint, amount, { owner = TOKEN_PROGRAM, state = 1, length = 165 } = {}) {
  const data = new Uint8Array(length);
  if (length >= 32) writeKey(data, 0, mint);
  if (length >= 72) new DataView(data.buffer).setBigUint64(64, BigInt(amount), true);
  if (length > 108) data[108] = state;
  return { data, executable: false, owner };
}

const expected = (overrides = {}) => ({
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
