# MYNE buyback and burn keeper

## What is on-chain

At settlement, the MYNE program calculates 2% of the round's gross deployment and transfers
that amount to the immutable `config.buyback_wallet`. The contract emits `BuybackAllocation` so
the transfer is observable and auditable. The contract deliberately does not perform a DEX CPI:
pool-specific swap accounts, price movement, and slippage must be handled by the keeper.

## Keeper flow

`scripts/buyback-keeper.mjs` performs the following loop:

1. Read `ProtocolConfig` and `LiquidityGate` from the configured program.
2. Require the gate to be verified and require the keeper signer to equal `buyback_wallet`.
3. Preserve a SOL reserve and cap each buyback amount.
4. Request a direct Jupiter quote restricted to `Meteora DLMM`.
5. Reject the quote unless it uses exactly the registered pool address, native SOL as input,
   and MYNE as output.
6. In live mode, simulate the swap, submit it, and confirm it.
7. Burn only the MYNE balance delta received by the keeper's associated token account.
8. Simulate and confirm the burn transaction, then log both signatures.

Jupiter is used only as the transaction/quote builder; the route is constrained to the registered
Meteora DLMM pool. This avoids embedding a fragile pool-specific CPI in the protocol while still
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
MIN_BUYBACK_SOL=0.01
BUYBACK_SLIPPAGE_BPS=100
MAX_PRIORITY_LAMPORTS=500000
BUYBACK_INTERVAL_MS=60000
```

The buyback signer must be the wallet configured as `buyback_wallet`; do not use an upgrade
authority or personal wallet. Keep its keypair outside the repository, preferably in a secret
manager or hardware-backed signer. Start with `--once` and `DRY_RUN=1`, inspect the quoted pool,
price impact, and amount, then enable live mode only after a devnet smoke test.

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

