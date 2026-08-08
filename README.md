# MYNE

MYNE is a Solana mining and staking protocol with a Vite web client, an Anchor program,
permissionless receipt processing into owner-controlled reward balances, provider-aware
commit–reveal randomness, and a rebuildable Supabase index.

> **Pre-launch software:** the repository is under active review. No Mainnet deployment should be
> treated as approved until the launch runbook is complete and an independent Solana security
> review has been resolved. Do not use real funds based only on local or Devnet results.

## Repository

- `Frontend/` — public browser client and frontend regression tests.
- `Protocol/` — Anchor program, keepers, indexer, operational scripts, and protocol documentation.
- `supabase/` — public index/chat schema and wallet-authenticated Edge Functions.
- `DEPLOYMENT_SUMMARY.md` — current public environment and versioned deployment notes.

The historical Ethereum prototype has been removed from the browser client. Trading remains
fail-closed until the canonical MYNE/SOL Meteora integration is configured and reviewed.

Some database columns and internal DOM/storage identifiers retain historical names such as
`*_wei`, `eth`, `gld`, or `bullion` for migration compatibility. They represent SOL lamports or
MYNE base units only; no EVM contract, provider, ABI, or transaction path remains in the client.
Renaming those persisted identifiers requires a versioned data/storage migration rather than an
in-place cosmetic change.

## Frontend development

```bash
cd Frontend
cp .env.example .env
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm dev
```

Only public values belong in `VITE_*` variables. Never commit wallet keypairs, seed phrases,
private RPC credentials, Supabase service-role keys, keeper secrets, or Vercel environment files.

## Protocol development

See [`Protocol/README.md`](Protocol/README.md) and the launch/readiness documents in
[`Protocol/docs/`](Protocol/docs/). The on-chain program is the source of truth; the Supabase index
is a rebuildable read model and must never authorize balances or payouts.

## Verified deployment

The production marker and external release manifest described in the launch runbook are MYNE
provenance controls; they are not a Solana verified build and they are not a security audit. After
the final source is committed to this public repository, the Mainnet release must be rebuilt in
Docker with `solana-verify`, that exact executable must be deployed without an intervening rebuild,
and its on-chain hash must be checked and reproduced from the exact public commit. The verification
PDA and remote reproduction job must also complete before the deployment is represented as
verified. See
[`Protocol/docs/MAINNET_LAUNCH_RUNBOOK.md`](Protocol/docs/MAINNET_LAUNCH_RUNBOOK.md) and Solana's
[verified-build documentation](https://solana.com/docs/programs/verified-builds).

## Security

Please follow [`SECURITY.md`](SECURITY.md). Do not disclose exploitable findings in a public issue.

## License

No open-source license is currently granted. The source is visible for protocol transparency and
review only; reuse, redistribution, and derivative works require the copyright holder's written
permission. A counsel-approved license must be selected before presenting this repository as open
source. Third-party names, marks and media remain subject to their respective owners' terms; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the release provenance register and unresolved
asset gates.
