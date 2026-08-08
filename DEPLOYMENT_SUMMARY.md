# MYNE deployment summary

## Current deployment

- Live site: https://www.myne.supply
- Current public network: Solana Mainnet beta
- Program: `D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e` (version 6, deployed and paused)
- MYNE mint: `BcpJWJpL82D8qdcdb1RoP3TAfD3TKL9fJkpvHw1QWUWt`
- Registered Meteora DAMM v2 pool: `7r1Y2qbKLbh1Tyopta86BYBe4aX5M1ucKN6n4G6ZqBZN`
- Frontend: `Frontend/` (Vite)
- Hosting: Vercel project `myne-upph`
- Supabase project: `tfyvarplanptbknnqzwn`
- Production workers: Railway project `MYNE-Production`, service `myne-protocol-workers`
  (service retained, runtime intentionally stopped during the emergency pause)

The production build is deployed directly from the repository workspace. GitHub Desktop can
push this commit to `main`; the connected Vercel project will then build from GitHub as usual.

## Frontend configuration

Set these Vercel variables for Preview and Production deployments:

```text
VITE_SOLANA_CLUSTER=mainnet-beta
VITE_SOLANA_RPC_URL=<restricted public Mainnet browser RPC>
VITE_MYNE_PROGRAM_ID=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e
VITE_MYNE_MINT_ADDRESS=BcpJWJpL82D8qdcdb1RoP3TAfD3TKL9fJkpvHw1QWUWt
VITE_SUPABASE_URL=https://tfyvarplanptbknnqzwn.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable Supabase key>
```

Never commit a service-role key, wallet secret, or private RPC credential. The public Supabase
key is protected by database RLS and Edge Function authorization.

## Protocol activation

The `LiquidityGate` is the single activation latch. The protocol remains paused until the
registered MYNE/SOL Meteora pool passes the configured ownership and reserve checks. A successful
unpause starts mining, staking, referrals, emissions, and buyback accounting together. Settlement
re-checks the gate before applying the buyback/burn allocation.

Protocol version 6 charges exactly 12% of gross round deployment: 8% gross staking, split into 0.8%
direct admin and 7.2% net staker rewards; 2% Motherlode; 1% buyback/burn; and 1% direct admin. The
admin receives 1.8% directly before the documented integer-dust adjustment. The admin, randomness
and buyback addresses must be three distinct controlled funded roles.

## Verification before Mainnet activation

The deployed Mainnet program is intentionally paused. A healthy website, pool and standby worker
host are necessary launch evidence, but they are not authorization to unpause. Follow the exact
artifact, independent-review, canary, service and legal gates in
`Protocol/docs/MAINNET_LAUNCH_RUNBOOK.md`.

1. In `Frontend/`, run `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm build`.
2. In `Protocol/`, install with the frozen lockfile and run the local validator, Anchor and policy
   suites documented in `Protocol/README.md`.
3. Confirm the exact registered Meteora pool, decoded vaults and minimum reserves.
4. Confirm the deployed program and mint addresses match the Vercel variables.
5. Keep Railway in standby until the independent review and controlled canary are signed off.
   The hosting and incident procedure is in `Protocol/docs/WORKER_HOSTING.md`.

Before Mainnet, apply all Supabase migrations (`20260807090000_round_index.sql`,
`20260807114500_round_fee_audit.sql`, `20260807130000_round_archive_verification.sql`,
`20260807131500_keeper_leases.sql`, `20260807133000_referral_read_model_v1.sql`,
`20260807140000_wallet_chat_hardening.sql`,
`20260807141000_wallet_validator_lint_cleanup.sql`, and
`20260807142000_chat_admin_provisioning.sql`,
`20260808090000_server_randomness_proofs.sql`,
`20260808113000_burn_stats.sql`,
`20260808120000_receipt_reward_accrual.sql`, and
`20260808123000_empty_round_stats.sql`, and
`20260808124500_keeper_lease_privileges.sql`), rebuild and
synchronize both IDLs, record a fresh SBF hash,
and repeat the full Rust, Anchor/local-validator, keeper-policy and frontend test suites. Prior
version-5 hashes and test output are historical only.
