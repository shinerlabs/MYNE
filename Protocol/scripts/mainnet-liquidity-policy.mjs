import assert from 'node:assert/strict';
import { getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

export const METEORA_DLMM_PROGRAM = new PublicKey(
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
);
export const METEORA_DAMM_V2_PROGRAM = new PublicKey(
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
);
export const WRAPPED_SOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112',
);

const LB_PAIR_DISCRIMINATOR = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);
const LB_PAIR_ACCOUNT_LEN = 904;
const DAMM_V2_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const DAMM_V2_POOL_ACCOUNT_LEN = 1_112;
const DAMM_V2_TOKEN_VAULT_SEED = Buffer.from('token_vault');
const OFFSETS = Object.freeze({
  activeId: 76,
  binStep: 80,
  status: 82,
  activationType: 86,
  tokenXMint: 88,
  tokenYMint: 120,
  reserveX: 152,
  reserveY: 184,
  activationPoint: 816,
});
const DAMM_V2_OFFSETS = Object.freeze({
  tokenAMint: 168,
  tokenBMint: 200,
  tokenAVault: 232,
  tokenBVault: 264,
  activationPoint: 472,
  activationType: 480,
  status: 481,
  poolType: 485,
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
    activationType: data[OFFSETS.activationType],
    activationPoint: view.getBigUint64(OFFSETS.activationPoint, true),
    tokenXMint: publicKeyAt(data, OFFSETS.tokenXMint),
    tokenYMint: publicKeyAt(data, OFFSETS.tokenYMint),
    reserveX: publicKeyAt(data, OFFSETS.reserveX),
    reserveY: publicKeyAt(data, OFFSETS.reserveY),
  };
}

export function decodeMeteoraDammV2Pool(data) {
  assert.equal(data.length, DAMM_V2_POOL_ACCOUNT_LEN, 'Meteora DAMM v2 Pool has an unsupported size');
  assert.ok(
    data.subarray(0, DAMM_V2_POOL_DISCRIMINATOR.length).equals(DAMM_V2_POOL_DISCRIMINATOR),
    'Meteora account is not a DAMM v2 Pool',
  );
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const status = data[DAMM_V2_OFFSETS.status];
  const poolType = data[DAMM_V2_OFFSETS.poolType];
  const activationType = data[DAMM_V2_OFFSETS.activationType];
  assert.equal(status, 0, 'Meteora DAMM v2 Pool is not enabled');
  assert.ok(poolType === 0 || poolType === 1, 'Meteora DAMM v2 Pool type is unsupported');
  assert.ok(activationType === 0 || activationType === 1, 'Meteora DAMM v2 activation type is unsupported');
  return {
    status,
    poolType,
    activationType,
    activationPoint: view.getBigUint64(DAMM_V2_OFFSETS.activationPoint, true),
    tokenXMint: publicKeyAt(data, DAMM_V2_OFFSETS.tokenAMint),
    tokenYMint: publicKeyAt(data, DAMM_V2_OFFSETS.tokenBMint),
    reserveX: publicKeyAt(data, DAMM_V2_OFFSETS.tokenAVault),
    reserveY: publicKeyAt(data, DAMM_V2_OFFSETS.tokenBVault),
  };
}

function expectedReserve(poolProgram, pool, mint) {
  const seeds = poolProgram.equals(METEORA_DAMM_V2_PROGRAM)
    ? [DAMM_V2_TOKEN_VAULT_SEED, mint.toBuffer(), pool.toBuffer()]
    : [pool.toBuffer(), mint.toBuffer()];
  return PublicKey.findProgramAddressSync(seeds, poolProgram)[0];
}

export async function inspectMeteoraPool(connection, pool, myneMint, commitment = 'finalized') {
  const poolAccount = await connection.getAccountInfo(pool, commitment);
  assert.ok(poolAccount && !poolAccount.executable, 'Meteora pool account is unavailable');
  const poolProgram = poolAccount.owner;
  assert.ok(
    poolProgram.equals(METEORA_DLMM_PROGRAM) || poolProgram.equals(METEORA_DAMM_V2_PROGRAM),
    'Pool is not owned by a supported Meteora program',
  );
  const pair = poolProgram.equals(METEORA_DAMM_V2_PROGRAM)
    ? decodeMeteoraDammV2Pool(poolAccount.data)
    : decodeMeteoraLbPair(poolAccount.data);
  const myneIsX = pair.tokenXMint.equals(myneMint) && pair.tokenYMint.equals(WRAPPED_SOL_MINT);
  const myneIsY = pair.tokenYMint.equals(myneMint) && pair.tokenXMint.equals(WRAPPED_SOL_MINT);
  assert.ok(myneIsX || myneIsY, 'Meteora pool is not the exact MYNE/WSOL pair');

  const [reserveX, reserveY] = await Promise.all([
    getAccount(connection, pair.reserveX, commitment, TOKEN_PROGRAM_ID),
    getAccount(connection, pair.reserveY, commitment, TOKEN_PROGRAM_ID),
  ]);
  assert.ok(reserveX.mint.equals(pair.tokenXMint), 'Meteora Token X reserve mint differs');
  assert.ok(reserveY.mint.equals(pair.tokenYMint), 'Meteora Token Y reserve mint differs');
  assert.ok(
    pair.reserveX.equals(expectedReserve(poolProgram, pool, pair.tokenXMint)),
    'Meteora Token X reserve PDA differs',
  );
  assert.ok(
    pair.reserveY.equals(expectedReserve(poolProgram, pool, pair.tokenYMint)),
    'Meteora Token Y reserve PDA differs',
  );
  if (poolProgram.equals(METEORA_DAMM_V2_PROGRAM)) {
    const currentPoint = pair.activationType === 0
      ? BigInt(await connection.getSlot(commitment))
      : BigInt(await connection.getBlockTime(await connection.getSlot(commitment)) ?? 0);
    assert.ok(currentPoint >= pair.activationPoint, 'Meteora DAMM v2 Pool is not active yet');
  } else if (pair.activationPoint > 0n) {
    assert.ok(
      pair.activationType === 0 || pair.activationType === 1,
      'Meteora DLMM activation type is unsupported',
    );
    const currentSlot = await connection.getSlot(commitment);
    const currentPoint = pair.activationType === 0
      ? BigInt(currentSlot)
      : BigInt(await connection.getBlockTime(currentSlot) ?? 0);
    assert.ok(currentPoint >= pair.activationPoint, 'Meteora DLMM LbPair is not active yet');
  }

  return {
    ...pair,
    poolProgram,
    poolKind: poolProgram.equals(METEORA_DAMM_V2_PROGRAM) ? 'damm-v2' : 'dlmm',
    reserveXAmount: reserveX.amount,
    reserveYAmount: reserveY.amount,
    myneVault: myneIsX ? pair.reserveX : pair.reserveY,
    solVault: myneIsX ? pair.reserveY : pair.reserveX,
    myneAmount: myneIsX ? reserveX.amount : reserveY.amount,
    solAmount: myneIsX ? reserveY.amount : reserveX.amount,
  };
}
