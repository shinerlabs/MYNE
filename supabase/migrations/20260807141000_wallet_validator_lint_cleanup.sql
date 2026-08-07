-- Keep the canonical Base58 validator warning-free on the live project. The
-- integer FOR loop declares its iterator implicitly; declaring it separately
-- only shadows that iterator under PostgreSQL's extra warning checks.
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

revoke all on function public.is_valid_solana_wallet_address(text)
  from public, anon, authenticated;
grant execute on function public.is_valid_solana_wallet_address(text)
  to service_role;
