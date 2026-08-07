# MYNE Supabase boundary

Supabase provides a rebuildable, read-only projection of finalized Solana
events and the wallet-authenticated social layer. It is not authoritative for
mining, staking, balances, payouts, referral ownership, or protocol state.

## Wallet-only chat

Migration `20260807140000_wallet_chat_hardening.sql` is the wallet-only chat
cut-over. Apply it immediately before deploying the matching Edge Functions.
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

wallet_mined_round_count(
  p_wallet_address text
) -> bigint
```

Valid rate-limit actions are `solana_nonce`, `solana_verify`, `chat_send`,
`chat_react`, `chat_reactions`, `chat_delete`, and `profile_update`. The rate
limit RPC increments the wallet and IP buckets in one database transaction.
The nonce RPC consumes a challenge with one conditional update, so concurrent
verification attempts cannot both succeed. Mined-round eligibility counts
distinct, resolved rounds in the indexed on-chain read model.

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
3. Apply all pending migrations, including the wallet-only cut-over.
4. Deploy all matching Edge Functions with the MYNE origin allowlist.
5. Confirm an old token and old nonce are rejected.
6. Sign a fresh wallet challenge, send/react/delete as the appropriate roles,
   and verify direct anonymous writes fail.
7. Re-enable the chat UI only after the smoke test passes.

Periodically delete expired `auth_nonces` and rate-limit buckets older than the
largest configured window. That cleanup is operational housekeeping and must
run with the service role; the public roles have no access to either table.
