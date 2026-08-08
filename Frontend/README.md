# MYNE protocol frontend

The public web interface for MYNE on Solana. It is a Vite-powered, framework-free
JavaScript application covering mining, staking, swapping, referrals, round history,
protocol documentation, wallet connection and the optional social layer.

## Local development

Requirements: Node.js 22.12+ and pnpm 11.9.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

The app is then available at `http://127.0.0.1:5173`. Chat and profiles disable cleanly when
Supabase is absent; Mainnet transaction readiness also requires the indexed round read model.

The development-only Solana status viewer is available at `http://127.0.0.1:5173/local.html`. It
reads the program and config PDA directly from `VITE_SOLANA_RPC_URL` (local validator by default)
and is deliberately excluded from the production bundle.

The main app loads the generated Anchor IDL, validates the live config PDA, synchronizes its round
clock from the on-chain initialization time, and reads live round receipts for its miner roster.
Run `pnpm run sync:solana` after every Anchor build that changes the IDL. Feature controls are
derived fail-closed from the generated instruction list. Protocol configuration is intentionally
not exposed as a badge on the public UI.

`VITE_AUTO_REINVEST_SOL` is an explicit post-upgrade release gate. Leave it
`false` while publishing client code or upgrading workers; set it to `true`
only after the new program instruction and database migration are live and a
worker canary has passed. Fixed/Max Auto-round funding and ordinary Auto Mine
do not depend on this flag.

Only public browser values may use the `VITE_` prefix. Never place a private key, Supabase
service-role key or other server secret in this directory.

## Commands

```bash
pnpm dev            # local Vite server
pnpm test           # frontend regression suite
pnpm build          # production bundle
```

Generated staking PDFs and previews are written to `output/` and `tmp/`; both are ignored.

## Structure

- `src/main.js` renders routes and coordinates page interactions.
- `src/app-config.js` is the single source for product identity, Solana cluster and program IDs.
- `src/chain/` contains the Solana wallet, lamport units and generated Anchor client boundary.
- `src/social/` contains Solana message-signing chat, profiles, follows and sticker loading.
- `src/style.css` contains the base system; compact route styles and the final shared brand rules
  live in the adjacent route CSS files.
- `public/` contains static brand, token and chat assets.

## Release checks

Before publishing:

1. Run `pnpm build` and resolve every build warning or error.
2. Test Mine, Stake, Swap, Referrals, Rounds and About without a wallet and with a wallet.
3. Confirm the Solana program/indexer resolves rounds and the Supabase Edge Functions are reachable.
4. Confirm program ID, SPL mint, cluster, RPC and explorer values match the intended deployment.

Round timing is fixed at 65 seconds: 60 seconds for bidding, then 5 seconds displaying the
confirmed winning tile. Settlement is eligible immediately at the bidding boundary.
Mining, staking, referrals, claims, and funded auto-round controls use the live Anchor program.
Swaps remain fail-closed until the target cluster has a configured Meteora pool. The sibling
`../Protocol` directory contains the Solana program, keeper, tests, and deployment guidance.

## Social layer

Social requests use the deployed Supabase Edge Functions. During development Vite proxies
`/supabase/*` to the configured Supabase project; production uses the HTTPS project URL directly.

Sticker and reply metadata uses the escaped `\u001f` marker in message bodies. Keep it escaped in
source code; a literal control character is invisible and breaks existing message parsing.
