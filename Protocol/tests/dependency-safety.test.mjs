import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE } = require('../vendor/bigint-buffer/index.cjs');

test('bounds-safe bigint shim round-trips Solana integer widths', () => {
  const value = 0x0102030405060708n;
  assert.equal(toBigIntBE(toBufferBE(value, 8)), value);
  assert.equal(toBigIntLE(toBufferLE(value, 8)), value);
});

test('bounds-safe bigint shim rejects overflow and invalid input', () => {
  assert.throws(() => toBufferLE(256n, 1), /does not fit/);
  assert.throws(() => toBufferBE(-1n, 8), /non-negative bigint/);
  assert.throws(() => toBigIntLE(new Uint8Array([1])), /Expected a Buffer/);
});

test('production image retains the local shim targeted by pnpm links', async () => {
  const dockerfile = await readFile(new URL('../../Dockerfile.workers', import.meta.url), 'utf8');
  assert.match(
    dockerfile,
    /COPY --from=dependencies --chown=node:node \/app\/Protocol\/vendor \.\/vendor/,
  );
  assert.match(
    dockerfile,
    /COPY --from=dependencies --chown=node:node \/app\/Protocol\/node_modules \.\/node_modules/,
  );
});
