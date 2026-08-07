import { Buffer } from 'buffer';

// Anchor and parts of the Solana wallet stack still access Node's Buffer as a
// browser global when a transaction is constructed. Vite's `buffer` alias
// makes the implementation bundleable, but an alias alone does not create the
// global. Install it before the protocol client modules are evaluated so Mine,
// Stake and wallet-signature actions all use the same implementation.
if (!globalThis.Buffer) {
  Object.defineProperty(globalThis, 'Buffer', {
    configurable: true,
    writable: true,
    value: Buffer,
  });
}

