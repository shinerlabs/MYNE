import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../programs/myne_protocol/src/lib.rs', import.meta.url), 'utf8');

const handler = (name, nextName) => source.slice(
  source.indexOf(`pub fn ${name}`),
  source.indexOf(`pub fn ${nextName}`, source.indexOf(`pub fn ${name}`) + 1),
);

test('emergency pause blocks new exposure but leaves earned MYNE exits available', () => {
  const burn = handler('burn_unclaimed_myne', 'claim_myne');
  const claimStart = source.indexOf('pub fn claim_myne');
  const claim = source.slice(claimStart, source.indexOf('\n}\n\nfn ', claimStart));
  assert.doesNotMatch(burn, /ProtocolPaused/);
  assert.doesNotMatch(claim, /ProtocolPaused/);
  assert.match(burn, /CURRENT_VERSION/);
  assert.match(claim, /CURRENT_VERSION/);

  for (const [name, next] of [
    ['register_miner', 'open_round'],
    ['deploy', 'create_auto_plan'],
    ['stake_standard', 'burn_stake'],
  ]) {
    assert.match(handler(name, next), /ProtocolPaused/, `${name} must stay blocked while paused`);
  }
});
