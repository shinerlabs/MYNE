#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

tracked_artifacts="$({
  git ls-files | grep -E '(^|/)(node_modules|target|test-ledger|\.anchor|\.localnet|\.vercel|\.pnpm-store)(/|$)|(^|/)\.env($|\.)|(^|/)\.DS_Store$|\.(pem|p12|pfx|keystore)$|(^|/)(id_rsa|id_ed25519)$|(^|/)[^/]*(keypair|seed[-_]?phrase|private[-_]?key)[^/]*\.(json|txt|pem|key)$' || true
} | grep -Ev '(^|/)\.env(\.local)?\.example$' || true)"

if [[ -n "$tracked_artifacts" ]]; then
  echo "Generated output, local configuration, or key material is tracked:" >&2
  printf '%s\n' "$tracked_artifacts" >&2
  exit 1
fi

secret_regex="(BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY|api-key=[A-Za-z0-9_-]{20,}|((SUPABASE_)?SERVICE_ROLE_KEY|PRIVATE_KEY|SECRET_ACCESS_KEY|HELIUS_API_KEY)[A-Z0-9_]*['\"]?[[:space:]]*[:=][[:space:]]*['\"]?[A-Za-z0-9+/_=-]{20,})"
set +e
secret_matches="$(git grep -nEI "$secret_regex" -- \
  ':!*.lock' \
  ':(top,exclude).github/scripts/check-repository-hygiene.sh' \
  ':(top,exclude)Protocol/scripts/check-mainnet-readiness.sh')"
secret_status=$?
set -e
if (( secret_status > 1 )); then
  echo "Secret scan could not complete" >&2
  exit "$secret_status"
fi
if [[ -n "$secret_matches" ]]; then
  printf '%s\n' "$secret_matches" >&2
  echo "Potential secret material found in tracked files" >&2
  exit 1
fi

set +e
keypair_matches="$(git grep -nIE '^\[[0-9,[:space:]]{100,}\][[:space:]]*$' -- ':!*.lock')"
keypair_status=$?
set -e
if (( keypair_status > 1 )); then
  echo "Solana keypair scan could not complete" >&2
  exit "$keypair_status"
fi
if [[ -n "$keypair_matches" ]]; then
  printf '%s\n' "$keypair_matches" >&2
  echo "Potential Solana keypair byte array found in tracked files" >&2
  exit 1
fi

set +e
action_refs="$(git grep -nE '^[[:space:]]*-[[:space:]]+uses:[[:space:]]+[^[:space:]]+' -- '.github/workflows/*.yml')"
action_status=$?
set -e
if (( action_status > 1 )); then
  echo "GitHub Actions reference scan could not complete" >&2
  exit "$action_status"
fi
unpinned_actions="$(
  printf '%s\n' "$action_refs" |
    grep -vE 'uses:[[:space:]]+(\./|docker://)' |
    grep -vE '@[0-9a-f]{40}([[:space:]]+#.*)?$' || true
)"

if [[ -n "$unpinned_actions" ]]; then
  echo "GitHub Actions must use immutable 40-character commit SHAs:" >&2
  printf '%s\n' "$unpinned_actions" >&2
  exit 1
fi

echo "Repository hygiene checks passed"
