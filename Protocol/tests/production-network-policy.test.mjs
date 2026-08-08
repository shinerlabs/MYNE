import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_GENESIS_HASH,
  SWITCHBOARD_DEVNET_PROGRAM,
  SWITCHBOARD_MAINNET_PROGRAM,
  requireMatchingSolanaNetwork,
} from '../scripts/production-network-policy.mjs';

test('production keeper binds Mainnet to Switchboard Mainnet', () => {
  assert.equal(
    SOLANA_MAINNET_GENESIS_HASH,
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  );
  assert.equal(requireMatchingSolanaNetwork({
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    randomnessProgram: SWITCHBOARD_MAINNET_PROGRAM,
  }), 'mainnet-beta');
  assert.throws(() => requireMatchingSolanaNetwork({
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    randomnessProgram: SWITCHBOARD_DEVNET_PROGRAM,
  }), /Mainnet must use/);
});

test('Mainnet server commit-reveal is accepted only through an explicit program marker', () => {
  const serverProgram = 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e';
  assert.throws(() => requireMatchingSolanaNetwork({
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    randomnessProgram: serverProgram,
  }), /Mainnet must use/);
  assert.equal(requireMatchingSolanaNetwork({
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    randomnessProgram: serverProgram,
    serverRandomnessProgram: serverProgram,
  }), 'mainnet-beta');
  assert.throws(() => requireMatchingSolanaNetwork({
    genesisHash: SOLANA_MAINNET_GENESIS_HASH,
    randomnessProgram: serverProgram,
    serverRandomnessProgram: '11111111111111111111111111111111',
  }), /Mainnet must use/);
});

test('production keeper binds Devnet to Switchboard Devnet', () => {
  assert.equal(requireMatchingSolanaNetwork({
    genesisHash: SOLANA_DEVNET_GENESIS_HASH,
    randomnessProgram: SWITCHBOARD_DEVNET_PROGRAM,
  }), 'devnet');
  assert.throws(() => requireMatchingSolanaNetwork({
    genesisHash: SOLANA_DEVNET_GENESIS_HASH,
    randomnessProgram: SWITCHBOARD_MAINNET_PROGRAM,
  }), /Devnet must use/);
});

test('production keeper refuses localnet and unknown networks', () => {
  assert.throws(() => requireMatchingSolanaNetwork({
    genesisHash: 'local-or-unknown',
    randomnessProgram: SWITCHBOARD_DEVNET_PROGRAM,
  }), /unsupported Solana genesis hash/);
});
