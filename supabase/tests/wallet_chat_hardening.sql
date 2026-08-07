begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(25);

select ok(
  to_regclass('public.chat_security_state') is not null,
  'chat security epoch table exists'
);
select ok(
  to_regclass('public.chat_rate_limits') is not null,
  'database-backed rate-limit table exists'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_attribute
    where attrelid = 'public.chat_feed'::regclass
      and attname = 'guest_id'
      and not attisdropped
  ),
  'guest chat identifier is removed'
);
select ok(
  (
    select attnotnull
    from pg_catalog.pg_attribute
    where attrelid = 'public.chat_feed'::regclass
      and attname = 'wallet_address'
      and not attisdropped
  ),
  'chat wallet ownership is required'
);
select ok(
  not exists (
    select 1 from public.chat_feed
    where wallet_address is null
       or not public.is_valid_solana_wallet_address(wallet_address)
  ),
  'guest and malformed-wallet messages are absent'
);
select ok(
  public.is_valid_solana_wallet_address('11111111111111111111111111111111'),
  'database validator accepts a canonical 32-byte Solana address'
);
select ok(
  not public.is_valid_solana_wallet_address('22222222222222222222222222222222'),
  'database validator rejects Base58 text that does not decode to 32 bytes'
);

select ok(
  to_regprocedure('public.consume_solana_nonce(text,text,text,text)') is not null,
  'atomic nonce-consumption RPC exists'
);
select ok(
  to_regprocedure('public.enforce_chat_rate_limit(text,text,text,integer,integer)') is not null,
  'rate-limit RPC exists'
);
select ok(
  to_regprocedure('public.wallet_mined_round_count(text)') is not null,
  'indexed mined-round RPC exists'
);
select ok(
  to_regprocedure('public.current_chat_session_epoch()') is not null,
  'session epoch RPC exists'
);
select ok(
  to_regprocedure('public.is_chat_session_current(uuid,text)') is not null,
  'session revocation RPC exists'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.consume_solana_nonce(text,text,text,text)',
    'EXECUTE'
  ),
  'anon cannot consume login nonces'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.enforce_chat_rate_limit(text,text,text,integer,integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot manipulate rate-limit counters'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.consume_solana_nonce(text,text,text,text)',
    'EXECUTE'
  ),
  'service-role Edge Functions can consume nonces'
);
select ok(
  not has_table_privilege('anon', 'public.chat_feed', 'INSERT'),
  'anon cannot insert chat rows directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
  'authenticated clients cannot bypass wallet-owned profile updates'
);

insert into public.profiles (wallet_address)
values ('11111111111111111111111111111111')
on conflict (wallet_address) do update set banned = false;

insert into public.auth_nonces (
  nonce, wallet_address, message, purpose, expires_at
) values (
  '5cb20d55-a2c8-4738-8098-f1d177769b4f',
  '11111111111111111111111111111111',
  'MYNE wallet test challenge',
  'chat_session',
  clock_timestamp() + interval '5 minutes'
);

select ok(
  public.consume_solana_nonce(
    '11111111111111111111111111111111',
    '5cb20d55-a2c8-4738-8098-f1d177769b4f',
    'MYNE wallet test challenge',
    'chat_session'
  ),
  'a valid current-epoch nonce is consumed once'
);
select ok(
  not public.consume_solana_nonce(
    '11111111111111111111111111111111',
    '5cb20d55-a2c8-4738-8098-f1d177769b4f',
    'MYNE wallet test challenge',
    'chat_session'
  ),
  'a consumed nonce cannot be replayed'
);

delete from public.chat_rate_limits
where action = 'chat_send'
  and key_hash in (
    repeat('a', 64),
    encode(sha256(convert_to('11111111111111111111111111111111', 'UTF8')), 'hex')
  );

select ok(
  (public.enforce_chat_rate_limit(
    '11111111111111111111111111111111', repeat('a', 64),
    'chat_send', 2, 60
  )->>'allowed')::boolean,
  'first wallet/IP request is allowed'
);
select ok(
  (public.enforce_chat_rate_limit(
    '11111111111111111111111111111111', repeat('a', 64),
    'chat_send', 2, 60
  )->>'allowed')::boolean,
  'request at the rate limit is allowed'
);
select ok(
  not (public.enforce_chat_rate_limit(
    '11111111111111111111111111111111', repeat('a', 64),
    'chat_send', 2, 60
  )->>'allowed')::boolean,
  'request over the rate limit is rejected atomically'
);

insert into public.mine_rounds (round_id, resolved)
values
  (9000000000000000001, true),
  (9000000000000000002, false);

insert into public.mine_round_bets (
  round_id, receipt, bettor, nonce, square, amount_wei,
  cumulative_start_wei, reward_mode, deployment_signature, deployment_slot
) values
  (
    9000000000000000001, 'wallet-chat-test-receipt-1',
    '11111111111111111111111111111111', 1, 0, 1, 0, 0,
    'wallet-chat-test-signature-1', 1
  ),
  (
    9000000000000000001, 'wallet-chat-test-receipt-2',
    '11111111111111111111111111111111', 2, 1, 1, 1, 0,
    'wallet-chat-test-signature-2', 2
  ),
  (
    9000000000000000002, 'wallet-chat-test-receipt-3',
    '11111111111111111111111111111111', 3, 2, 1, 2, 0,
    'wallet-chat-test-signature-3', 3
  );

select is(
  public.wallet_mined_round_count('11111111111111111111111111111111'),
  1::bigint,
  'mined-round eligibility counts distinct resolved rounds only'
);

select ok(
  public.is_chat_session_current(
    public.current_chat_session_epoch(),
    '11111111111111111111111111111111'
  ),
  'current epoch and non-banned wallet authorize a session'
);

update public.profiles
set banned = true
where wallet_address = '11111111111111111111111111111111';

select ok(
  not public.is_chat_session_current(
    public.current_chat_session_epoch(),
    '11111111111111111111111111111111'
  ),
  'banning a wallet immediately revokes its session'
);

select * from finish();
rollback;
