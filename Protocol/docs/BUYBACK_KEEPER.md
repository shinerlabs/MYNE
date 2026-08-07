# MYNE buyback and burn keeper

## What is on-chain

At settlement, the MYNE program calculates 1% of the round's gross deployment and transfers
that amount to the immutable `config.buyback_wallet`. The contract emits `BuybackAllocation` so
the transfer is observable and auditable. The contract deliberately does not perform a DEX CPI:
pool-specific swap accounts, price movement, and slippage must be handled by the keeper.

## Keeper flow

`scripts/buyback-keeper.mjs` performs the following loop:

1. Read `ProtocolConfig` and `LiquidityGate` from the configured program.
2. Require the gate to be verified and require the keeper signer to equal `buyback_wallet`.
3. Read the latest settled round and reconcile the emitted 1% allocation against that round's
   gross deployment and `RoundFeesDistributed` evidence.
4. Preserve a SOL reserve and cap each buyback amount.
5. Select `Meteora DAMM v2` or `Meteora DLMM` from the exact pool program stored in the on-chain
   gate, then request a direct Jupiter quote restricted to that one venue.
6. Reject the quote unless it uses exactly the registered pool address, native SOL as input,
   and MYNE as output.
7. Decompile the serialized swap transaction, require the buyback wallet as its only signer, reject
   unapproved top-level programs, and simulate the exact transaction. Refuse it if the simulated SOL
   debit exceeds the quote input plus the network fee and the configured overhead bound, or if the
   simulated MYNE credit is below the quote's slippage threshold.
8. In live mode, submit the inspected transaction and confirm it.
9. Burn only the MYNE balance delta received by the keeper's associated token account.
10. Simulate and confirm the burn transaction, then persist the round's consumed allocation and log
   both signatures. Partial failures can safely resume without spending a completed round twice.

Jupiter is used only as the transaction/quote builder; the route is constrained to the registered
Meteora pool and exact registered pool program. This avoids embedding a fragile pool-specific CPI
in the protocol while still
ensuring buybacks cannot silently route through another venue.

## Safety defaults

The keeper is dry-run by default. Live mode requires:

```text
BUYBACK_KEEPER_LIVE=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e
DRY_RUN=0
```

Recommended production controls:

```text
MYNE_PROGRAM_ID=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e
MYNE_MINT_ADDRESS=<mainnet MYNE mint>
KEEPER_RESERVE_SOL=0.25
MAX_BUYBACK_SOL=0.25
MIN_BUYBACK_SOL=0.0001
BUYBACK_SLIPPAGE_BPS=100
MAX_PRIORITY_LAMPORTS=500000
MAX_SWAP_OVERHEAD_LAMPORTS=5000000
BUYBACK_INTERVAL_MS=60000
BUYBACK_START_ROUND=0
BUYBACK_STATE_PATH=/secure/keeper-data/myne-buyback-state.json
```

The buyback signer must be the distinct controlled wallet configured as `buyback_wallet`; do not
reuse the admin or randomness role. Keep its keypair outside the repository, preferably in a secret
manager or hardware-backed signer. Start with `--once` and `DRY_RUN=1`, inspect the quoted pool,
price impact, and amount, then enable live mode only after a devnet smoke test.

The default Jupiter endpoints are restricted to exact HTTPS paths on official Jupiter hosts.
Changing either host requires the explicit `ALLOW_CUSTOM_JUPITER_ENDPOINT=<program-id>` gate and a
fresh independent review of that endpoint. Endpoint allowlisting does not replace the serialized
transaction inspection or the tiny Mainnet canary.

`BUYBACK_START_ROUND` is used only when creating a new journal. Set it to the first production
round (normally `0`). Thereafter the durable journal advances sequentially, including across
outages, so earlier allocations cannot be skipped merely because the keeper restarted later.
The durable journal and its backups are launch-critical: do not run live mode on ephemeral disk,
and alert immediately if the journal cannot be loaded or its indexed transaction evidence disagrees.
If an RPC cannot establish whether a saved swap landed, the keeper now stops that round instead of
silently requoting. Reconcile the saved signature against two independent RPCs; only a finalized
error retries automatically. An absent/expired signature may be abandoned only with the exact
`CONFIRM_ABANDONED_BUYBACK=<round>:<signature>` acknowledgement after the operator proves it did not
land. This favors fund safety over unattended liveness.

## Review status

- Direct-route and registered-pool checks: covered by `tests/buyback-policy.test.mjs`.
- Spend cap and keeper reserve: covered by `tests/buyback-policy.test.mjs`.
- Swap and burn are simulated before submission in live mode.
- No mainnet deployment or live transaction has been performed by this change.

Run locally:

```bash
pnpm test:buyback-policy
DRY_RUN=1 pnpm buyback:keeper -- --once
```
