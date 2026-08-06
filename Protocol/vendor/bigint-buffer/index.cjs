'use strict';

function checkedBuffer(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError('Expected a Buffer');
  return value;
}

function checkedWidth(width) {
  if (!Number.isSafeInteger(width) || width < 0) throw new RangeError('Width must be a non-negative safe integer');
  return width;
}

function toBigIntBE(buffer) {
  const hex = checkedBuffer(buffer).toString('hex');
  return hex ? BigInt(`0x${hex}`) : 0n;
}

function toBigIntLE(buffer) {
  return toBigIntBE(Buffer.from(checkedBuffer(buffer)).reverse());
}

function encoded(value, width) {
  checkedWidth(width);
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError('Expected a non-negative bigint');
  const hex = value.toString(16);
  if (hex.length > width * 2) throw new RangeError('BigInt does not fit in the requested width');
  return Buffer.from(hex.padStart(width * 2, '0'), 'hex');
}

function toBufferBE(value, width) {
  return encoded(value, width);
}

function toBufferLE(value, width) {
  return encoded(value, width).reverse();
}

module.exports = { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE };
