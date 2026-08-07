import assert from 'node:assert/strict';

export const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2Nbd';
export const SOLANA_DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const SWITCHBOARD_MAINNET_PROGRAM = 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv';
export const SWITCHBOARD_DEVNET_PROGRAM = 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2';

/**
 * Production services must not infer their safety mode from account data alone.
 * In particular, a Mainnet config using the Devnet Switchboard address would
 * otherwise also select the no-liquidity-gate rehearsal path.
 */
export function requireMatchingSolanaNetwork({ genesisHash, randomnessProgram }) {
  const program = String(randomnessProgram);
  if (genesisHash === SOLANA_MAINNET_GENESIS_HASH) {
    assert.equal(
      program,
      SWITCHBOARD_MAINNET_PROGRAM,
      'Mainnet must use the Switchboard On-Demand Mainnet program',
    );
    return 'mainnet-beta';
  }
  if (genesisHash === SOLANA_DEVNET_GENESIS_HASH) {
    assert.equal(
      program,
      SWITCHBOARD_DEVNET_PROGRAM,
      'Devnet must use the Switchboard On-Demand Devnet program',
    );
    return 'devnet';
  }
  throw new Error(`Production keeper refuses unsupported Solana genesis hash: ${genesisHash}`);
}
