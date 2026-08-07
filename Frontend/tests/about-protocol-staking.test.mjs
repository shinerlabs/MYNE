import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('Protocol tab leads with the staking revenue premise', () => {
  assert.match(source, /8% of all SOL deployed across every mining round is paid directly to MYNE stakers/);
  assert.match(source, /ALL MINING VOLUME · EVERY ROUND/);
  assert.match(source, /8% <small>PAID TO STAKERS IN SOL<\/small>/);
  assert.equal([...source.matchAll(/class="protocol-yield-banner"/g)].length, 2, 'initial and canonical About renderers must stay aligned');
});

test('Protocol tab explains standard and burn-staking weight', () => {
  assert.match(source, /Standard staking earns 1× pool weight/);
  assert.match(source, /Permanently burn your MYNE to earn 5× staking weight/);
  assert.match(source, /<small>STAKE \+ BURN<\/small><strong>5×<\/strong>/);
});
