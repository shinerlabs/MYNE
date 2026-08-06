# MYNE mainnet readiness review

**Review date:** 2026-08-06  
**Outcome:** Not approved for mainnet deployment

The local implementation builds and the protocol unit suite passes, but the current system is a
paused/devnet milestone. The following gates must be closed before any mainnet transaction or
liquidity funding. A multisig is not required for this project; the authority section records the
single-developer operating model and its key-management requirements.

## Implemented and locally verified

- Anchor program with mining receipts, settlement, claims, referrals, staking, auto-round plans,
  liquidity pause gate, hard-cap checks and no freeze authority.
- 12% mining allocation: 8% staking, 2% buyback/burn, 2% Motherlode.
- 10% MYNE claim fee: 9% unclaimed balances and 1% referrer, with the configured fallback wallet
  for wallets without a referrer.
- Buyback keeper in dry-run by default, with registered-pool/direct-route checks, spend caps,
  reserve protection, swap simulation, burn simulation, per-round accounting and durable retry
  state.
- Local Rust checks: `cargo fmt`, `cargo check`, `cargo clippy`, `cargo test`, and `anchor build`.
- Local Rust unit tests: 6 passed. Frontend tests: 18 passed. Buyback policy tests: 2 passed.

## Critical blockers

### 1. Randomness provider integration is implemented but not yet production-tested

The production path now binds a Switchboard On-Demand randomness account before deployments,
parses the pinned account discriminator/owner, requires a committed seed, and consumes the value
only in its reveal slot. `settle_round` remains available only when the configured provider is the
default key, which is an explicit local/devnet legacy mode. The keeper still needs to create and
commit a fresh Switchboard account, submit the reveal and call `settle_round_verified` in the same
slot. `scripts/switchboard-round-keeper.mjs` now rehearses account creation, commit, round opening
and binding, then waits for the settlement window and submits reveal plus
`settle_round_verified` atomically. Auto-round execution now has the same randomness-binding
requirement, and binding is restricted to `config.randomness_authority`. Devnet tests must cover
stale reveals, wrong account binding, wrong owner, replay and missed-reveal recovery before this
gate can be closed.

### 2. Mainnet liquidity gate now verifies the configured Meteora DLMM and live vault reserves

Mainnet registration requires the canonical Meteora DLMM program, MYNE and wrapped SOL vault
accounts, matching mints, and minimum live vault balances. Mainnet unpause and verified settlement
re-check those same vaults, so withdrawing liquidity pauses the production path. Devnet's
Switchboard provider mode intentionally bypasses this gate; its buyback keeper records the 2%
allocation but skips swaps until a pool is registered. The pool-to-vault association still depends
on the designated admin supplying the pool's official vault accounts and remains a mainnet launch
check.

### 3. Buyback/burn remains an operational keeper

The program transfers 2% SOL to `buyback_wallet`; the swap and burn happen later in a Node keeper
through Jupiter. The keeper now calculates each settled round's exact 2% allocation, persists
partial progress, retries safely after restart, and simulates both swap and burn before signing.
Mainnet still needs monitored hosting, secret-manager or hardware signing, balance alerts, API
outage behavior, slippage circuit breakers, and an incident response plan.

### 4. The round/randomness keeper flow is implemented but needs an operational deployment

`local-keeper.mjs` remains deliberately locked to localnet/devnet. The Switchboard keeper now
opens, commits, binds, waits, reveals and settles one round atomically. Mainnet still needs a
supervised service that runs this flow continuously, executes funded auto-plans, and monitors
missed or failed transactions. It must be idempotent, observable and safe to restart.

### 5. Production authority model needs explicit sign-off

You have confirmed that MYNE will be operated by a single developer rather than a multisig. That is
an acceptable product decision, but the upgrade authority, protocol admin, randomness signer and fee
wallets must still be separate, documented, hardware-backed or otherwise protected production keys.
The current scripts and local fixtures use single file-backed wallets and must not be reused for
mainnet.

### 6. External audit and fuzzing are outstanding

This is a financial protocol with chance-based settlement and token issuance. A professional audit
and adversarial/fuzz testing are required before launch. `cargo audit` could not refresh its advisory
database in this environment because the Cargo advisory path is read-only, so dependency status is
not independently verified here.

## Required next sequence

1. Write and rehearse the production round/randomness keeper, then choose and integrate the
   randomness provider; add adversarial tests for bias, replay,
   stale fulfilment and duplicate settlement.
2. Implement and test real Meteora pool verification, including MYNE/SOL mint ordering and reserve
   thresholds. Keep the protocol paused until the verifier passes.
3. Deploy a disposable devnet pool and run multi-round tests covering mining, claims, referrals,
   staking, Motherlode, keeper buyback/burn and failure/retry paths.
4. Move upgrade/admin/keeper/treasury authority to the approved governance setup and rehearse key
   rotation and pause recovery.
5. Produce a verifiable build, publish the IDL/hash, complete an independent audit, and only then
   authorize a separately confirmed mainnet deployment.

No mainnet deployment or mainnet funds should be attempted until every critical blocker above is
closed and explicitly signed off.
