import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/chain/anchor-client.js', import.meta.url), 'utf8');

test('shared transaction sender simulates a VersionedTransaction', () => {
  assert.match(source, /new VersionedTransaction\(simulationTransaction\.compileMessage\(\)\)/);
  assert.match(source, /simulateTransaction\(versionedSimulation,\s*\{/);
  assert.doesNotMatch(source, /simulateTransaction\(simulationTransaction,\s*\{/);
});
