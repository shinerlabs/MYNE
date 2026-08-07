# MYNE deployment summary

## Current deployment

- Live site: https://www.myne.supply
- Current public network: Solana devnet (pre-launch; keep this unchanged until Mainnet state is deployed and verified)
- Frontend: `Frontend/` (Vite)
- Hosting: Vercel project `myne-upph`
- Supabase project: `tfyvarplanptbknnqzwn`

The production build is deployed directly from the repository workspace. GitHub Desktop can
push this commit to `main`; the connected Vercel project will then build from GitHub as usual.

## Frontend configuration

Set these Vercel variables for Preview and Production deployments:

```text
VITE_SOLANA_CLUSTER=devnet
VITE_SOLANA_RPC_URL=https://api.devnet.solana.com
VITE_MYNE_PROGRAM_ID=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e
VITE_MYNE_MINT_ADDRESS=83LAMprbD2WJV6Yd4gDbxR1ex2dZchjEcPXjhNp9ntHb
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

## Verification before devnet testing

The currently deployed Devnet state predates version 6. Do not treat the public UI or the old
deployment as validation of the new receipt lifecycle; perform a controlled migration or fresh
version-6 rehearsal first. Only a compatible paused version-5 config may use the reviewed one-way
fee-schedule migration.

1. In `Frontend/`, run `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm build`.
2. In `Protocol/`, install with the frozen lockfile and run the local validator, Anchor and policy
   suites documented in `Protocol/README.md`.
3. Confirm the official Meteora pool registration and minimum reserves.
4. Confirm the deployed program and mint addresses match the Vercel variables.
5. Connect a devnet wallet, place a test bid, and verify round history, previous-round miners,
   staking rewards, referral accounting, and chat/profile flows.

Before Mainnet, apply all Supabase migrations (`20260807090000_round_index.sql`,
`20260807114500_round_fee_audit.sql`, `20260807130000_round_archive_verification.sql` and
`20260807131500_keeper_leases.sql`, then `20260807133000_referral_read_model_v1.sql`), rebuild and
synchronize both IDLs, record a fresh SBF hash,
and repeat the full Rust, Anchor/local-validator, keeper-policy and frontend test suites. Prior
version-5 hashes and test output are historical only.
