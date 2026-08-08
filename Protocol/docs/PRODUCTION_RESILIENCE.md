# Production resilience contract

This document defines the operational invariants for MYNE Mainnet. It is a
release gate, not an aspirational architecture note. A deployment must remain
paused when any invariant below cannot be demonstrated from finalized chain
state.

## Authority and freshness

Solana accounts are authoritative for balances, eligibility, round outcome,
receipt counters and protocol configuration. Supabase is a rebuildable,
finalized read model. Confirmed browser account subscriptions decode the exact
account bytes they receive immediately; bounded snapshot reads remain active as
the reconnect and missed-notification fallback.

The live Mine surface may overlay confirmed current/previous Round accounts on
the finalized history so a winner is visible as soon as Solana confirms it.
Historical rows and aggregate statistics use finalized data. A missing or
incomplete projection is displayed as unavailable/confirming, never as zero.

## Isolated worker responsibilities

One worker failure must not stop an unrelated protocol function.

1. **Round keeper** — prepare the next commitment, lock entropy after betting,
   and settle the exact Round PDA. It must not wait on projection, buyback,
   archival or unbounded Auto Plan work.
2. **Hot projector** — consume finalized program transactions and publish the
   public read model. It does not decide outcomes.
3. **Reconciler** — compare exact Round PDAs with the read model and replay
   complete PDA transaction histories oldest-to-newest.
4. **Lifecycle worker** — accrue or refund receipts from chain-derived queues.
5. **Buyback worker** — execute the independently journalled swap/burn queue.
6. **Archive worker** — attest and close only fully reconciled terminal rounds.

Round preparation, settlement, projection and receipt accrual are the core
availability path. Buyback remains supervised and is reported as a degraded
health component, but its API/route/lease failure must not return a failing
Railway health status or restart those core workers. Operators alert on the
`degraded` and `degradedWorkers` fields and repair buyback independently.

Pausing mining stops new deployments and round creation. It must not stop the
signerless projector or reconciler. An incident may separately fence every
transaction-producing worker while observation continues.

The managed implementation of that state is `MYNE_WORKER_MODE=observe`, with
`MYNE_WORKER_HOST_OBSERVE` equal to the exact program ID. Observe mode refuses
an active protocol and starts only the round indexer with
`ROUND_INDEXER_PROJECT_ONLY=1`; it loads no operational signer and cannot
archive or send a transaction.

## Projection completeness

A round projection is complete only when all of these match the finalized
Round account:

- all 25 indexed tile SOL sums equal `tile_lamports`;
- all 25 distinct receipt counts equal `tile_receipts`;
- distinct indexed receipts equal `total_receipts`;
- processed and closed receipt counts match their on-chain counters;
- settled outcome, fee allocation and provider-specific randomness proof are
  present and valid;
- an archived row's canonical hash equals the on-chain archive hash.

Winner/miner counts and derived Solo identity remain unknown until the
projection is complete. Claim authority comes from canonical Miner and
StakePosition balances, not historical receipt rows.

The stable `${programId}:rounds:v2` and independent referral cursor must reach
the newest finalized program transaction before resume. The bounded
`${programId}:rounds:v2:historical-gaps:v1` cursor must complete a full pass,
and no terminal Round in the recovery/canary window may remain incomplete.

## Health and automatic recovery

`/healthz` is successful only when every core deadline and data-plane check is
healthy. Process existence by itself is insufficient.

- the current and next round are prepared before their on-chain deadline;
- every funded round settles before its refund boundary;
- each worker has a recent successful heartbeat (repeated errors are unhealthy);
- finalized projector lag is below the configured threshold;
- reconciliation has no outstanding invariant failure in the canary window;
- worker lease/fencing identity is current.

Hung RPC/HTTP/confirmation calls have bounded deadlines. The supervisor first
terminates, then force-kills and restarts a stale child. Durable cursors,
commitments and buyback journals make restart idempotent.

`ROUND_ACCOUNT_RETENTION_SECONDS=130` is the production minimum. Reward
accrual occurs immediately, but settled Round/receipt cleanup waits long enough
for at least two 60-second cycles of direct-chain winner and miner-card
recovery.

## Incident mode

1. Pause the protocol on-chain.
2. Fence transaction-producing workers; keep observation/reconciliation live.
3. Record a finalized cutoff and re-read all nonterminal Round/Receipt PDAs.
4. Replay missing histories and verify projection completeness.
5. Recover receipts/refunds from current chain state. Never reconstruct a paid
   liability from a stale database row.
6. Keep buyback/archive isolated until their exact evidence is reconciled.

## Resume gate

Mining may resume only after two complete canary rounds (one played, one empty)
prove all of the following:

- bids remain accepted for the full 60-second betting interval;
- paid tiles and miner entries update from chain without a page reload;
- a verifiable winner is shown during the five-second result interval;
- exact SOL/MYNE rewards accrue to the owner's claimable balances;
- Claim SOL, Claim MYNE, Claim All and Stake/Burn simulate and execute once;
- the 50-row history has no gap or duplicate across page boundaries;
- finalized outcome, fees, proofs, tile totals and receipt counters match chain;
- projector lag, worker deadlines and reconciliation health stay green through
  the following round.

Any mismatch keeps the protocol paused. Buyback may be repaired independently;
it must never block round settlement, claims or public history.
