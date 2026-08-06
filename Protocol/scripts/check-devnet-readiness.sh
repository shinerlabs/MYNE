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

echo "Devnet build readiness checks passed. No deployment was performed."
