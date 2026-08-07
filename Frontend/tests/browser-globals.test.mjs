import assert from 'node:assert/strict';
import test from 'node:test';

test('browser bootstrap installs Buffer before Solana transaction code runs', async () => {
  const existing = globalThis.Buffer;
  try {
    delete globalThis.Buffer;
    await import(`../src/browser-globals.js?test=${Date.now()}`);
    assert.equal(typeof globalThis.Buffer?.from, 'function');
    assert.equal(globalThis.Buffer.from('MYNE').toString('utf8'), 'MYNE');
  } finally {
    globalThis.Buffer = existing;
  }
});
