#!/usr/bin/env bash
set -euo pipefail

# Read-only Mainnet compatibility proof. The script clones only the frozen
# liability accounts into an isolated validator, loads the candidate SBF at
# the production program ID, and processes the receipts locally. It never
# submits a transaction to Mainnet.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

: "${MAINNET_RPC_URL:?Set MAINNET_RPC_URL to the reviewed Solana Mainnet RPC}"
NODE_BIN="${NODE_BIN:-node}"
SOLANA_BIN="${SOLANA_BIN:-solana}"
VALIDATOR_BIN="${VALIDATOR_BIN:-solana-test-validator}"
RPC_PORT="${MYNE_FORK_RPC_PORT:-31999}"
FAUCET_PORT="${MYNE_FORK_FAUCET_PORT:-32001}"
GOSSIP_PORT="${MYNE_FORK_GOSSIP_PORT:-32002}"
DYNAMIC_PORT_RANGE="${MYNE_FORK_DYNAMIC_PORT_RANGE:-32003-32200}"
PROGRAM_ID="D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e"
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
SNAPSHOT="tests/fixtures/mainnet-receipt-upgrade-snapshot.json"
WALLET=".localnet/test-wallet.json"

test -f "$SNAPSHOT"
test -f target/deploy/myne_protocol.so
test -f target/idl/myne_protocol.json
test -f "$WALLET"
test "$("$SOLANA_BIN" genesis-hash --url "$MAINNET_RPC_URL")" = "$MAINNET_GENESIS"
LC_ALL=C grep -aFq 'MYNE_PRODUCTION_ARTIFACT_V1' target/deploy/myne_protocol.so
if LC_ALL=C grep -aFq 'MYNE_REHEARSAL_ARTIFACT_V1' target/deploy/myne_protocol.so; then
  echo 'Refusing a rehearsal SBF for the Mainnet-liability fork test' >&2
  exit 1
fi

CLONE_ARGS=()
while IFS= read -r address; do
  [[ "$address" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]
  CLONE_ARGS+=(--clone "$address")
done < <("$NODE_BIN" --input-type=module -e '
  import { readFileSync } from "node:fs";
  const snapshot = JSON.parse(readFileSync(process.argv[1], "utf8"));
  for (const address of snapshot.cloneAddresses) console.log(address);
' "$SNAPSHOT")
test "${#CLONE_ARGS[@]}" -gt 0

TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
LEDGER="$(mktemp -d "$TMP_ROOT/myne-upgrade-fork.XXXXXX")"
VALIDATOR_PID=''
cleanup() {
  if [[ -n "$VALIDATOR_PID" ]]; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  rm -rf "$LEDGER"
}
trap cleanup EXIT INT TERM

"$VALIDATOR_BIN" \
  --ledger "$LEDGER" \
  --reset \
  --quiet \
  --rpc-port "$RPC_PORT" \
  --faucet-port "$FAUCET_PORT" \
  --gossip-port "$GOSSIP_PORT" \
  --dynamic-port-range "$DYNAMIC_PORT_RANGE" \
  --url "$MAINNET_RPC_URL" \
  --clone-feature-set \
  --bpf-program "$PROGRAM_ID" target/deploy/myne_protocol.so \
  "${CLONE_ARGS[@]}" \
  >"$LEDGER/validator.stdout.log" 2>&1 &
VALIDATOR_PID=$!

LOCAL_RPC="http://127.0.0.1:$RPC_PORT"
ready=0
for _ in $(seq 1 90); do
  if "$SOLANA_BIN" cluster-version --url "$LOCAL_RPC" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  tail -100 "$LEDGER/validator.stdout.log" >&2 || true
  exit 1
fi

"$SOLANA_BIN" airdrop 10 --keypair "$WALLET" --url "$LOCAL_RPC" >/dev/null
ANCHOR_PROVIDER_URL="$LOCAL_RPC" \
ANCHOR_WALLET="$WALLET" \
"$NODE_BIN" tests/forked-mainnet-receipt-upgrade.mjs

echo "Candidate SBF SHA-256: $(shasum -a 256 target/deploy/myne_protocol.so | awk '{print $1}')"
echo 'Mainnet remained read-only; all receipt processing occurred on the isolated validator.'
