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
test -f target/idl/myne_protocol.json
test -f ../Frontend/src/generated/myne_protocol.json
python3 -c 'import json,sys; assert json.load(open(sys.argv[1])) == json.load(open(sys.argv[2])), "Frontend IDL is not synchronized"' \
  target/idl/myne_protocol.json ../Frontend/src/generated/myne_protocol.json

grep -q "declare_id!(\"$PROGRAM_ID\")" programs/myne_protocol/src/lib.rs
grep -q '"name": "settle_round_verified"' target/idl/myne_protocol.json
grep -q '"name": "set_randomness_program"' target/idl/myne_protocol.json
grep -q '"name": "claim_auto_burn_receipt"' target/idl/myne_protocol.json
grep -q 'pub const CURRENT_VERSION: u8 = 4;' programs/myne_protocol/src/lib.rs
grep -q "$MAINNET_SWITCHBOARD" programs/myne_protocol/src/lib.rs
grep -q "$METEORA_DLMM" programs/myne_protocol/src/lib.rs

if git grep -nE '(BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|PRIVATE_KEY=|SERVICE_ROLE_KEY=|api-key=[A-Za-z0-9_-]{20,})' -- ':!*.lock'; then
  echo "Potential secret material found in tracked files" >&2
  exit 1
fi

echo "Mainnet artifact preflight passed (read-only)."
echo "Program: $PROGRAM_ID"
echo "Binary SHA-256: $(shasum -a 256 target/deploy/myne_protocol.so | awk '{print $1}')"
echo "Mainnet Switchboard: $MAINNET_SWITCHBOARD"
echo "Meteora DLMM: $METEORA_DLMM"
echo "No deployment or wallet transaction was performed."
