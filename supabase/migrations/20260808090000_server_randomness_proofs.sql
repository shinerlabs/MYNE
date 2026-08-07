-- Additive provider-aware randomness evidence. Existing Switchboard columns
-- remain unchanged so historical v2 archive snapshots retain their hashes.
-- Server commit bytes are never represented as account addresses, and its
-- high-bit-tagged Round::randomness_commit_slot is never written to bigint.

alter table public.mine_rounds
  add column if not exists randomness_provider_kind text,
  add column if not exists randomness_commitment_hex text,
  add column if not exists randomness_reveal_hex text,
  add column if not exists randomness_target_slot numeric(20,0),
  add column if not exists randomness_entropy_slot numeric(20,0),
  add column if not exists randomness_entropy_hash_hex text,
  add column if not exists randomness_commitment_signature text,
  add column if not exists randomness_commitment_tx_slot numeric(20,0),
  add column if not exists randomness_lock_signature text,
  add column if not exists randomness_lock_tx_slot numeric(20,0),
  add column if not exists randomness_reveal_signature text,
  add column if not exists randomness_reveal_tx_slot numeric(20,0);

alter table public.mine_round_proofs
  add column if not exists provider_kind text,
  add column if not exists commitment_hex text,
  add column if not exists reveal_hex text,
  add column if not exists target_slot numeric(20,0),
  add column if not exists entropy_slot numeric(20,0),
  add column if not exists entropy_hash_hex text,
  add column if not exists commitment_signature text,
  add column if not exists commitment_tx_slot numeric(20,0),
  add column if not exists lock_signature text,
  add column if not exists lock_tx_slot numeric(20,0),
  add column if not exists reveal_signature text,
  add column if not exists reveal_tx_slot numeric(20,0);

update public.mine_rounds
set randomness_provider_kind = 'switchboard'
where randomness_provider_kind is null
  and randomness_id is not null;

update public.mine_round_proofs as proof
set provider_kind = 'switchboard'
where proof.provider_kind is null
  and proof.randomness_account is not null;

create index if not exists mine_rounds_buyback_backlog_idx
  on public.mine_rounds (round_id)
  where resolved = true
    and buyback_completed = false
    and total_wager_wei > 0;

alter table public.mine_rounds
  drop constraint if exists mine_rounds_randomness_provider_kind_check,
  add constraint mine_rounds_randomness_provider_kind_check check (
    randomness_provider_kind is null
    or randomness_provider_kind in ('switchboard', 'server_commit_reveal')
  ),
  drop constraint if exists mine_rounds_randomness_commitment_hex_check,
  add constraint mine_rounds_randomness_commitment_hex_check check (
    randomness_commitment_hex is null
    or randomness_commitment_hex ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists mine_rounds_randomness_reveal_hex_check,
  add constraint mine_rounds_randomness_reveal_hex_check check (
    randomness_reveal_hex is null
    or randomness_reveal_hex ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists mine_rounds_randomness_entropy_hash_hex_check,
  add constraint mine_rounds_randomness_entropy_hash_hex_check check (
    randomness_entropy_hash_hex is null
    or randomness_entropy_hash_hex ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists mine_rounds_randomness_target_slot_check,
  add constraint mine_rounds_randomness_target_slot_check check (
    randomness_target_slot is null
    or randomness_target_slot between 0 and 18446744073709551615
  ),
  drop constraint if exists mine_rounds_randomness_entropy_slot_check,
  add constraint mine_rounds_randomness_entropy_slot_check check (
    randomness_entropy_slot is null
    or randomness_entropy_slot between 0 and 18446744073709551615
  ),
  drop constraint if exists mine_rounds_randomness_event_slots_check,
  add constraint mine_rounds_randomness_event_slots_check check (
    (randomness_commitment_tx_slot is null
      or randomness_commitment_tx_slot between 0 and 18446744073709551615)
    and (randomness_lock_tx_slot is null
      or randomness_lock_tx_slot between 0 and 18446744073709551615)
    and (randomness_reveal_tx_slot is null
      or randomness_reveal_tx_slot between 0 and 18446744073709551615)
  ),
  drop constraint if exists mine_rounds_server_randomness_separation_check,
  add constraint mine_rounds_server_randomness_separation_check check (
    randomness_provider_kind is distinct from 'server_commit_reveal'
    or (randomness_id is null and randomness_commit_slot is null)
  );

alter table public.mine_round_proofs
  drop constraint if exists mine_round_proofs_provider_kind_check,
  add constraint mine_round_proofs_provider_kind_check check (
    provider_kind is null
    or provider_kind in ('switchboard', 'server_commit_reveal')
  ),
  drop constraint if exists mine_round_proofs_commitment_hex_check,
  add constraint mine_round_proofs_commitment_hex_check check (
    commitment_hex is null or commitment_hex ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists mine_round_proofs_reveal_hex_check,
  add constraint mine_round_proofs_reveal_hex_check check (
    reveal_hex is null or reveal_hex ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists mine_round_proofs_entropy_hash_hex_check,
  add constraint mine_round_proofs_entropy_hash_hex_check check (
    entropy_hash_hex is null or entropy_hash_hex ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists mine_round_proofs_u64_slots_check,
  add constraint mine_round_proofs_u64_slots_check check (
    (target_slot is null or target_slot between 0 and 18446744073709551615)
    and (entropy_slot is null or entropy_slot between 0 and 18446744073709551615)
    and (commitment_tx_slot is null
      or commitment_tx_slot between 0 and 18446744073709551615)
    and (lock_tx_slot is null or lock_tx_slot between 0 and 18446744073709551615)
    and (reveal_tx_slot is null or reveal_tx_slot between 0 and 18446744073709551615)
  ),
  drop constraint if exists mine_round_proofs_server_randomness_separation_check,
  add constraint mine_round_proofs_server_randomness_separation_check check (
    provider_kind is distinct from 'server_commit_reveal'
    or (randomness_account is null and randomness_commit_slot is null)
  );

comment on column public.mine_rounds.randomness_provider_kind is
  'switchboard or server_commit_reveal; selects the provider-specific archive proof format.';
comment on column public.mine_rounds.randomness_commit_slot is
  'Plain Switchboard commit slot only. Server high-bit-tagged u64 values must never be stored here.';
comment on column public.mine_rounds.randomness_id is
  'Switchboard request account only. Server commitments are stored as commitment_hex, never as Explorer accounts.';
comment on column public.mine_rounds.randomness_target_slot is
  'Unflagged future Solana slot locked after betting closes for server commit-reveal.';
comment on column public.mine_rounds.randomness_entropy_slot is
  'Actual smallest produced SlotHashes slot at or after randomness_target_slot.';
comment on column public.mine_rounds.randomness_entropy_hash_hex is
  'Raw 32-byte SlotHashes entry mixed into the server randomness output.';
comment on column public.mine_round_proofs.provider_kind is
  'Provider-specific proof discriminator. Switchboard snapshots remain version 2; server proofs use version 3.';
