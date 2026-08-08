# MYNE Supabase boundary

Supabase provides a rebuildable, read-only projection of finalized Solana
events and the wallet-authenticated social layer. It is not authoritative for
mining, staking, balances, payouts, referral ownership, or protocol state.

Migration `20260808090000_server_randomness_proofs.sql` adds the provider-aware
round proof fields and the indexed buyback backlog. Apply it before enabling
the server commit-reveal worker. It preserves existing Switchboard columns and
v2 archive hashes; server commitments are hex evidence, never account links,
and server target/entropy slots use unsigned-safe `numeric(20,0)` columns.

Migration `20260808113000_burn_stats.sql` adds the constant-size public read
model used by the Rounds and About UIs for completed buyback burns. Apply it
before deploying a frontend that imports `chain/burn-index.js`; that frontend
fails closed and leaves burn totals unavailable when the view is absent. The
UI adds this indexed total to the on-chain `StakePool.total_burn`, which covers
manual Stake + Burn, Auto-burn, and Motherlode burn-stake principal.

Migration `20260808120000_receipt_reward_accrual.sql` adds the `accrued`
receipt status used by the claim-vault release. Historical `claimed` rows keep
their original meaning: SOL was already paid directly. New `accrued` rows mean
the receipt is processed and its SOL is held in the on-chain StakePool claim
vault until the wallet owner signs Claim SOL or Claim All. Apply this migration
before starting an indexer that handles `ReceiptRewardAccruedV1`.

Migration `20260808123000_empty_round_stats.sql` keeps resolved zero-bid rounds
and their published winning tiles in the ledger while excluding them from
mined-round and Motherlode-award counts. Apply it with the claim-vault release
before deploying the matching frontend.

Migration `20260808124500_keeper_lease_privileges.sql` explicitly removes
keeper-lease RPC access from `public`, `anon`, and `authenticated`, leaving
only `service_role`. Apply it before starting any production keeper and require
the Supabase security advisor to report no public SECURITY DEFINER access.

Migration `20260808130000_round_realtime.sql` publishes only the public
`mine_rounds` read model through Supabase Realtime. Apply it before deploying
the event-driven frontend. Private receipt settlements, keeper leases, and
indexer cursors remain unpublished; the existing timed reads remain a recovery
path if Realtime is unavailable.

Migration `20260808133000_worker_schema_capabilities.sql` records the historical
`server-claims-v1` capability. Migration
`20260808134500_round_projection_completeness.sql` then adds the 25-tile/counter
digest, monotonic finalized source slot and projection health fields before it
atomically replaces the service-role-only marker with `round-projection-v2`.
Both the worker host and standalone round indexer require that final value, so
an older or partially migrated database cannot look healthy.

Migration `20260808135000_wallet_round_history.sql` must follow it. The
service-role-only RPC decorates at most 50 projection-complete historical rows
for the signed wallet. The matching `wallet-round-history` Edge Function takes
the wallet only from the verified session; browser callers cannot enumerate a
different wallet or use this display projection as claim authority.

Migration `20260808140000_auto_plan_sol_reinvestment.sql` widens only the
AutoPlan projection's composite reward mode from `0..1` to `0..3`. Bit 0 keeps
the existing MYNE accumulate/burn policy and bit 1 records owner consent to
reinvest all claimable SOL. Bet receipt reward modes remain strictly `0..1`.
Apply it before starting a worker that discovers reinvest-enabled plans.

## Wallet-only chat

Migration `20260807140000_wallet_chat_hardening.sql` is the wallet-only chat
cut-over. Apply it immediately before deploying the matching Edge Functions.
Apply `20260807141000_wallet_validator_lint_cleanup.sql` immediately afterward,
then `20260807142000_chat_admin_provisioning.sql` to install the service-role-only
moderator provisioning function.
The migration deliberately:

- rotates the global chat session epoch, invalidating every existing session;
- deletes every outstanding authentication nonce;
- deletes guest/null and malformed-wallet messages and malformed-wallet social
  records;
- removes `chat_feed.guest_id` and makes `chat_feed.wallet_address` required;
- requires message, reaction, and administrator wallets to have a profile row;
- removes direct browser mutation privileges and non-read RLS policies; and
- stores rate-limit identifiers only as SHA-256 hashes.

Public clients retain policy-controlled reads of `chat_feed`,
`chat_reactions`, and `profiles`. Only the Supabase `service_role` used inside
the Edge Functions can mutate social data or execute the security RPCs. Never
place that key in the browser or a `VITE_*` variable.

The Edge Functions and migration are one security release. Deploying only one
side fails closed and will make chat authentication unavailable; do not restore
guest mode as a workaround.

Set `CHAT_REQUIRE_MYNE_BALANCE=true` on `chat-send` to require at least 0.01
MYNE (10,000,000 base units). The server verifies and adds every eligible form:

- liquid MYNE in the wallet's SPL token accounts;
- effective unclaimed mining rewards from the v6 asset/share ledger;
- standard staked MYNE;
- permanently burned Stake + Burn MYNE; and
- MYNE currently in the unstaking cooldown.

This is an on-chain eligibility check, not a browser claim. Set the server-only
`CHAT_SOLANA_RPC_URL` to a restricted HTTPS Mainnet RPC. The function pins the
Mainnet genesis, production program, production mint, PDA owners,
discriminators, wallet authorities, and token-account layouts before accepting
the balance. `CHAT_MYNE_PROGRAM_ID`, `CHAT_MYNE_MINT_ADDRESS`, and
`CHAT_SOLANA_GENESIS_HASH` exist only for explicit loopback testing and are
rejected when the RPC is not loopback.
Successful wallet snapshots are cached for ten seconds; failures are not.

For one release, an existing `CHAT_REQUIRE_MINED_ROUNDS=true` setting also
enables this new balance rule, so production fails safely during the variable
rename. Replace it with `CHAT_REQUIRE_MYNE_BALANCE=true`; round count no longer
controls chat access.

Production CORS origins are built into the functions as `https://myne.supply`
and `https://www.myne.supply`. Local browser testing is disabled unless
`MYNE_CORS_LOCAL_ORIGINS` explicitly lists comma-separated loopback origins,
for example
`http://127.0.0.1:5173,http://localhost:5173`. The optional
`CHAT_SESSION_SECRET` and `RATE_LIMIT_HASH_SECRET` function secrets separate
session signing and rate-limit pseudonyms from the Supabase service-role key;
both currently fail over to that server-only key when unset. Set independent,
random production values before launch and never expose them to the browser.

All seven custom-wallet endpoints are declared with `verify_jwt = false` in
`config.toml`. That setting does not make them anonymous: each handler applies
the origin guard, rate limit, and (where required) MYNE wallet session itself.
For local fallback use `supabase functions serve --no-verify-jwt` (or the
equivalent per-function command). Production deployment must preserve
`config.toml`; if a deployment invocation bypasses it, pass `--no-verify-jwt`
explicitly or the platform JWT layer will reject MYNE's custom signed sessions
before the handlers can validate them.

## Service-role RPC contract

The wallet Edge Functions use these exact PostgreSQL functions:

```sql
current_chat_session_epoch() -> uuid

is_chat_session_current(
  p_session_epoch uuid,
  p_wallet_address text
) -> boolean

consume_solana_nonce(
  p_wallet_address text,
  p_nonce text,
  p_message text,
  p_purpose text -- must be 'chat_session'
) -> boolean

enforce_chat_rate_limit(
  p_wallet_address text, -- nullable only for the public reactions read
  p_ip_hash text,        -- lowercase 64-character SHA-256 hex
  p_action text,
  p_limit integer,
  p_window_seconds integer
) -> jsonb               -- allowed, remaining, retry_after_seconds

wallet_mined_round_count( -- retained for legacy analytics; not chat eligibility
  p_wallet_address text
) -> bigint
```

Valid rate-limit actions are `solana_nonce`, `solana_verify`, `chat_send`,
`chat_react`, `chat_reactions`, `chat_delete`, and `profile_update`. The rate
limit RPC increments the wallet and IP buckets in one database transaction.
The nonce RPC consumes a challenge with one conditional update, so concurrent
verification attempts cannot both succeed. The mined-round RPC remains an
indexed analytics helper and is no longer an authorization decision.

Every authenticated request must call `is_chat_session_current`; a missing or
stale epoch, missing profile, invalid wallet, or banned profile returns false.
This makes a ban effective without waiting for the signed token to expire.

## Local database verification

With the Supabase CLI and Docker installed:

```bash
supabase db reset
supabase test db
```

The pgTAP policy and behavior checks live in
`tests/wallet_chat_hardening.sql`. They cover privileges, nonce replay,
wallet/IP rate limits, resolved-round counting, epoch validation, and immediate
ban enforcement.

## Production cut-over

1. Back up the social tables and record the current row counts.
2. Put chat writes into maintenance mode.
3. Apply all pending migrations, including the wallet-only cut-over, validator cleanup, chat
   administrator provisioning, and the final `mine_worker_schema_capabilities` release marker in
   timestamp order. The production worker host refuses to start until the marker is readable by
   `service_role`; this prevents a healthy-looking worker from running against a partial schema.
4. Deploy all matching Edge Functions with the MYNE origin allowlist, including
   `wallet-round-history`. Its custom signed-wallet session is mandatory even
   though Supabase gateway JWT verification is disabled; the service-only RPC
   must remain revoked from `public`, `anon`, and `authenticated`.
5. Provision moderators with the guarded `Protocol` command. Keep wallet addresses in ignored
   operational configuration, dry-run first, then require exact confirmation:

   ```bash
   CHAT_ADMIN_WALLET=<reviewed-wallet> pnpm --dir Protocol chat:admin
   CHAT_ADMIN_WALLET=<reviewed-wallet> \
   CONFIRM_CHAT_ADMIN_WALLET=<reviewed-wallet> \
   APPLY_CHAT_ADMIN=1 \
   SUPABASE_URL=<exact-project-url> \
   SUPABASE_SERVICE_ROLE_KEY=<server-only-key> \
   pnpm --dir Protocol chat:admin
   ```

6. Confirm an old token and old nonce are rejected.
7. Sign a fresh wallet challenge, send/react/delete as the appropriate roles,
   and verify direct anonymous writes fail.
8. Re-enable the chat UI only after the smoke test passes.

Periodically delete expired `auth_nonces` and rate-limit buckets older than the
largest configured window. That cleanup is operational housekeeping and must
run with the service role; the public roles have no access to either table.
