#!/usr/bin/env bash
set -euo pipefail

# The only supported Mainnet artifact build path. Cargo features are forwarded
# after Anchor's `--`; omitting that separator silently produces the broader
# rehearsal binary and is therefore forbidden for release evidence.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

test "$(anchor --version)" = 'anchor-cli 1.0.2'
case "$(solana --version)" in
  solana-cli\ 3.1.10*) ;;
  *) echo 'Mainnet build requires solana-cli 3.1.10' >&2; exit 1 ;;
esac

# Anchor forwards arguments after its first `--` to `cargo build-sbf`.
# `--features` belongs to cargo-build-sbf, while `--locked` must pass through
# cargo-build-sbf's own separator to the underlying Cargo invocation. Anchor
# 1.0.2 otherwise forwards that nested separator incorrectly to its IDL test
# binary, so build the SBF and IDL as two explicit locked production steps.
mkdir -p target/idl
anchor idl build -o target/idl/myne_protocol.json -- --locked --features production
# IDL generation runs a host-side Cargo test and may leave default-profile
# build products behind. Produce the deployable SBF last so the final artifact
# is unambiguously the production-feature binary checked below.
anchor build --no-idl -- --features production -- --locked

MARKER='MYNE_PRODUCTION_ARTIFACT_V1'
LC_ALL=C grep -aFq "$MARKER" target/deploy/myne_protocol.so || {
  echo 'Built SBF lacks the production-only artifact marker' >&2
  exit 1
}
if LC_ALL=C grep -aFq 'MYNE_REHEARSAL_ARTIFACT_V1' target/deploy/myne_protocol.so; then
  echo 'Built SBF contains the rehearsal marker and is not eligible for Mainnet' >&2
  exit 1
fi

cp target/idl/myne_protocol.json ../Frontend/src/generated/myne_protocol.json
python3 - target/idl/myne_protocol.json ../Frontend/src/generated/myne_protocol.json <<'PY'
import json
import sys

target_path, frontend_path = sys.argv[1:]
with open(target_path, encoding='utf-8') as source:
    target = json.load(source)
with open(frontend_path, encoding='utf-8') as source:
    frontend = json.load(source)
assert target == frontend, 'Frontend IDL synchronization failed'
instructions = {entry['name']: entry for entry in target.get('instructions', [])}
assert 'record_round_randomness_commit' in instructions
assert 'rotate_operational_wallets' in instructions
for instruction_name in ('deploy', 'execute_auto_plan'):
    accounts = {entry['name'] for entry in instructions[instruction_name]['accounts']}
    assert 'randomness_account' in accounts, f'{instruction_name} is missing randomness_account'
PY

echo 'Mainnet production-feature artifact built and IDLs synchronized.'
echo "Binary SHA-256: $(shasum -a 256 target/deploy/myne_protocol.so | awk '{print $1}')"
echo 'Next: run the full production-feature tests, freeze the external release manifest, and execute the read-only preflight.'
