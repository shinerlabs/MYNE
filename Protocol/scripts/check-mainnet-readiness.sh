#!/usr/bin/env bash
set -euo pipefail

# Read-only production preflight. This script never contacts a cluster and
# never submits a transaction. It verifies that the checked-in artifacts and
# production-mode invariants are present before a separate launch runbook is
# followed with explicit wallet review.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROGRAM_ID="D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e"
MAINNET_SWITCHBOARD="SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv"
METEORA_DLMM="LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"

test -f target/deploy/myne_protocol.so
test -f target/deploy/myne_protocol-keypair.json
test -f target/idl/myne_protocol.json
test -f ../Frontend/src/generated/myne_protocol.json
test "$(solana-keygen pubkey target/deploy/myne_protocol-keypair.json)" = "$PROGRAM_ID"
test -x scripts/build-mainnet.sh
grep -q 'anchor build --no-idl -- --features production -- --locked' scripts/build-mainnet.sh
grep -q 'anchor idl build -o target/idl/myne_protocol.json -- --locked --features production' scripts/build-mainnet.sh
LC_ALL=C grep -aFq 'MYNE_PRODUCTION_ARTIFACT_V1' target/deploy/myne_protocol.so || {
  echo 'SBF is not a production-feature artifact; run pnpm build:mainnet' >&2
  exit 1
}
if LC_ALL=C grep -aFq 'MYNE_REHEARSAL_ARTIFACT_V1' target/deploy/myne_protocol.so; then
  echo 'SBF contains the rehearsal marker and cannot be deployed to Mainnet' >&2
  exit 1
fi

KEYPAIR_MODE="$(stat -f '%Lp' target/deploy/myne_protocol-keypair.json 2>/dev/null \
  || stat -c '%a' target/deploy/myne_protocol-keypair.json)"
if (( (8#$KEYPAIR_MODE & 077) != 0 )); then
  echo "Program keypair permissions must be owner-only (0600); found $KEYPAIR_MODE" >&2
  exit 1
fi
python3 - target/idl/myne_protocol.json ../Frontend/src/generated/myne_protocol.json <<'PY'
import json
import sys

target_path, frontend_path = sys.argv[1:]
with open(target_path, encoding='utf-8') as source:
    target = json.load(source)
with open(frontend_path, encoding='utf-8') as source:
    frontend = json.load(source)
assert target == frontend, 'Frontend IDL is not synchronized'

instructions = {entry['name']: entry for entry in target.get('instructions', [])}
assert 'migrate_fee_schedule_v6' in instructions, 'IDL is missing migrate_fee_schedule_v6'
assert 'record_round_randomness_commit' in instructions, 'IDL is missing record_round_randomness_commit'
assert 'rotate_operational_wallets' in instructions, 'IDL is missing rotate_operational_wallets'
for instruction_name in ('deploy', 'execute_auto_plan'):
    account_names = {account['name'] for account in instructions[instruction_name]['accounts']}
    assert 'randomness_account' in account_names, f'{instruction_name} is missing randomness_account'
for instruction_name in ('settle_round', 'settle_round_verified'):
    account_names = {account['name'] for account in instructions[instruction_name]['accounts']}
    assert 'admin_fee_wallet' in account_names, f'{instruction_name} is missing admin_fee_wallet'
events = {entry['name'] for entry in target.get('events', [])}
assert 'RoundFeesDistributed' in events, 'IDL is missing RoundFeesDistributed'
assert 'ClaimFeeRoutedV2' in events, 'IDL is missing ClaimFeeRoutedV2'
types = {entry['name']: entry for entry in target.get('types', [])}
fee_fields = {
    field['name']
    for field in types['RoundFeesDistributed']['type']['fields']
}
assert {
    'total_fee_lamports', 'staking_gross_lamports', 'staking_admin_lamports',
    'staking_net_lamports', 'buyback_lamports', 'motherlode_lamports',
    'mining_admin_lamports', 'admin_total_lamports', 'admin_fee_wallet',
}.issubset(fee_fields), 'RoundFeesDistributed IDL fields are incomplete'
PY

# A synchronized but stale IDL/binary is still unsafe. Force a clean rebuild
# whenever any program source or build manifest is newer than either artifact.
python3 - target/deploy/myne_protocol.so target/idl/myne_protocol.json ../Frontend/src/generated/myne_protocol.json <<'PY'
from pathlib import Path
import sys

artifacts = [Path(value) for value in sys.argv[1:]]
inputs = [Path('Anchor.toml'), Path('Cargo.toml'), Path('Cargo.lock'), Path('programs/myne_protocol/Cargo.toml')]
inputs.extend(Path('programs/myne_protocol/src').rglob('*.rs'))
newest_input = max(path.stat().st_mtime_ns for path in inputs if path.exists())
stale = [str(path) for path in artifacts if path.stat().st_mtime_ns < newest_input]
assert not stale, f'Rebuild and resync stale artifacts: {", ".join(stale)}'
PY

grep -q "declare_id!(\"$PROGRAM_ID\")" programs/myne_protocol/src/lib.rs
grep -q '"name": "settle_round_verified"' target/idl/myne_protocol.json
grep -q '"name": "record_round_randomness_commit"' target/idl/myne_protocol.json
grep -q '"name": "rotate_operational_wallets"' target/idl/myne_protocol.json
grep -q '"name": "set_randomness_program"' target/idl/myne_protocol.json
grep -q '"name": "claim_auto_burn_receipt"' target/idl/myne_protocol.json
grep -q '"name": "settle_receipt"' target/idl/myne_protocol.json
grep -q '"name": "close_receipt"' target/idl/myne_protocol.json
grep -q '"name": "close_round"' target/idl/myne_protocol.json
grep -q '"name": "archive_round"' target/idl/myne_protocol.json
grep -q '"name": "mark_buyback_completed"' target/idl/myne_protocol.json
grep -q '"name": "migrate_fee_schedule_v6"' target/idl/myne_protocol.json
grep -q '"name": "ClaimFeeRoutedV2"' target/idl/myne_protocol.json
grep -q 'pub const CURRENT_VERSION: u8 = 6;' programs/myne_protocol/src/lib.rs
grep -q 'RoundPayoutIncomplete' programs/myne_protocol/src/economics.rs
grep -q "$MAINNET_SWITCHBOARD" programs/myne_protocol/src/lib.rs
grep -q "$METEORA_DLMM" programs/myne_protocol/src/lib.rs
test -f scripts/round-indexer.mjs
test -f scripts/round-lifecycle-keeper.mjs
test -f scripts/round-archive-policy.mjs
test -f scripts/prepare-admin-fallback-ata.mjs
test -f scripts/migrate-fee-schedule-v6.mjs
grep -q 'fee schedule v6' scripts/switchboard-round-keeper.mjs
grep -q 'fee schedule v6' scripts/buyback-keeper.mjs
grep -q 'fee schedule v6' scripts/round-indexer.mjs
grep -q 'fee schedule v6' scripts/round-lifecycle-keeper.mjs
test -s toolchain/agave-3.1.10-syscalls.txt
grep -q 'mine_buyback_executions' ../supabase/migrations/20260807090000_round_index.sql
test -f ../supabase/migrations/20260807114500_round_fee_audit.sql
grep -q 'staking_admin_lamports' ../supabase/migrations/20260807114500_round_fee_audit.sql
grep -q 'admin_total_lamports' ../supabase/migrations/20260807114500_round_fee_audit.sql
grep -q 'admin_fee_wallet' ../supabase/migrations/20260807114500_round_fee_audit.sql
grep -q 'mine_round_admin_fee_conservation' ../supabase/migrations/20260807114500_round_fee_audit.sql
test -f ../supabase/migrations/20260807130000_round_archive_verification.sql
grep -q 'archive_verified boolean not null default false' ../supabase/migrations/20260807130000_round_archive_verification.sql
grep -q 'indexedRound.archive_verified === true' scripts/round-lifecycle-keeper.mjs
grep -q 'attestedState.archiveHash' scripts/round-indexer.mjs
grep -q 'requireMatchingSolanaNetwork' scripts/switchboard-round-keeper.mjs
grep -q 'recordRoundRandomnessCommit' scripts/switchboard-round-keeper.mjs
grep -q '\[commitIx, recordIx\]' scripts/switchboard-round-keeper.mjs
grep -q 'randomnessAccount: randomnessPubkey' scripts/switchboard-round-keeper.mjs
grep -q 'requireMatchingSolanaNetwork' scripts/buyback-keeper.mjs
grep -q 'TransactionMessage.decompile' scripts/buyback-keeper.mjs
grep -q 'MAX_SWAP_OVERHEAD_LAMPORTS' scripts/buyback-keeper.mjs
test -f ../supabase/migrations/20260807131500_keeper_leases.sql
grep -q 'acquire_mine_keeper_lease' ../supabase/migrations/20260807131500_keeper_leases.sql
grep -q 'acquire_mine_keeper_lease' scripts/buyback-keeper.mjs
test -f ../supabase/migrations/20260807133000_referral_read_model_v1.sql
grep -q 'mine_referral_stats_v1' ../supabase/migrations/20260807133000_referral_read_model_v1.sql
grep -q 'ClaimFeeRoutedV2' scripts/round-indexer.mjs
grep -q 'ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE=1' docs/MAINNET_LAUNCH_RUNBOOK.md
grep -q 'REFERRAL_INDEXER_START_SLOT' docs/MAINNET_LAUNCH_RUNBOOK.md

if [[ -z "${MAINNET_RELEASE_MANIFEST:-}" ]]; then
  echo "Set MAINNET_RELEASE_MANIFEST to the frozen, external manifest for the candidate" >&2
  echo "Generate its contents only after a clean final build: pnpm release:manifest -- --print" >&2
  exit 1
fi
node scripts/release-artifact-manifest.mjs --verify "$MAINNET_RELEASE_MANIFEST"

if git grep -nE '(BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|PRIVATE_KEY=|SERVICE_ROLE_KEY=|api-key=[A-Za-z0-9_-]{20,})' -- \
  ':!*.lock' ':(top,exclude)Protocol/scripts/check-mainnet-readiness.sh' \
  ':(top,exclude).github/workflows/protocol-safety.yml'; then
  echo "Potential secret material found in tracked files" >&2
  exit 1
fi

echo "Mainnet artifact preflight passed (read-only)."
echo "Program: $PROGRAM_ID"
echo "Binary SHA-256: $(shasum -a 256 target/deploy/myne_protocol.so | awk '{print $1}')"
echo "Mainnet Switchboard: $MAINNET_SWITCHBOARD"
echo "Meteora DLMM: $METEORA_DLMM"
echo "No deployment or wallet transaction was performed."
