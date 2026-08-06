# Devnet testing runbook

The mining, staking, referral, claim, and auto-round bundles are implemented for local and Devnet
testing. Devnet uses the Switchboard Devnet provider mode and intentionally does not require a
Meteora pool, so the full mining/staking flow can be exercised without liquidity. The program
still starts paused and must be explicitly unpaused by the admin. The 2% buyback allocation is
accounted for on-chain, but the buyback keeper skips swaps until a pool is registered.

Mainnet remains pool-gated: the official Meteora pool must be created and registered before
activation or settlement.

For a Devnet pool-backed buyback rehearsal, register it with the admin wallet only after independently checking its
MYNE/SOL vault mints and reserves:

```bash
ANCHOR_PROVIDER_URL=<helius-devnet-rpc> \
ANCHOR_WALLET=.localnet/test-wallet.json \
METEORA_POOL=<official-pool-address> \
METEORA_POOL_PROGRAM=<official-meteora-program-id> \
METEORA_MYNE_VAULT=<official-myne-vault-address> \
METEORA_SOL_VAULT=<official-wsol-vault-address> \
MIN_LIQUIDITY_SOL_LAMPORTS=100000000 \
MIN_LIQUIDITY_MYNE_BASE_UNITS=10000000000 \
pnpm run devnet:register-liquidity
```

The registration script is fail-closed if the exact account is absent, is not owned by the
canonical Meteora DLMM program, or its MYNE/WSOL vault balances are below threshold. It does not
create a pool or move funds. Activation and every verified round settlement re-check the exact
pool, vault addresses, mints and balances before moving the 2% buyback/burn allocation. If the
account or reserves are invalid, activation or settlement fails closed.

## What has been verified locally

The local validator suite loads the program as upgradeable with the configured wallet as upgrade
authority. The integration test then proves:

- only the deployed program's upgrade authority can initialize the config PDA;
- the mint has 9 decimals, exactly 100 MYNE, no freeze authority, and the config PDA as mint authority;
- the 2,000,000 MYNE cap and timing/economic constants are stored exactly;
- pause changes require the admin signer;
- admin ownership transfers through propose/accept and the former admin loses access.
- multiple manual receipts and one balance-funded auto-plan can deploy into the same round;
- Split settlement, per-receipt SOL/MYNE claims, the 12% mining allocation and the 10% claim fee;
- standard staking and both operator-funded and mining-funded SOL reward distribution.
- the local staking smoke stakes MYNE, funds SOL, claims it, and verifies principal, weight,
  token-balance, and pool-account deltas.

## Preflight

From `Protocol/`, with the installed Rust, Solana, Anchor, Node and pnpm tools on `PATH`:

```bash
./scripts/check-devnet-readiness.sh
cargo audit
pnpm run test:local:staking
solana config set --url devnet
solana balance .localnet/test-wallet.json
```

The committed configuration pins Anchor CLI/crates, Solana CLI, the program ID and lockfiles. The
`.localnet` wallet is ignored and suitable only for local/devnet testing. Back it up before a deploy;
never use it as a mainnet authority.

Run the frontend checks separately from `Frontend/`:

```bash
pnpm test
pnpm build
```

## Deploy and initialize

Deployment and initialization spend devnet SOL and are intentionally not performed by the readiness
script. Fund the test wallet through the official faucet or CLI, verify its address, then deploy:

```bash
solana address -k .localnet/test-wallet.json
anchor deploy --provider.cluster devnet --provider.wallet .localnet/test-wallet.json
```

Initialize with the guarded, resumable script only after confirming all of these values:

- program: `D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e`;
- upgrade authority: the intended devnet operations wallet;
- mint supply: `100000000000` base units (100 MYNE at 9 decimals);
- mint authority: config PDA derived from seed `config`;
- freeze authority: none;
- randomness authority: a non-default devnet key controlled by the test team.

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=.localnet/test-wallet.json \
DEVNET_RANDOMNESS_AUTHORITY=<DEVNET_PUBLIC_KEY> \
CONFIRM_DEVNET_INITIALIZE=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e \
pnpm run devnet:initialize
```

The initializer verifies the devnet genesis hash and upgrade authority before submitting anything.
It persists an ignored `.localnet/devnet-mint.json` so an interrupted mint setup can be resumed
without producing a different mint. It exits without mutation when the config already exists.

Do not reuse `tests/local-protocol.mjs` on devnet: it deliberately rotates admin to an ephemeral key
to test authorization. After initialization, run the read-only smoke test instead:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=.localnet/test-wallet.json \
pnpm run test:devnet:smoke
```

For the viewer, set `VITE_SOLANA_RPC_URL=https://api.devnet.solana.com` in `Frontend/.env.local`,
restart Vite, and open `/local.html`.

## Controlled Devnet demo keeper

After the admin wallet has been deliberately funded with Devnet SOL, the demo keeper can create
ten ephemeral miners and three ephemeral stakers, deploy randomized demo amounts, and settle
rounds. It is guarded against accidental use on any non-local/non-Devnet endpoint and requires an
explicit program-id confirmation:

```bash
ALLOW_DEVNET_KEEPER=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e \
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=.localnet/test-wallet.json \
pnpm run local:keeper
```

The public Devnet faucet can be rate-limited or empty. Do not substitute mainnet funds; use only
ephemeral wallets and Devnet SOL for this demo.

## Stop conditions

Do not continue if the program ID, upgrade authority, mint, config PDA, supply, decimals, or freeze
authority differs from the expected value. Do not unpause this milestone. Before implementing value
movement, resolve the randomness source, round settlement invariants, liquidity-tax destination,
oracle failure behavior, and production authority/governance model, then perform a dedicated audit.
