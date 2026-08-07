import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('Protocol tab leads with the staking revenue premise', () => {
  assert.equal([...source.matchAll(/8% of all mining volume funds staking rewards in SOL/g)].length, 5, 'Protocol and SOL rewards copy must stay aligned across both renderers and the runtime refresh');
  assert.match(source, /ALL MINING VOLUME · EVERY ROUND/);
  assert.match(source, /8% <small>STAKING REWARDS IN SOL<\/small>/);
  assert.doesNotMatch(source, /NET TO STAKERS IN SOL/);
  assert.equal([...source.matchAll(/class="protocol-yield-banner"/g)].length, 2, 'initial and canonical About renderers must stay aligned');
});

test('Protocol tab explains standard and burn-staking weight', () => {
  assert.match(source, /Standard staking earns 1× pool weight/);
  assert.match(source, /Permanently burn your MYNE to earn 5× staking weight/);
  assert.match(source, /<small>STAKE \+ BURN<\/small><strong>5×<\/strong>/);
});

test('Fees disclose gross, net, administrator, buyback and claim fallback allocations', () => {
  assert.match(source, /<span>7\.2% net<\/span>SOL rewards for stakers/);
  assert.match(source, /<span>0\.8%<\/span>Administrator share of gross staking/);
  assert.match(source, /<span>2%<\/span>Motherlode/);
  assert.match(source, /<span>1%<\/span>Buyback and burn/);
  assert.match(source, /<span>1%<\/span>Direct administrator fee/);
  assert.match(source, /Permanent referrer or admin fallback/);
  assert.match(source, /0\.072 stakers · 0\.008 staking admin · 0\.02 Motherlode · 0\.01 buyback and burn · 0\.01 direct admin/);
});

test('Referrals are explained as three simple user actions with a concrete example', () => {
  assert.equal([...source.matchAll(/Share your link\. Earn MYNE\./g)].length, 2, 'initial and canonical About renderers must stay aligned');
  assert.match(source, /1 · Share your link[\s\S]*2 · They connect and mine[\s\S]*3 · You earn when they claim/);
  assert.match(source, /They receive <b>90 MYNE<\/b>\. You receive <b>1 MYNE<\/b>\./);
  assert.match(source, /No extra referral fee/);
  assert.doesNotMatch(source, /<span>Attribution<\/span><strong>Permanent after first valid assignment/);
  assert.doesNotMatch(source, /<span>Payment event<\/span><strong>Miner claims MYNE/);
});
