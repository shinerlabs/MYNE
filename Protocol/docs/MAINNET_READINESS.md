# MYNE mainnet readiness review

**Review date:** 2026-08-06  
**Outcome:** Code-complete deployment candidate; launch approval remains gated by external rehearsal and independent review

The program, clients and keepers build and pass the local suites. No Mainnet transaction was
authorized or submitted by this review. The remaining gates depend on live Switchboard/Meteora
accounts, production infrastructure, legal review and an independent security reviewer; they
cannot be honestly replaced by more local code.

## Implemented and locally verified

- Anchor mining receipts, round settlement, claims, referrals, staking, auto-round/auto-burn,
  immutable fee constants, a hard issuance ceiling, pause control and no freeze authority.
- 12% mining allocation: 8% staking, 2% buyback/burn and 2% Motherlode.
- 10% liquid-MYNE claim fee: 9% to remaining unclaimed balances and 1% to the permanent referrer,
  with the configured fallback wallet used when no referrer exists.
- Exact cumulative-interval reward allocation. Every integer SOL/MYNE unit is assigned without
  operator dust; frontend miner calculations use the same rule.
- Switchboard pre-bid account commitment/binding, exact seed-slot binding, same-transaction
  reveal/settlement, exact owner/authority validation and a one-way Mainnet provider lock.
- Mainnet activation and every settlement revalidate the canonical Meteora DLMM pool reserve PDAs,
  MYNE/WSOL mints and minimum reserves.
- Buyback keeper is dry-run by default and enforces the registered direct Meteora route, spend and
  slippage caps, reserve protection, swap/burn simulation, signed-transaction crash recovery,
  sequential round accounting and a durable journal in live mode.
- Local demo keeper is single-instance, preventing the multi-keeper races that previously caused
  the round header, history and miners list to diverge.
- Rust: formatting, Clippy with warnings denied, 11 unit tests, successful SBF deployment and full
  local integration. Frontend: 22 tests and production build. Keeper policy/dependency tests: 4.
  Current npm production audit: no known vulnerabilities.

## External launch gates

### 1. Live Switchboard rehearsal

Run the exact production request/commit/open/bind/reveal/settle sequence on a live cluster. Exercise
wrong owner, wrong binding, stale reveal, replay, duplicate settlement and missed-reveal/refund
recovery. The on-chain checks and one-shot keeper exist; this gate proves the external service and
operator setup.

### 2. Final Meteora pool does not exist yet

The program accepts only the canonical Meteora DLMM program and reserve PDAs and rechecks reserves
at activation and settlement. After the official MYNE/WSOL pool is created, independently verify
the pool, both vaults, mint order and thresholds before the single unpause activation.

### 3. Keeper hosting and keys

Run the Switchboard and buyback keepers under a supervisor with durable storage, restricted online
keys, alerts, RPC/Jupiter outage handling and an incident pause procedure. The single-developer
upgrade authority should be offline/hardware-backed and separate from the admin and keeper keys.

### 4. Independent security and legal review

This is a financial protocol with paid chance-based settlement and token issuance. Commission an
independent Solana/Anchor audit, adversarial testing and jurisdiction-specific legal review before
accepting public funds.

RustSec found no vulnerable Rust crate; it reported the upstream maintenance-status warning for
Solana's `bincode 1.x`. GitHub's unpatched native `bigint-buffer` advisory was removed from the
keeper graph with a local, bounds-safe, pure-JavaScript compatibility shim, after which npm reported
no known production vulnerabilities.

## Required launch sequence

1. Complete the live Switchboard failure rehearsal and keeper monitoring drill.
2. Deploy the exact recorded SBF artifact and verify program ID, ProgramData and upgrade authority.
3. Create the 9-decimal mint: exactly 100 MYNE, no freeze authority, config PDA mint authority.
4. Initialize paused with the Mainnet Switchboard program and reviewed destinations.
5. Create and independently verify the official Meteora MYNE/WSOL pool and register its gate.
6. Run dry-run buyback quotes, then a tiny controlled swap/burn canary.
7. Snapshot every address and state account, unpause once, and verify a full round before publicity.
8. Publish program ID, mint, IDL/binary hashes, authority disclosure and incident procedure.

Follow `docs/MAINNET_LAUNCH_RUNBOOK.md`. “Deployment candidate” does not mean independently audited
or guaranteed safe; Mainnet funds should not be accepted until every external gate is signed off.
