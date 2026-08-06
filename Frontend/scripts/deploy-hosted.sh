#!/usr/bin/env bash
# Rebuild the frontend and publish it to the nginx web root for prodev.sbs.
#
#   ./scripts/deploy-hosted.sh
#
# `build:hosted`, not `build`: the plain production build points the browser straight at
# *.supabase.co, where chat-react / chat-reactions / chat-delete / follow-toggle /
# profile-update are not deployed yet (migration 0003 is unapplied). MODE=hosted keeps the
# same-origin /supabase proxy that nginx mirrors. See src/social/config.js.
#
# nginx serves /var/www rather than the repo because /root is 0700 and www-data cannot
# traverse it. Loosening /root to fix that would expose .env and the testnet key.
set -euo pipefail

echo "Deployment blocked: the MYNE Solana program, audited IDL/client, randomness provider and liquidity venue are not ready." >&2
exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBROOT=/var/www/prodev.sbs

cd "$ROOT"
pnpm build:hosted

# --delete so a renamed hashed asset does not leave its predecessor behind forever.
rsync -a --delete dist/ "$WEBROOT/"
chown -R www-data:www-data "$WEBROOT"

echo "deployed $(du -sh "$WEBROOT" | cut -f1) to $WEBROOT"
curl -sf -o /dev/null -w "https://prodev.sbs -> %{http_code}\n" https://prodev.sbs/
