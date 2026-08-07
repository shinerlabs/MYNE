-- Chat is wallet-authenticated on every cluster. Administrators can ban a wallet by
-- setting profiles.banned = true in the Supabase dashboard; chat-send enforces it.
alter table public.profiles
  add column if not exists banned boolean not null default false;

create index if not exists profiles_banned_idx
  on public.profiles (wallet_address)
  where banned = true;
