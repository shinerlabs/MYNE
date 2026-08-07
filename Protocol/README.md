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

Trading fees are deferred and are not part of this protocol milestone. Protocol version 6 charges
an exact 12% of each round's gross deployment: 8% is the gross staking allocation, from which 0.8%
of round volume is paid directly to the configured admin and the remaining 7.2% is indexed for
stakers; 2% funds the Motherlode; 1% funds buyback and burn; and 1% is paid directly to the admin.
The admin therefore receives 1.8% of round volume directly, subject only to the documented integer
rounding rule that assigns fee dust to that direct payment.

## Intended toolchain

- Anchor CLI 1.0.2
- Anchor crates 1.0.2
- Solana/Agave 3.x
- Rust 1.97.1 (pinned in `rust-toolchain.toml`)

Official Anchor installation currently recommends AVM. Once the toolchain is installed:

```bash
# Local/Devnet rehearsal artifact only:
anchor build
cargo test --workspace
anchor test --validator legacy

# Internal Mainnet candidate/preflight (not the final verified deployment build):
pnpm build:mainnet
```

Never deploy the default `anchor build` output to Mainnet. `pnpm build:mainnet` forwards
`--features production` through Anchor, verifies the production-only marker embedded in the SBF,
and synchronizes the generated frontend IDL. The external release manifest and Mainnet preflight
both reject a rehearsal binary even if its source tree and hash are otherwise internally
consistent. After the final source is committed publicly, rebuild with Docker and `solana-verify`,
deploy only that exact executable, and complete the on-chain hash, repository and remote
verification sequence in [`docs/MAINNET_LAUNCH_RUNBOOK.md`](docs/MAINNET_LAUNCH_RUNBOOK.md). The
internal marker and manifest are provenance controls, not a Solana verified build or a security
audit.

For the persistent local demonstration, start an upgradeable local validator and initialize it,
then run:

```bash
pnpm run local:bootstrap
pnpm run local:keeper
```

`local:keeper` is hard-locked to localhost. It creates ten funded demo miners, including five
persistent cover-all miners that bid on every one of the 25 tiles each round. Those five miners
share one exact per-tile bid that changes between 10x and 20x the 0.001 SOL demo base each round.
Four of the five use real funded Auto-burn plans: their receipts commit burn mode before settlement,
their mined MYNE becomes permanent 5x burn stake, and the pool-wide staked total increases after
each winning receipt is processed. This keeps every local round populated while making equal-bid
reward splits and Auto-burn staking growth directly auditable. The keeper submits real receipt
transactions every 65-second round, executes funded user auto-plans, and settles both rounds and
their receipts immediately after the 60-second bidding window so the confirmed tile is visible for
the final 5 seconds.

The synchronized devnet program ID is `D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e`. The local
suite uses an ignored test wallet and an upgradeable validator fixture so initialization exercises
the same authority constraint expected on devnet.

Run `./scripts/check-devnet-readiness.sh` before a deployment. The detailed sequence and stop
conditions are in [`docs/DEVNET_TESTING.md`](docs/DEVNET_TESTING.md). The dated
[`docs/REVIEW_2026-08-05.md`](docs/REVIEW_2026-08-05.md) is retained as historical evidence and is
superseded by the version-6 readiness and launch documents.

Production lifecycle services are deliberately separated from the randomness-critical reveal
transaction:

- `devnet:switchboard-round`/the supervised production round keeper binds an uncommitted request,
  commits and records it only after betting closes, then reveals and settles atomically;
- `round:indexer` records finalized round/referral events, maintains versioned cursors and commits
  deterministic archive proofs;
- `round:lifecycle` batches permissionless settlements/refunds and closes archived PDAs;
- `buyback:keeper` performs and indexes direct Meteora swap/burn evidence;
- `workers:production` supervises all four services on the managed host, defaulting to a
  transaction-free standby health check;
- `prepare:admin-ata` creates the one canonical fallback fee token account after mint creation.

These services use indexed addresses and exact on-chain revalidation; they do not scan every
program-owned account in production. The Railway container, secret boundaries, persistent volume,
standby-to-live controls and incident procedure are documented in
[`docs/WORKER_HOSTING.md`](docs/WORKER_HOSTING.md).

## Mainnet-candidate boundary

The checked-in code is a deployment candidate, not an authorization to launch. Production uses
the verified Switchboard commit/reveal path and a canonical official Meteora DAMM v2 or DLMM
reserve gate; the legacy
caller-supplied randomness instruction is limited to configs whose randomness program is the
default key. Before funding Mainnet, complete the external Switchboard/Meteora rehearsal,
independent security review, legal review, and production-key/keeper setup in
[`docs/MAINNET_LAUNCH_RUNBOOK.md`](docs/MAINNET_LAUNCH_RUNBOOK.md).
