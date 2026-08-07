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

## Verification before devnet testing

The currently deployed Devnet state predates version 5. Do not treat the public UI or the old
deployment as validation of the new receipt lifecycle; perform a controlled migration or fresh
version-5 rehearsal first.

1. Run `pnpm install` and `pnpm --dir Frontend build`.
2. Run the local validator and Anchor tests from `Protocol/`.
3. Confirm the official Meteora pool registration and minimum reserves.
4. Confirm the deployed program and mint addresses match the Vercel variables.
5. Connect a devnet wallet, place a test bid, and verify round history, previous-round miners,
   staking rewards, referral accounting, and chat/profile flows.
