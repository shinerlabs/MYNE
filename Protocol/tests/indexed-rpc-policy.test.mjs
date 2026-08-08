import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const productionServices = [
  '../scripts/server-round-keeper.mjs',
  '../scripts/switchboard-round-keeper.mjs',
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

test('lifecycle permits one exact round-scoped receipt recovery scan', async () => {
  const [lifecycle, policy] = await Promise.all([
    readFile(new URL('../scripts/round-lifecycle-keeper.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/receipt-recovery-policy.mjs', import.meta.url), 'utf8'),
  ]);
  assert.equal((lifecycle.match(/getProgramAccounts\s*\(/g) || []).length, 1);
  assert.match(lifecycle, /getProgramAccounts\(PROGRAM_ID, scanOptions\)/);
  assert.match(policy, /commitment: 'confirmed'/);
  assert.match(policy, /\{ dataSize: BET_RECEIPT_ACCOUNT_SIZE \}/);
  assert.match(policy, /offset: BET_RECEIPT_ROUND_ID_OFFSET/);
  assert.match(policy, /expected <= maximum/);
  assert.doesNotMatch(lifecycle, /getProgramAccounts\s*\(\s*PROGRAM_ID\s*\)/);
  assert.doesNotMatch(lifecycle, /\.all\s*\(\s*\)/);
});

test('frontend permits only discriminator-sized, memcmp-filtered receipt scans on Mainnet', async () => {
  const source = await readFile(
    new URL('../../Frontend/src/chain/lottery.js', import.meta.url),
    'utf8',
  );
  const scanner = source.slice(
    source.indexOf('const scanReceipts ='),
    source.indexOf('async function decodedReceipts'),
  );
  const exactRoundPath = source.slice(
    source.indexOf('if (roundId !== null && !authority && expected !== null)'),
    source.indexOf('const indexed = await loadReceiptIndex'),
  );
  assert.match(scanner, /dataSize: BET_RECEIPT_ACCOUNT_SIZE/);
  assert.match(scanner, /roundId !== null.*memcmp: \{ offset: 9/);
  assert.match(scanner, /authority.*memcmp: \{ offset: 17/);
  assert.match(exactRoundPath, /scanReceipts\(\{ roundId \}\)/);
  assert.match(exactRoundPath, /decoded\.length === expected/);
  assert.match(source, /mainnet-beta' && roundId === null && !authority/);
  assert.match(source, /refusing a program-wide account scan/);
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
