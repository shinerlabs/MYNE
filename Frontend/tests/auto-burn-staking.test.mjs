import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateMiners } from '../src/chain/miner-aggregation.js';
import { totalStakedBaseUnits, totalStakedMyne } from '../src/chain/staking-totals.js';

const authority = (address) => ({ toBase58: () => address });
const receipt = ({ address, rewardMode, amount = 10n }) => ({
  account: {
    authority: authority(address),
    amounts: [amount, ...Array(24).fill(0n)],
    totalLamports: amount,
    rewardMode,
    claimed: true,
    refunded: false,
  },
});

test('only receipts committed to Auto-burn receive the Auto-burn miner treatment', () => {
  const miners = aggregateMiners([
    receipt({ address: 'AutoBurnWallet111111111111111111111111111', rewardMode: 1 }),
    receipt({ address: 'AccumulateWallet111111111111111111111111', rewardMode: 0 }),
  ]);
  const autoBurn = miners.find((miner) => miner.address.startsWith('AutoBurn'));
  const accumulate = miners.find((miner) => miner.address.startsWith('Accumulate'));

  assert.deepEqual(
    { autoRound: autoBurn.autoRound, autoBurn: autoBurn.autoBurn, mode: autoBurn.autoMode },
    { autoRound: true, autoBurn: true, mode: 'burn' },
  );
  assert.deepEqual(
    { autoRound: accumulate.autoRound, autoBurn: accumulate.autoBurn, mode: accumulate.autoMode },
    { autoRound: false, autoBurn: false, mode: 'accumulate' },
  );
});

test('a wallet remains identified as Auto-burn when any receipt in the round committed burn mode', () => {
  const miners = aggregateMiners([
    receipt({ address: 'MixedWallet11111111111111111111111111111', rewardMode: 0, amount: 4n }),
    receipt({ address: 'MixedWallet11111111111111111111111111111', rewardMode: 1, amount: 6n }),
  ]);

  assert.equal(miners.length, 1);
  assert.equal(miners[0].deployed, 10n);
  assert.equal(miners[0].autoBurn, true);
  assert.equal(miners[0].autoMode, 'burn');
});

test('every staking total includes both standard and permanent burn principal', () => {
  assert.equal(totalStakedBaseUnits(45_000_000_000n, 800_000_000n), 45_800_000_000n);
  assert.equal(totalStakedMyne(45_000_000_000n, 800_000_000n), 45.8);
});
