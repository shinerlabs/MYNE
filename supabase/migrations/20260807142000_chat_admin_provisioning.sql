-- Service-role-only chat moderator provisioning.
--
-- Wallet addresses are supplied at deployment time and are deliberately not
-- embedded in this public migration. The browser receives only a UI hint;
-- chat-delete remains the authorization boundary and rechecks chat_admins for
-- every deletion.

create or replace function public.set_chat_admin(
  p_wallet_address text,
  p_enabled boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_valid_solana_wallet_address(p_wallet_address) then
    raise exception 'invalid Solana wallet address' using errcode = '22023';
  end if;

  if p_enabled then
    insert into public.profiles (wallet_address)
    values (p_wallet_address)
    on conflict (wallet_address) do nothing;

    insert into public.chat_admins (wallet_address)
    values (p_wallet_address)
    on conflict (wallet_address) do nothing;
  else
    delete from public.chat_admins
    where wallet_address = p_wallet_address;
  end if;

  return p_enabled;
end;
$$;

revoke all on function public.set_chat_admin(text, boolean)
  from public, anon, authenticated;
grant execute on function public.set_chat_admin(text, boolean)
  to service_role;

comment on function public.set_chat_admin(text, boolean) is
  'Adds or removes one wallet moderator. Callable only with the Supabase service role.';
