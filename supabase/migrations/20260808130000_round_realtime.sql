-- Publish the public, rebuildable round read model so browsers can replace multi-second polling
-- latency with Supabase Realtime. RLS still limits clients to the existing public SELECT policy;
-- private receipt settlement and indexer cursor tables are deliberately not published.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'mine_rounds'
  ) then
    alter publication supabase_realtime add table public.mine_rounds;
  end if;
end $$;

comment on table public.mine_rounds is
  'Rebuildable public round read model; published through Supabase Realtime for low-latency UI updates.';
