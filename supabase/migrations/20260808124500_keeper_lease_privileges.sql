-- The keeper lease RPC fences services that perform external side effects.
-- Supabase can retain role-specific EXECUTE grants even after revoking PUBLIC,
-- so fail closed by naming every browser-facing role explicitly.

revoke all on function public.acquire_mine_keeper_lease(text, text, integer)
  from public, anon, authenticated;

grant execute on function public.acquire_mine_keeper_lease(text, text, integer)
  to service_role;

comment on function public.acquire_mine_keeper_lease(text, text, integer) is
  'Service-role-only worker fencing; browser and authenticated clients cannot acquire keeper leases.';
