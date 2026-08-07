-- Distinguish historical receipt settlement that paid the wallet immediately
-- from the current claim-vault flow. `accrued` means all receipt rewards were
-- processed and are durable, while SOL remains in the on-chain claim vault
-- until the receipt owner signs Claim SOL / Claim All.

alter table public.mine_receipt_settlements
  drop constraint if exists mine_receipt_settlements_status_check;

alter table public.mine_receipt_settlements
  add constraint mine_receipt_settlements_status_check
  check (status in ('claimed', 'accrued', 'refunded', 'closed')) not valid;

alter table public.mine_receipt_settlements
  validate constraint mine_receipt_settlements_status_check;

comment on column public.mine_receipt_settlements.status is
  'claimed = historical direct wallet payment; accrued = reward processed into the owner claim vault; refunded = principal returned; closed = receipt rent reclaimed';
