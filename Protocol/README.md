# MYNE Solana protocol

This directory contains the Anchor program workspace for MYNE. It is intentionally separate from
`../Frontend`; the deployed program and its generated IDL define protocol state transitions.

The local/devnet milestone contains:

- a written protocol and account model in [`docs/PROTOCOL_SPEC.md`](docs/PROTOCOL_SPEC.md);
- a security and deployment checklist in [`docs/SECURITY.md`](docs/SECURITY.md);
- an Anchor 1.0-compatible workspace;
- an upgrade-authority-gated initialization/configuration surface;
- receipt-based mining with scheduled rounds and constant-cost settlement;
- staking, referrals, claims, balance-funded auto-round plans, and capped MYNE minting;
- checked basis-point arithmetic plus local integration tests.

The 4% buy/sell fee remains external to this program and is configured in the Meteora pool.

## Intended toolchain

- Anchor CLI 1.0.2
- Anchor crates 1.0.2
- Solana/Agave 3.x
- Rust stable supported by that Anchor release

Official Anchor installation currently recommends AVM. Once the toolchain is installed:

```bash
anchor build
cargo test --workspace
anchor test --validator legacy
```

For the persistent local demonstration, start an upgradeable local validator and initialize it,
then run:

```bash
pnpm run local:bootstrap
pnpm run local:keeper
```

`local:keeper` is hard-locked to localhost. It creates ten funded demo miners, including five
persistent cover-all miners that bid on every one of the 25 tiles each round. Those five miners
randomize each tile between 10x and 20x the 0.001 SOL demo base, so every local round stays
populated with varied bids and a confirmed winner. The keeper submits real receipt transactions
every 65-second round, executes funded user auto-plans, and settles immediately after the
60-second bidding window so the confirmed tile is visible for the final 5 seconds.

The synchronized devnet program ID is `D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e`. The local
suite uses an ignored test wallet and an upgradeable validator fixture so initialization exercises
the same authority constraint expected on devnet.

Run `./scripts/check-devnet-readiness.sh` before a deployment. The detailed sequence and stop
conditions are in [`docs/DEVNET_TESTING.md`](docs/DEVNET_TESTING.md), and the current security scope
is recorded in [`docs/REVIEW_2026-08-05.md`](docs/REVIEW_2026-08-05.md).

## Safety boundary

Do not deploy this milestone to mainnet. Devnet still uses a trusted randomness signer, the
Meteora pool is an external deployment step, and professional audit/fuzzing plus production key
management remain required.
