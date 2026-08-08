import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/chain/staking.js', import.meta.url), 'utf8');

test('staking SOL claim revalidates its canonical position before wallet signing', () => {
  const claim = source.slice(
    source.indexOf('export async function claimStakingRewards'),
    source.indexOf('export async function readStakingMetrics'),
  );
  assert.match(claim, /fetchProtocolAccount\('StakePosition', positionPda\(account\)\)/);
  assert.match(claim, /if \(!position\) throw new Error\('This wallet has no staking position'\)/);
  assert.match(claim, /if \(await livePending\(position, pool\) <= 0n\) throw new Error\('Nothing to claim'\)/);
  assert.ok(
    claim.indexOf("fetchProtocolAccount('StakePosition'") < claim.indexOf('getWritableProgram()'),
    'account checks must happen before the wallet-backed program is requested',
  );
});

test('staking resolves any funded MYNE token account by mint and amount', () => {
  const stake = source.slice(source.indexOf('async function stakeInstruction'), source.indexOf('export const stake'));
  assert.match(stake, /getParsedTokenAccountsByOwner\(authority, \{ mint \}, 'confirmed'\)/);
  assert.match(stake, /selectTokenAccountForAmount\(ownerTokenRows, amountBaseUnits, ownerAta\)/);
  assert.match(stake, /No single MYNE token account has enough tokens/);
  assert.doesNotMatch(stake, /getAccountInfo\(ownerTokens, 'confirmed'\)/);
});

test('unstaking creates the canonical destination account when the wallet has none', () => {
  const withdraw = source.slice(source.indexOf('export async function withdrawUnstaked'), source.indexOf('export async function claimStakingRewards'));
  assert.match(withdraw, /createAtaInstruction\(authority, authority, mint, ownerTokens\)/);
  assert.match(withdraw, /ownerTokens, vaultTokens/);
});
