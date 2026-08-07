import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const productionServices = [
  '../scripts/switchboard-round-keeper.mjs',
  '../scripts/round-lifecycle-keeper.mjs',
  '../scripts/buyback-keeper.mjs',
  '../scripts/round-indexer.mjs',
];

test('production keepers do not scan every program-owned account', async () => {
  for (const relative of productionServices) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /getProgramAccounts\s*\(/, `${relative} performs getProgramAccounts`);
    assert.doesNotMatch(source, /\.all\s*\(\s*\)/, `${relative} performs an Anchor all-account scan`);
  }
});

test('frontend refuses its local receipt scan on Mainnet', async () => {
  const source = await readFile(
    new URL('../../Frontend/src/chain/lottery.js', import.meta.url),
    'utf8',
  );
  const mainnetGuard = source.indexOf("if (solanaNetwork.cluster === 'mainnet-beta')");
  const scan = source.indexOf('connection.getProgramAccounts');
  assert.ok(mainnetGuard >= 0 && scan > mainnetGuard, 'Mainnet must fail closed before local scan fallback');
});

test('compact referral links resolve through an exact index, never a suffix scan', async () => {
  const frontend = await readFile(
    new URL('../../Frontend/src/chain/referral.js', import.meta.url),
    'utf8',
  );
  const indexer = await readFile(new URL('../scripts/round-indexer.mjs', import.meta.url), 'utf8');
  assert.match(frontend, /from\('mine_referral_codes'\)/);
  assert.match(frontend, /\.eq\('code', raw\)/);
  assert.doesNotMatch(frontend, /\.like\(|\.ilike\(/);
  assert.match(indexer, /upsert\('mine_referral_codes'/);
});
