# Production worker hosting

The MYNE production workers run on one managed Railway service named
`myne-protocol-workers`. Railway is the always-on Linux host: no server administration is required
from the protocol administrator.

## Safety model

The service defaults to `MYNE_WORKER_MODE=standby`. Standby verifies all of the following every 30
seconds, but never starts a transaction-producing worker:

- Solana Mainnet genesis and Switchboard Mainnet configuration;
- the exact MYNE program and mint;
- protocol version 6 and the configured operational public keys;
- the verified, non-default Meteora liquidity gate;
- the protocol remains paused;
- authenticated access to the production round index.

The service exposes only `/healthz`; its response contains mode, revision and worker state, never
credentials, RPC URLs or wallet addresses.

## Railway layout

- Project: `MYNE-Production`
- Service: `myne-protocol-workers`
- Container: root `Dockerfile.workers`
- Persistent volume: `/data`
- Health check: `/healthz`
- Restart policy: always, with zero deployment overlap

The container image pins Node by immutable digest, installs only production dependencies, runs as
the unprivileged `node` user and keeps signer files only in a mode-0600 temporary directory. The
buyback journal is the only worker state written to `/data`.

## Required Railway variables

Public configuration is listed in `Protocol/worker.env.example`. Set these three sensitive values
only through Railway's encrypted variable interface; never put them in Git, Vercel or build logs:

- `ANCHOR_PROVIDER_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MYNE_RANDOMNESS_KEYPAIR_B64`
- `MYNE_BUYBACK_KEYPAIR_B64`

The two signer values are base64 encodings of the existing 64-byte Solana keypair JSON arrays. They
must resolve to the exact distinct authority addresses already stored in `ProtocolConfig`.

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

## Controlled live transition

Do not change to live mode until the independent review, release evidence, migrations, real
Switchboard/Meteora canary and legal gate in `MAINNET_LAUNCH_RUNBOOK.md` are complete. Then set the
recorded deployment start slots, and only as the final service authorization set:

```text
MYNE_WORKER_MODE=live
MYNE_WORKER_HOST_LIVE=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e
ROUND_INDEXER_START_SLOT=<recorded program deployment slot>
REFERRAL_INDEXER_START_SLOT=<slot at or before the first MinerRegistered event>
```

Live mode starts the round indexer, Switchboard round keeper, lifecycle keeper and buyback keeper.
Each persistent loop exits on an error so the supervisor can restart it with bounded backoff. The
Switchboard keeper is intentionally one-shot and is relaunched by the supervisor.

Keep one replica only. The database lease protects buyback execution, but a second replica adds no
availability benefit until replica coordination for every worker is independently reviewed.

## Incident response

1. Pause the protocol on-chain.
2. Change `MYNE_WORKER_MODE` back to `standby`.
3. Preserve Railway logs and `/data/buyback-state.json` before any recovery action.
4. Reconcile the last finalized round, indexed event cursor, buyback signature and archive proof.
5. Rotate an operational wallet only through the paused, reviewed on-chain rotation instruction.
6. Resume only after a fresh standby health check and documented sign-off.
