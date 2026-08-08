# Production worker hosting

The MYNE production workers run on one managed Railway service named
`myne-protocol-workers`. Railway is the always-on Linux host: no server administration is required
from the protocol administrator.

## Safety model

The service defaults to `MYNE_WORKER_MODE=standby`. Standby verifies all of the following every 30
seconds, but starts no child worker:

- Solana Mainnet genesis and the exact configured, production-approved
  randomness mode (legacy Switchboard or MYNE server commit–reveal);
- the exact MYNE program and mint;
- protocol version 6 and the configured operational public keys;
- the verified, non-default Meteora liquidity gate;
- the protocol remains paused;
- authenticated access to the production round index and the exact
  `round-projection-v2` schema capability.

`MYNE_WORKER_MODE=observe` is the paused recovery/catch-up mode. It starts exactly one
`round-indexer` child with `ROUND_INDEXER_PROJECT_ONLY=1` and
`ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE=0`. It cannot archive, close, settle, refund, swap, burn or
send a transaction; the randomness, lifecycle and buyback workers are not started. The host creates
an unfunded ephemeral Anchor wallet only because the read APIs require a wallet object, and observe
mode does not load either operational signer secret. Both standby and observe refuse an unpaused
protocol.

The service exposes only `/healthz`; its response contains mode, revision and worker state, never
credentials, RPC URLs or wallet addresses.

In live mode, `ok` is the availability signal for rounds, projection and receipt accrual. Buyback
is supervised but isolated: a Jupiter/pool/lease outage sets `degraded: true`, names
`buyback-keeper` in `degradedWorkers`, and leaves `ok: true` so Railway does not restart healthy
round and claim workers. Alert on both fields. A release canary still requires completed buyback
evidence before archival even though an operational buyback outage cannot take mining offline.

Every prepare, prebind, entropy-lock or settlement deadline violation is also written to
`/data/round-deadline-incidents.json` with an atomic file write, file fsync, rename and directory
fsync. An active incident keeps live `ready` and `/healthz.ok` false across process and deployment
restarts even if the affected Round later settles. Standby and observe mode neither load nor alter
this live transaction-worker latch.

## Railway layout

- Project: `MYNE-Production`
- Service: `myne-protocol-workers`
- Container: root `Dockerfile.workers`
- Persistent volume: `/data`
- Health check: `/healthz`
- Restart policy: always, with zero deployment overlap

The container image pins Node by immutable digest, installs only production dependencies, runs as
the unprivileged `node` user and keeps signer files only in a mode-0600 temporary directory. The
buyback journal and per-round server reveal files are the only worker state written to `/data`.
A reveal is persisted and fsynced before its commitment can be submitted; losing that file can
force the public refund path.

## Required Railway variables

Public configuration is listed in `Protocol/worker.env.example`. Set these four sensitive values
only through Railway's encrypted variable interface; never put them in Git, Vercel or build logs:

- `ANCHOR_PROVIDER_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MYNE_RANDOMNESS_KEYPAIR_B64`
- `MYNE_BUYBACK_KEYPAIR_B64`

The two signer values are base64 encodings of the existing 64-byte Solana keypair JSON arrays. They
must resolve to the exact distinct authority addresses already stored in `ProtocolConfig`. They are
required for standby/live validation but are deliberately not read in observe mode.

## Standby deployment

Deploy in standby first. A healthy standby deployment proves the host, storage, network, IDL,
configuration and secrets agree while the protocol remains paused. It is not authorization to
activate Mainnet.

```bash
railway up --service myne-protocol-workers --environment production --detach
railway logs --service myne-protocol-workers --environment production
```

The expected readiness log is:

```text
{"event":"worker-host-ready","mode":"standby",...}
```

## Paused projection catch-up

After applying every migration through
`20260808135000_wallet_round_history.sql`, authorize the read/project-only process with the exact
program acknowledgement:

```text
MYNE_WORKER_MODE=observe
MYNE_WORKER_HOST_OBSERVE=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e
ROUND_INDEXER_START_SLOT=<recorded program deployment slot>
REFERRAL_INDEXER_START_SLOT=<slot at or before the first MinerRegistered event>
OBSERVE_PROJECTION_FRESHNESS_MS=30000
```

The expected host log has `"mode":"observe"`; the only `worker-started` event must name
`round-indexer` with `"mode":"project-only"`. Treat any transaction signature emitted in this mode
as a stop condition.

Do not call the projection caught up until all of the following are recorded from service-role
queries and finalized Solana reads:

- `/healthz` reports `ok: true`, `mode: "observe"`, `protocolPaused: true`, and the round-indexer
  reports a fresh heartbeat/completion, `lastOutcome: "ok"`, zero consecutive errors and a recent
  successful tick within `OBSERVE_PROJECTION_FRESHNESS_MS`;
- the stable `${programId}:rounds:v2` and `${programId}:rounds:v2:referrals:v1` cursors are at the
  latest finalized transaction for the program (the older endpoint-keyed cursor rows are not used);
- the `${programId}:rounds:v2:historical-gaps:v1` cursor completes one full bounded pass and wraps
  through zero, with no `round-reconciliation-error` or `partial-error:*` tick;
- every retained terminal/nonterminal Round in the recovery window has the expected row, and each
  terminal row has `projection_complete=true`; the database digest matches all 25 tile amounts,
  all 25 receipt counts and the on-chain total/processed/closed counters; and
- there is no stale unresolved database row for a finalized settled Round and no incomplete row in
  the two-round canary window.

An old cursor, one successful process start, or a public page that merely looks current is not
catch-up evidence. Keep mining paused and observe mode running until all checks pass.

## Controlled live transition

Do not change to live mode until the independent review, release evidence, migrations, paused
provider/Meteora rehearsal, legal gate and projection catch-up in `MAINNET_LAUNCH_RUNBOOK.md` are
complete. Set the recorded deployment start slots and authorize live workers while the protocol is
still paused. Only then may the two-round resume canary begin:

```text
MYNE_WORKER_MODE=live
MYNE_WORKER_HOST_LIVE=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e
ROUND_INDEXER_START_SLOT=<recorded program deployment slot>
REFERRAL_INDEXER_START_SLOT=<slot at or before the first MinerRegistered event>
MYNE_FIRST_SERVER_ROUND_ID=<reviewed first managed round>
SERVER_RANDOMNESS_STATE_DIR=/data/server-randomness
SERVER_RANDOMNESS_KEEPER_LIVE=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e
ROUND_ACCOUNT_RETENTION_SECONDS=130
```

Live mode starts the round indexer, lifecycle keeper, buyback keeper and the configured
randomness keeper. In server mode each scheduled round is opened and bound during the bounded
60-second preparation lead, but neither manual nor Auto Mine wagers are accepted before the
scheduled `opened_at`; the complete `[opened_at, betting_ends_at)` interval remains 60 seconds.
Each persistent loop exits on an error so the supervisor can restart it with bounded backoff.
The indexer and lifecycle loops also terminate any cycle that exceeds their configured watchdog
deadline (120 seconds by default), then resume from their durable cursor in a fresh child process.
Confirmed-program WebSocket notifications are debounced for 750 milliseconds before the next
cycle; the normal polling interval remains the fallback if WebSocket delivery is interrupted.
Lifecycle recovery processes a fair maximum of 12 rounds per cycle by default, preventing an old
backlog from exhausting the shared RPC allowance or delaying current reward processing.
Settlement and reward accrual are immediate, but `ROUND_ACCOUNT_RETENTION_SECONDS=130` delays
settled Round/receipt closure long enough for two 60-second round cycles of direct-chain winner and
miner-card recovery.

Server mode commits a secret before betting, locks a future Solana SlotHashes entry only after
betting closes, and publishes the reveal during settlement. It cannot select a known winning tile
before bids under the documented Solana assumptions, but it can withhold a reveal and force
refunds. Alert on a missing pre-opened round, missing entropy lock, missed reveal, or any keeper
restart.

Keep one replica only. The database lease protects buyback execution, but a second replica adds no
availability benefit until replica coordination for every worker is independently reviewed.

## Incident response

1. Pause the protocol on-chain.
2. Change `MYNE_WORKER_MODE` to `observe` with the exact `MYNE_WORKER_HOST_OBSERVE` acknowledgement,
   so projection/reconciliation continue while every transaction-producing worker is fenced.
3. Preserve Railway logs, `/data/buyback-state.json` and `/data/server-randomness/` before any
   recovery action.
4. Reconcile the last finalized round, indexed event cursor, buyback signature and archive proof.
5. Rotate an operational wallet only through the paused, reviewed on-chain rotation instruction.
6. Resume only after the full observe-mode catch-up and two-canary gate pass again with documented
   sign-off.

Never delete or edit `round-deadline-incidents.json` manually. After the protocol is paused and one
specific incident has been reconciled, copy its complete `id` from `/healthz.roundDeadlineIncidents`
into `MYNE_CLEAR_ROUND_DEADLINE_INCIDENT`. A live-host restart accepts that exact acknowledgement
only while the on-chain config remains paused, records the clearance durably and logs
`round-deadline-incident-cleared`. A typo or unknown id fails startup; an acknowledgement for an
already-cleared incident is idempotent across an automatic restart and cannot clear a later
recurrence because each recurrence has a new id. Remove the acknowledgement variable after the
clearance log is captured, then repeat the normal paused health and canary gates. There is no
automatic age-, settlement- or restart-based clearance.
