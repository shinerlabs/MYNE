-- Bounded, display-only wallet decoration for the public Rounds ledger.
--
-- Open BetReceipt PDAs and StakePosition remain the only source of actionable
-- claim state. This service-only RPC merely preserves a wallet's winning-tile
-- position and processed/"claimed" badge after archived receipt PDAs close.
-- The wallet-authenticated Edge Function is the sole browser entry point; the
-- underlying settlement table and this function remain unavailable to clients.

create or replace function public.mine_wallet_round_history_v1(
  p_wallet text,
  p_round_ids bigint[]
)
returns table (
  round_id bigint,
  position_lamports text,
  winning_receipts bigint,
  processed_winning_receipts bigint,
  claimed boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_alphabet constant text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  v_value numeric := 0;
  v_cursor numeric;
  v_digit integer;
  v_leading_zero_bytes integer := 0;
  v_value_bytes integer := 0;
  v_round_ids bigint[];
  v_index integer;
begin
  -- Solana public keys are the canonical Base58 representation of exactly
  -- 32 bytes. The alphabet/length check is cheap; the numeric pass rejects
  -- strings whose decoded value is shorter or longer than one public key.
  if p_wallet is null
     or length(p_wallet) not between 32 and 44
     or p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]+$' then
    raise exception 'p_wallet must be a canonical Solana public key'
      using errcode = '22023';
  end if;

  for v_index in 1..length(p_wallet) loop
    v_digit := strpos(v_alphabet, substr(p_wallet, v_index, 1)) - 1;
    if v_digit < 0 then
      raise exception 'p_wallet must be a canonical Solana public key'
        using errcode = '22023';
    end if;
    v_value := (v_value * 58) + v_digit;
  end loop;

  while v_leading_zero_bytes < length(p_wallet)
        and substr(p_wallet, v_leading_zero_bytes + 1, 1) = '1' loop
    v_leading_zero_bytes := v_leading_zero_bytes + 1;
  end loop;
  v_cursor := v_value;
  while v_cursor > 0 loop
    v_value_bytes := v_value_bytes + 1;
    v_cursor := trunc(v_cursor / 256);
  end loop;
  if v_leading_zero_bytes + v_value_bytes <> 32 then
    raise exception 'p_wallet must decode to exactly 32 bytes'
      using errcode = '22023';
  end if;

  if p_round_ids is null or cardinality(p_round_ids) = 0 then
    return;
  end if;
  -- Reject rather than silently truncating a caller's page. The Edge Function
  -- deduplicates first; this bound prevents service-role use from becoming an
  -- arbitrary historical export surface.
  if cardinality(p_round_ids) > 50
     or exists (
       select 1
       from unnest(p_round_ids) as supplied(round_id)
       where supplied.round_id is null or supplied.round_id < 0
     ) then
    raise exception 'p_round_ids must contain at most 50 nonnegative ids'
      using errcode = '22023';
  end if;

  select coalesce(array_agg(deduped.round_id order by deduped.round_id desc), '{}'::bigint[])
  into v_round_ids
  from (
    select distinct supplied.round_id
    from unnest(p_round_ids) as supplied(round_id)
  ) as deduped;

  return query
  with requested as (
    select supplied.round_id
    from unnest(v_round_ids) as supplied(round_id)
  ),
  complete_rounds as (
    select
      rounds.round_id,
      rounds.winning_square,
      rounds.jackpot_hit
    from public.mine_rounds as rounds
    join requested using (round_id)
    where rounds.resolved = true
      and rounds.projection_complete = true
  ),
  winning_positions as (
    select
      bets.round_id,
      bets.receipt,
      sum(bets.amount_wei)::numeric(78,0) as position_lamports
    from public.mine_round_bets as bets
    join complete_rounds as rounds using (round_id)
    where bets.bettor = p_wallet
      and (rounds.jackpot_hit = true or bets.square = rounds.winning_square)
    group by bets.round_id, bets.receipt
    having sum(bets.amount_wei) > 0
  ),
  settlement_flags as (
    select
      settlements.round_id,
      settlements.receipt,
      bool_or(settlements.status in ('claimed', 'accrued', 'closed')) as processed,
      bool_or(settlements.status = 'refunded') as refunded
    from public.mine_receipt_settlements as settlements
    join requested using (round_id)
    where settlements.authority = p_wallet
    group by settlements.round_id, settlements.receipt
  )
  select
    positions.round_id,
    sum(positions.position_lamports)::numeric(78,0)::text as position_lamports,
    count(*)::bigint as winning_receipts,
    count(*) filter (
      where coalesce(flags.processed, false) and not coalesce(flags.refunded, false)
    )::bigint as processed_winning_receipts,
    bool_and(
      coalesce(flags.processed, false) and not coalesce(flags.refunded, false)
    ) as claimed
  from winning_positions as positions
  left join settlement_flags as flags
    on flags.round_id = positions.round_id
   and flags.receipt = positions.receipt
  group by positions.round_id
  order by positions.round_id desc;
end;
$function$;

comment on function public.mine_wallet_round_history_v1(text, bigint[]) is
  'Service-only display history for <=50 projection-complete rounds; never defines claimability.';

revoke all on function public.mine_wallet_round_history_v1(text, bigint[]) from public, anon, authenticated;
grant execute on function public.mine_wallet_round_history_v1(text, bigint[]) to service_role;
