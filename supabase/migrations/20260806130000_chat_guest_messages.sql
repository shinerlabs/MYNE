-- Temporary launch mode: allow basic chat messages before wallet connection.
-- Wallet-backed profile, reaction, reply and moderation actions remain authenticated.
alter table public.chat_feed alter column wallet_address drop not null;
alter table public.chat_feed add column if not exists guest_id text;
create index if not exists chat_feed_guest_id_idx on public.chat_feed(guest_id);
