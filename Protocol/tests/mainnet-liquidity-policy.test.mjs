import assert from 'node:assert/strict';
import test from 'node:test';

import { PublicKey } from '@solana/web3.js';

import {
  decodeMeteoraDammV2Pool,
  decodeMeteoraLbPair,
} from '../scripts/mainnet-liquidity-policy.mjs';

const key = (byte) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte));
const writeKey = (data, offset, value) => data.set(value.toBytes(), offset);

test('Mainnet pool policy decodes the exact DLMM layout including activation', () => {
  const data = Buffer.alloc(904);
  data.set([33, 11, 49, 98, 181, 101, 177, 13], 0);
  data.writeInt32LE(-10, 76);
  data.writeUInt16LE(25, 80);
  data[82] = 0;
  data[86] = 1;
  writeKey(data, 88, key(1));
  writeKey(data, 120, key(2));
  writeKey(data, 152, key(3));
  writeKey(data, 184, key(4));
  data.writeBigUInt64LE(123n, 816);
  const state = decodeMeteoraLbPair(data);
  assert.equal(state.activeId, -10);
  assert.equal(state.activationType, 1);
  assert.equal(state.activationPoint, 123n);
  assert.ok(state.tokenXMint.equals(key(1)));
  assert.ok(state.reserveY.equals(key(4)));
});

test('Mainnet pool policy decodes only the pinned DAMM v2 Pool account', () => {
  const data = Buffer.alloc(1_112);
  data.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  writeKey(data, 168, key(1));
  writeKey(data, 200, key(2));
  writeKey(data, 232, key(3));
  writeKey(data, 264, key(4));
  data.writeBigUInt64LE(321n, 472);
  data[480] = 0;
  data[481] = 0;
  data[485] = 1;
  const state = decodeMeteoraDammV2Pool(data);
  assert.equal(state.activationPoint, 321n);
  assert.equal(state.poolType, 1);
  assert.ok(state.tokenYMint.equals(key(2)));
  assert.ok(state.reserveX.equals(key(3)));

  data[0] ^= 1;
  assert.throws(() => decodeMeteoraDammV2Pool(data), /not a DAMM v2 Pool/);
});

test('Mainnet pool policy rejects disabled or malformed pool accounts', () => {
  assert.throws(() => decodeMeteoraLbPair(Buffer.alloc(903)), /unsupported size/);
  const damm = Buffer.alloc(1_112);
  damm.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  damm[481] = 1;
  assert.throws(() => decodeMeteoraDammV2Pool(damm), /not enabled/);
});
