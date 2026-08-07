import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/chain/anchor-client.js', import.meta.url), 'utf8');

test('Anchor client normalizes CommonJS and ESM module shapes', async () => {
  assert.doesNotMatch(source, /import\s*\{[^}]*\}\s*from\s*['"]@anchor-lang\/core['"]/);
  assert.match(source, /const anchor = Reflect\.get\(anchorNamespace, 'default'\) \?\? anchorNamespace/);

  const client = await import('../src/chain/anchor-client.js');
  assert.equal(client.asBn(7).toString(), '7');
  assert.equal(typeof client.decodeProtocolAccount, 'function');
});
