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
  reserve protection, swap simulation and burn simulation.
- Local Rust checks: `cargo fmt`, `cargo check`, `cargo clippy`, `cargo test`, and `anchor build`.
- Local Rust unit tests: 6 passed. Frontend tests: 18 passed. Buyback policy tests: 2 passed.

## Critical blockers

### 1. Randomness is trusted, not oracle-backed

`settle_round` accepts a 32-byte value from a configured signer. That signer can choose the tile,
mode, Solo winner and Motherlode result. This is acceptable only for local/devnet rehearsal. A
mainnet deployment needs a verifiable randomness provider and a request/fulfilment binding with
replay, freshness and duplicate-fulfilment protection.

### 2. The liquidity gate does not parse or prove a MYNE/SOL Meteora pool

The gate currently checks an admin-supplied account is non-empty and owned by an admin-supplied
program ID. It does not verify the Meteora program ID, pool token mints, vaults, or minimum live
reserves on-chain. A wrong or unrelated account could therefore be registered by the admin. The
registration flow must either validate the official Meteora pool account layout on-chain or use a
separately audited verifier that proves MYNE/SOL reserves and the approved pool program.

### 3. Buyback/burn is an operational keeper, not an on-chain guarantee

The program transfers 2% SOL to `buyback_wallet`; the swap and burn happen later in a Node keeper
through Jupiter. Mainnet needs a monitored, restartable service with secret-manager or hardware
signing, balance alerts, nonce/retry handling, API outage behavior, slippage circuit breakers,
and an incident response plan. A single laptop process is not sufficient.

### 4. There is no production round/randomness keeper

`local-keeper.mjs` is deliberately locked to localnet/devnet and is a demo harness. Mainnet still
needs a separate service that opens scheduled rounds, requests/fulfils randomness, settles exactly
once, executes funded auto-plans, and monitors missed or failed transactions. It must be
idempotent, observable and safe to restart.

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
