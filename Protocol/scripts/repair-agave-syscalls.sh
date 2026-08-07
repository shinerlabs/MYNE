#!/usr/bin/env bash
set -euo pipefail

# Agave 3.1.10's macOS release was packaged with a zero-byte SBF syscall
# allow-list. cargo-build-sbf then warns that every normal Solana syscall is
# unknown even though the runtime registers them. Repair only that exact
# packaging defect; refuse to modify any other CLI version.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXPECTED_VERSION="solana-cli 3.1.10"
ACTUAL_VERSION="$(solana --version)"
if [[ "$ACTUAL_VERSION" != "$EXPECTED_VERSION"* ]]; then
  echo "Refusing syscall repair for unexpected CLI: $ACTUAL_VERSION" >&2
  exit 1
fi

SBF_BIN="$(command -v cargo-build-sbf)"
SDK_DIR="$(cd "$(dirname "$SBF_BIN")/platform-tools-sdk/sbf" && pwd)"
TARGET="$SDK_DIR/syscalls.txt"
SOURCE="$ROOT_DIR/toolchain/agave-3.1.10-syscalls.txt"

test -f "$TARGET"
test -f "$SOURCE"
if [[ -s "$TARGET" ]]; then
  echo "SBF syscall allow-list is already populated: $TARGET"
  exit 0
fi
install -m 0644 "$SOURCE" "$TARGET"
echo "Repaired Agave 3.1.10 SBF syscall allow-list: $TARGET"
