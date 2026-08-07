import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('Protocol tab leads with the staking revenue premise', () => {
  assert.match(source, /8% of every mining round is allocated to staking/);
  assert.match(source, /leaving 7\.2% of all mining volume distributed to MYNE stakers in SOL/);
  assert.match(source, /ALL MINING VOLUME · EVERY ROUND/);
  assert.match(source, /7\.2% <small>NET TO STAKERS IN SOL<\/small>/);
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
