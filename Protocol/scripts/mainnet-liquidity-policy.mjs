import assert from 'node:assert/strict';
import { getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

export const METEORA_DLMM_PROGRAM = new PublicKey(
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
);
export const WRAPPED_SOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112',
);

const LB_PAIR_DISCRIMINATOR = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);
const LB_PAIR_ACCOUNT_LEN = 904;
const OFFSETS = Object.freeze({
  activeId: 76,
  binStep: 80,
  status: 82,
  tokenXMint: 88,
  tokenYMint: 120,
  reserveX: 152,
  reserveY: 184,
});

function publicKeyAt(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32));
}

export function decodeMeteoraLbPair(data) {
  assert.equal(data.length, LB_PAIR_ACCOUNT_LEN, 'Meteora LbPair has an unsupported size');
  assert.ok(
    data.subarray(0, LB_PAIR_DISCRIMINATOR.length).equals(LB_PAIR_DISCRIMINATOR),
    'Meteora account is not an LbPair',
  );
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const activeId = view.getInt32(OFFSETS.activeId, true);
  const binStep = view.getUint16(OFFSETS.binStep, true);
  const status = data[OFFSETS.status];
  assert.ok(binStep > 0, 'Meteora LbPair bin step is invalid');
  assert.equal(status, 0, 'Meteora LbPair is not enabled');
  return {
    activeId,
    binStep,
    status,
    tokenXMint: publicKeyAt(data, OFFSETS.tokenXMint),
    tokenYMint: publicKeyAt(data, OFFSETS.tokenYMint),
    reserveX: publicKeyAt(data, OFFSETS.reserveX),
    reserveY: publicKeyAt(data, OFFSETS.reserveY),
  };
}

export async function inspectMeteoraPool(connection, pool, myneMint, commitment = 'finalized') {
  const poolAccount = await connection.getAccountInfo(pool, commitment);
  assert.ok(poolAccount && !poolAccount.executable, 'Meteora pool account is unavailable');
  assert.ok(poolAccount.owner.equals(METEORA_DLMM_PROGRAM), 'Pool is not owned by Meteora DLMM');
  const pair = decodeMeteoraLbPair(poolAccount.data);
  const myneIsX = pair.tokenXMint.equals(myneMint) && pair.tokenYMint.equals(WRAPPED_SOL_MINT);
  const myneIsY = pair.tokenYMint.equals(myneMint) && pair.tokenXMint.equals(WRAPPED_SOL_MINT);
  assert.ok(myneIsX || myneIsY, 'Meteora pool is not the exact MYNE/WSOL pair');

  const [reserveX, reserveY] = await Promise.all([
    getAccount(connection, pair.reserveX, commitment, TOKEN_PROGRAM_ID),
    getAccount(connection, pair.reserveY, commitment, TOKEN_PROGRAM_ID),
  ]);
  assert.ok(reserveX.mint.equals(pair.tokenXMint), 'Meteora Token X reserve mint differs');
  assert.ok(reserveY.mint.equals(pair.tokenYMint), 'Meteora Token Y reserve mint differs');

  return {
    ...pair,
    reserveXAmount: reserveX.amount,
    reserveYAmount: reserveY.amount,
    myneVault: myneIsX ? pair.reserveX : pair.reserveY,
    solVault: myneIsX ? pair.reserveY : pair.reserveX,
    myneAmount: myneIsX ? reserveX.amount : reserveY.amount,
    solAmount: myneIsX ? reserveY.amount : reserveX.amount,
  };
}

