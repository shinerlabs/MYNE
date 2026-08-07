#!/usr/bin/env bash
set -euo pipefail

required_anchor='anchor-cli 1.0.2'
required_solana='solana-cli 3.1.10'

anchor_version="$(anchor --version)"
solana_version="$(solana --version)"
test "$anchor_version" = "$required_anchor"
case "$solana_version" in
  "$required_solana"*) ;;
  *) echo "Expected $required_solana, found $solana_version" >&2; exit 1 ;;
esac

cargo fmt --all -- --check
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
anchor build

python3 - target/idl/myne_protocol.json ../Frontend/src/generated/myne_protocol.json <<'PY'
import json
import sys

target_path, frontend_path = sys.argv[1:]
with open(target_path, encoding='utf-8') as source:
    idl = json.load(source)
with open(frontend_path, encoding='utf-8') as source:
    frontend_idl = json.load(source)
assert idl == frontend_idl, 'Frontend IDL is not synchronized'
instructions = {entry['name']: entry for entry in idl.get('instructions', [])}
assert 'record_round_randomness_commit' in instructions, 'IDL is missing post-close commit recording'
assert 'rotate_operational_wallets' in instructions, 'IDL is missing operational-wallet rotation'
events = {entry['name'] for entry in idl.get('events', [])}
assert 'ClaimFeeRoutedV2' in events, 'IDL is missing versioned claim-fee routing evidence'
for instruction_name in ('deploy', 'execute_auto_plan'):
    accounts = {entry['name'] for entry in instructions[instruction_name]['accounts']}
    assert 'randomness_account' in accounts, f'{instruction_name} is missing randomness_account'
PY

echo "Devnet build readiness checks passed. No deployment was performed."
