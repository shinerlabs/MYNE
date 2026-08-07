-- Wallet-only chat security boundary.
--
-- Destructive effects (approved for the production chat cut-over):
--   * every outstanding login nonce is deleted;
--   * the global session epoch is rotated, invalidating every existing chat token;
--   * guest/null and malformed-wallet chat data is deleted; and
--   * the retired guest_id column is removed.
--
-- Browser clients retain read-only access to the public feed, reactions and
-- profiles. Every mutation and every security RPC is restricted to the
-- service-role Edge Functions, which authenticate Solana wallet signatures.

create extension if not exists pgcrypto;

-- PostgreSQL has no native Base58 decoder. Decode into an arbitrary-precision
-- integer so database constraints reject Base58-looking strings that do not
-- represent exactly one 32-byte Solana public key.
create or replace function public.is_valid_solana_wallet_address(
  p_wallet_address text
)
returns boolean
language plpgsql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$
declare
  v_alphabet constant text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  v_value numeric := 0;
  v_digit integer;
  v_leading_zero_bytes integer := 0;
  v_value_bytes integer := 0;
begin
  if length(p_wallet_address) < 32
     or length(p_wallet_address) > 44
     or p_wallet_address !~ '^[1-9A-HJ-NP-Za-km-z]+$' then
    return false;
  end if;

  for v_index in 1..length(p_wallet_address) loop
    v_digit := strpos(v_alphabet, substr(p_wallet_address, v_index, 1)) - 1;
    if v_digit < 0 then
      return false;
    end if;
    v_value := (v_value * 58) + v_digit;
  end loop;

  for v_index in 1..length(p_wallet_address) loop
    exit when substr(p_wallet_address, v_index, 1) <> '1';
    v_leading_zero_bytes := v_leading_zero_bytes + 1;
  end loop;

  while v_value > 0 loop
    v_value_bytes := v_value_bytes + 1;
    v_value := trunc(v_value / 256);
  end loop;

  return v_leading_zero_bytes + v_value_bytes = 32;
end;
$$;

create table if not exists public.chat_security_state (
  id smallint primary key default 1 check (id = 1),
  session_epoch uuid not null default gen_random_uuid(),
  rotated_at timestamptz not null default clock_timestamp()
);

-- Applying this cut-over always revokes tokens issued under the previous
-- epoch. Tokens issued after the migration must carry this epoch and verify it
-- through is_chat_session_current on every authenticated request.
insert into public.chat_security_state (id, session_epoch, rotated_at)
values (1, gen_random_uuid(), clock_timestamp())
on conflict (id) do update
set session_epoch = excluded.session_epoch,
    rotated_at = excluded.rotated_at;

alter table public.chat_security_state enable row level security;

create or replace function public.current_chat_session_epoch()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select session_epoch
  from public.chat_security_state
  where id = 1
$$;

-- Outstanding challenges predate the new epoch/purpose checks and cannot be
-- upgraded safely. Deleting them also guarantees that no challenge observed
-- before this migration can mint a post-migration session.
delete from public.auth_nonces;

alter table public.auth_nonces
  add column if not exists purpose text,
  add column if not exists session_epoch uuid,
  add column if not exists created_at timestamptz not null default clock_timestamp();

alter table public.auth_nonces
  alter column purpose set default 'chat_session',
  alter column purpose set not null,
  alter column session_epoch set default public.current_chat_session_epoch(),
  alter column session_epoch set not null;

alter table public.auth_nonces
  drop constraint if exists auth_nonces_wallet_format,
  add constraint auth_nonces_wallet_format
    check (public.is_valid_solana_wallet_address(wallet_address)),
  drop constraint if exists auth_nonces_purpose,
  add constraint auth_nonces_purpose
    check (purpose = 'chat_session'),
  drop constraint if exists auth_nonces_nonce_format,
  add constraint auth_nonces_nonce_format
    check (nonce ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  drop constraint if exists auth_nonces_message_length,
  add constraint auth_nonces_message_length
    check (char_length(message) between 1 and 1024),
  drop constraint if exists auth_nonces_lifetime,
  add constraint auth_nonces_lifetime
    check (
      expires_at > created_at
      and expires_at <= created_at + interval '10 minutes'
    ),
  drop constraint if exists auth_nonces_used_after_creation,
  add constraint auth_nonces_used_after_creation
    check (used_at is null or used_at >= created_at);

create index if not exists auth_nonces_expiry_idx
  on public.auth_nonces (expires_at);

-- Remove data that cannot be attributed to a valid Solana wallet. Reactions
-- for removed messages are deleted by the existing ON DELETE CASCADE FK.
delete from public.chat_feed
where wallet_address is null
   or not public.is_valid_solana_wallet_address(wallet_address);

delete from public.chat_reactions
where not public.is_valid_solana_wallet_address(wallet_address);

delete from public.chat_admins
where not public.is_valid_solana_wallet_address(wallet_address);

delete from public.profiles
where not public.is_valid_solana_wallet_address(wallet_address);

drop index if exists public.chat_feed_guest_id_idx;
alter table public.chat_feed drop column if exists guest_id;
alter table public.chat_feed alter column wallet_address set not null;

-- A wallet profile is the durable ownership registry for chat rows. Preserve
-- every valid historic wallet before adding the foreign keys.
insert into public.profiles (wallet_address)
select wallet_address from public.chat_feed
union
select wallet_address from public.chat_reactions
union
select wallet_address from public.chat_admins
on conflict (wallet_address) do nothing;

alter table public.profiles
  drop constraint if exists profiles_wallet_format,
  add constraint profiles_wallet_format
    check (public.is_valid_solana_wallet_address(wallet_address));

alter table public.chat_feed
  drop constraint if exists chat_feed_wallet_format,
  add constraint chat_feed_wallet_format
    check (public.is_valid_solana_wallet_address(wallet_address)),
  drop constraint if exists chat_feed_wallet_profile_fk,
  add constraint chat_feed_wallet_profile_fk
    foreign key (wallet_address) references public.profiles(wallet_address)
    on update cascade on delete restrict;

create index if not exists chat_feed_wallet_created_at_idx
  on public.chat_feed (wallet_address, created_at desc);

alter table public.chat_reactions
  drop constraint if exists chat_reactions_wallet_format,
  add constraint chat_reactions_wallet_format
    check (public.is_valid_solana_wallet_address(wallet_address)),
  drop constraint if exists chat_reactions_wallet_profile_fk,
  add constraint chat_reactions_wallet_profile_fk
    foreign key (wallet_address) references public.profiles(wallet_address)
    on update cascade on delete restrict;

alter table public.chat_admins
  drop constraint if exists chat_admins_wallet_format,
  add constraint chat_admins_wallet_format
    check (public.is_valid_solana_wallet_address(wallet_address)),
  drop constraint if exists chat_admins_wallet_profile_fk,
  add constraint chat_admins_wallet_profile_fk
    foreign key (wallet_address) references public.profiles(wallet_address)
    on update cascade on delete restrict;

-- Only the service role can see these hashed fixed-window counters. Raw IP
-- addresses and raw wallet addresses are never stored in this table.
create table if not exists public.chat_rate_limits (
  scope text not null check (scope in ('wallet', 'ip')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  action text not null check (action in (
    'solana_nonce',
    'solana_verify',
    'chat_send',
    'chat_react',
    'chat_reactions',
    'chat_delete',
    'profile_update'
  )),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (scope, key_hash, action)
);

create index if not exists chat_rate_limits_expiry_idx
  on public.chat_rate_limits (window_started_at);

alter table public.chat_rate_limits enable row level security;

create or replace function public.consume_solana_nonce(
  p_wallet_address text,
  p_nonce text,
  p_message text,
  p_purpose text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_consumed integer;
begin
  if p_wallet_address is null
     or not public.is_valid_solana_wallet_address(p_wallet_address)
     or p_nonce is null
     or length(p_nonce) < 16
     or p_message is null
     or length(p_message) = 0
     or p_purpose <> 'chat_session' then
    return false;
  end if;

  update public.auth_nonces as nonce_row
  set used_at = clock_timestamp()
  where nonce_row.nonce = p_nonce
    and nonce_row.wallet_address = p_wallet_address
    and nonce_row.message = p_message
    and nonce_row.purpose = p_purpose
    and nonce_row.used_at is null
    and nonce_row.expires_at > clock_timestamp()
    and nonce_row.session_epoch = public.current_chat_session_epoch();

  get diagnostics v_consumed = row_count;
  return v_consumed = 1;
end;
$$;

create or replace function public.enforce_chat_rate_limit(
  p_wallet_address text,
  p_ip_hash text,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window interval;
  v_wallet_count integer := 0;
  v_ip_count integer := 0;
  v_wallet_started timestamptz;
  v_ip_started timestamptz;
  v_highest_count integer;
  v_allowed boolean;
  v_retry_after integer;
begin
  if p_wallet_address is not null
     and not public.is_valid_solana_wallet_address(p_wallet_address) then
    raise exception using errcode = '22023', message = 'invalid wallet address';
  end if;
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid IP hash';
  end if;
  if p_action is null or p_action not in (
    'solana_nonce',
    'solana_verify',
    'chat_send',
    'chat_react',
    'chat_reactions',
    'chat_delete',
    'profile_update'
  ) then
    raise exception using errcode = '22023', message = 'invalid rate-limit action';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'invalid rate limit';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception using errcode = '22023', message = 'invalid rate-limit window';
  end if;

  v_window := make_interval(secs => p_window_seconds);

  if p_wallet_address is not null then
    insert into public.chat_rate_limits as bucket (
      scope, key_hash, action, window_started_at, request_count, updated_at
    ) values (
      'wallet', encode(sha256(convert_to(p_wallet_address, 'UTF8')), 'hex'),
      p_action, v_now, 1, v_now
    )
    on conflict (scope, key_hash, action) do update
    set window_started_at = case
          when bucket.window_started_at + v_window <= v_now then v_now
          else bucket.window_started_at
        end,
        request_count = case
          when bucket.window_started_at + v_window <= v_now then 1
          else bucket.request_count + 1
        end,
        updated_at = v_now
    returning request_count, window_started_at
    into v_wallet_count, v_wallet_started;
  end if;

  insert into public.chat_rate_limits as bucket (
    scope, key_hash, action, window_started_at, request_count, updated_at
  ) values (
    'ip', p_ip_hash, p_action, v_now, 1, v_now
  )
  on conflict (scope, key_hash, action) do update
  set window_started_at = case
        when bucket.window_started_at + v_window <= v_now then v_now
        else bucket.window_started_at
      end,
      request_count = case
        when bucket.window_started_at + v_window <= v_now then 1
        else bucket.request_count + 1
      end,
      updated_at = v_now
  returning request_count, window_started_at
  into v_ip_count, v_ip_started;

  v_highest_count := greatest(v_wallet_count, v_ip_count);
  v_allowed := v_highest_count <= p_limit;
  v_retry_after := case
    when v_allowed then 0
    else greatest(
      1,
      case
        when v_wallet_count > p_limit then
          ceil(extract(epoch from (v_wallet_started + v_window - v_now)))::integer
        else 0
      end,
      case
        when v_ip_count > p_limit then
          ceil(extract(epoch from (v_ip_started + v_window - v_now)))::integer
        else 0
      end
    )
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'remaining', greatest(0, p_limit - v_highest_count),
    'retry_after_seconds', v_retry_after
  );
end;
$$;

create or replace function public.wallet_mined_round_count(
  p_wallet_address text
)
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count bigint;
begin
  if p_wallet_address is null
     or not public.is_valid_solana_wallet_address(p_wallet_address) then
    raise exception using errcode = '22023', message = 'invalid wallet address';
  end if;

  select count(*)::bigint
  into v_count
  from (
    select distinct bet.round_id
    from public.mine_round_bets as bet
    join public.mine_rounds as round_row
      on round_row.round_id = bet.round_id
    where bet.bettor = p_wallet_address
      and round_row.resolved = true
  ) as resolved_rounds;

  return v_count;
end;
$$;

create or replace function public.is_chat_session_current(
  p_session_epoch uuid,
  p_wallet_address text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_session_epoch is not null
     and public.is_valid_solana_wallet_address(p_wallet_address)
     and exists (
       select 1
       from public.chat_security_state as security_state
       join public.profiles as profile
         on profile.wallet_address = p_wallet_address
       where security_state.id = 1
         and security_state.session_epoch = p_session_epoch
         and profile.banned = false
     )
$$;

-- Remove any mutation policy left by an earlier guest-chat experiment. Public
-- reads remain policy-controlled; writes are service-role-only.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select tablename, policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in (
        'auth_nonces',
        'chat_feed',
        'chat_reactions',
        'profiles',
        'chat_admins',
        'chat_security_state',
        'chat_rate_limits'
      )
      and cmd <> 'SELECT'
  loop
    execute format(
      'drop policy %I on public.%I',
      policy_row.policyname,
      policy_row.tablename
    );
  end loop;
end
$$;

drop policy if exists "chat feed public read" on public.chat_feed;
create policy "chat feed public read"
  on public.chat_feed for select to anon, authenticated using (true);
drop policy if exists "chat reactions public read" on public.chat_reactions;
create policy "chat reactions public read"
  on public.chat_reactions for select to anon, authenticated using (true);
drop policy if exists "profiles public read" on public.profiles;
create policy "profiles public read"
  on public.profiles for select to anon, authenticated using (true);

revoke all on table public.auth_nonces, public.chat_feed,
  public.chat_reactions, public.profiles, public.chat_admins,
  public.chat_security_state, public.chat_rate_limits
  from public, anon, authenticated;

grant select on table public.chat_feed, public.chat_reactions, public.profiles
  to anon, authenticated;

grant select, insert, delete on table public.auth_nonces to service_role;
grant select, insert, delete on table public.chat_feed,
  public.chat_reactions to service_role;
grant select, insert, update on table public.profiles to service_role;
grant select on table public.chat_admins, public.chat_security_state
  to service_role;
grant select, delete on table public.chat_rate_limits to service_role;

revoke all on function public.is_valid_solana_wallet_address(text),
  public.current_chat_session_epoch(),
  public.consume_solana_nonce(text, text, text, text),
  public.enforce_chat_rate_limit(text, text, text, integer, integer),
  public.wallet_mined_round_count(text),
  public.is_chat_session_current(uuid, text)
  from public, anon, authenticated;

grant execute on function public.is_valid_solana_wallet_address(text),
  public.current_chat_session_epoch(),
  public.consume_solana_nonce(text, text, text, text),
  public.enforce_chat_rate_limit(text, text, text, integer, integer),
  public.wallet_mined_round_count(text),
  public.is_chat_session_current(uuid, text)
  to service_role;

revoke all on sequence public.chat_feed_id_seq from public, anon, authenticated;
grant usage, select on sequence public.chat_feed_id_seq to service_role;

comment on table public.chat_security_state is
  'Singleton wallet-chat session epoch. Rotating it revokes every signed chat session.';
comment on table public.chat_rate_limits is
  'Hashed wallet/IP fixed-window rate-limit buckets; writable only by service-role Edge Functions.';
comment on function public.consume_solana_nonce(text, text, text, text) is
  'Atomically consumes one unexpired challenge from the current chat session epoch.';
comment on function public.wallet_mined_round_count(text) is
  'Counts distinct resolved rounds for one wallet from the indexed on-chain round read model.';
