# Mainnet launch runbook

This is an ordered launch procedure, not an automatic deployment script. Every wallet address,
mint, pool, vault, oracle account, and transaction must be reviewed before signing. The artifact
preflight is read-only:

```bash
./scripts/check-mainnet-readiness.sh
```

State layout version 4 adds hard-issuance tracking and automation reward mode. Mainnet must use a
fresh version-4 initialization. An older Devnet version-3 config is not a Mainnet migration source
and must not be copied or reused.

## 1. Prepare isolated production authorities

Use fresh, backed-up production keys. Do not reuse the Devnet wallet, Devnet mint, or local demo
wallets. Record these addresses before funding anything:

- upgrade authority;
- protocol admin;
- Switchboard randomness authority/keeper;
- buyback keeper wallet;
- reserved Motherlode layout address (no funds are transferred there; use the admin address);
- fallback referral-fee wallet.

The project uses a single administrator by product decision, but the operational fee and keeper
keys should still be separate from the upgrade key.

## 2. Build and verify the exact artifact

Run the artifact preflight, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test`, the Frontend test suite, and the buyback policy tests. Record the binary SHA-256
printed by the preflight. Do not rebuild after recording it.

## 3. Deploy the upgradeable program

Deploy the recorded `.so` to the fixed program address and verify the on-chain program data and
upgrade authority. The program must remain paused; do not initialize or unpause until the mint,
oracle, and pool checks below are complete.

## 4. Create and initialize the Mainnet mint

Create a new 9-decimal MYNE mint with no freeze authority. Initialize the protocol with:

- `randomness_program = SWITCHBOARD_MAINNET_PROGRAM`;
- a non-default, controlled randomness authority;
- the production buyback and fallback referral-fee destinations. The legacy Motherlode address
  field is reserved for account-layout compatibility; Motherlode SOL remains in the config PDA.

Transfer mint authority to the protocol config PDA as part of initialization. Confirm the initial
supply and all account relationships from RPC before proceeding.

## 5. Create and verify the Meteora pool

Create the official MYNE/SOL DLMM pool with the chosen initial liquidity and fee tier. Independently
verify the pool owner, MYNE vault, WSOL vault, vault mints, and minimum reserves. Only then submit
`initialize_liquidity_gate` with the exact pool and vault addresses.

## 6. Verify randomness and keeper paths

Run a controlled Switchboard request/commit/bind/reveal/settle rehearsal against the Mainnet
provider configuration. Confirm that the winner is not knowable before the betting window closes,
that stale/replayed randomness is rejected, and that settlement requires the registered pool.

## 7. Activate once

After all checks pass, submit the single `set_paused(false)` transaction with the registered gate
and vault accounts. This is the activation latch for mining, staking, referrals, emissions, and
buyback accounting. Save the transaction signature and config snapshot.

## 8. Operate and monitor

Run the round keeper and buyback keeper from supervised infrastructure with durable state,
restricted keys, balance alerts, slippage limits, retry handling, and an incident pause procedure.
Do not advertise or fund public participation until at least one complete round, claim, staking
distribution, referral fallback, buyback/burn, and Motherlode path has been independently verified.
