-- Distinguish an observed on-chain archive event from an archive whose complete
-- canonical snapshot has been persisted and whose hash has been compared back
-- to the Round PDA. Lifecycle cleanup may proceed only after this flag is true.

alter table public.mine_rounds
  add column if not exists archive_verified boolean not null default false;

create index if not exists mine_rounds_archive_verification_queue_idx
  on public.mine_rounds (archive_verified, round_id)
  where closed_signature is null;

comment on column public.mine_rounds.archive_verified is
  'True only after the production indexer persists the canonical proof and verifies its SHA-256 against the Round PDA.';
