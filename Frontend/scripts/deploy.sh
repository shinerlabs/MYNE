#!/usr/bin/env bash
#
# One command: sync addresses -> build -> publish -> verify.
#
#   pnpm deploy
#
# This exists because a correct build is NOT a correct site. Two invisible steps sit between
# them, and both have caused live outages:
#
#   1. `pnpm build` sets MODE=production, which DISABLES the /supabase proxy branch in
#      src/social/config.js. The app then calls Supabase directly and bypasses nginx's Express
#      shims for chat-react, chat-reactions, chat-delete, follow-toggle and profile-update —
#      none of which are deployed as Edge Functions — so they 404 and chat breaks.
#      The hosted deploy MUST use `build:hosted` (MODE=hosted).
#
#   2. nginx serves /var/www/prodev.sbs, which is a COPY, not a symlink to dist/. Building
#      alone changes nothing about what users see.
#
# Both failures are silent: the build succeeds, the site loads, and only a sub-feature breaks.

set -euo pipefail

echo "Deployment blocked: the MYNE Solana program, audited IDL/client, randomness provider and liquidity venue are not ready." >&2
exit 1

FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCROOT="${DEPLOY_DOCROOT:-/var/www/gld.money}"
SITE_URL="${DEPLOY_SITE_URL:-https://gld.money}"

cd "$FRONTEND_DIR"

echo "==> 1/5  sync addresses + ABIs from hardhat"
node scripts/sync-abi.mjs

echo
echo "==> 2/5  verify the deployment matches hardhat"
node -e '
const fs = require("fs");
const a = JSON.parse(fs.readFileSync("src/deployments/4663.json"));
const b = JSON.parse(fs.readFileSync("../hardhat/deployments/4663.json"));
const ka = a.contracts.BullionGridLottery, kb = b.contracts.BullionGridLottery;
if (ka !== kb) { console.error(`  MISMATCH ${ka} != ${kb}`); process.exit(1); }
console.log(`  lottery ${ka}`);
console.log(`  phase   ${a.phase}`);
'

echo
echo "==> 3/5  build (hosted mode — keeps the /supabase proxy branch)"
pnpm build:hosted

echo
echo "==> 4/5  publish to ${DOCROOT}"
if [ ! -d "$DOCROOT" ]; then
  echo "  ERROR: ${DOCROOT} does not exist. Set DEPLOY_DOCROOT if nginx serves elsewhere." >&2
  exit 1
fi
BACKUP="${DOCROOT}.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$DOCROOT" "$BACKUP"
echo "  backup: ${BACKUP}"
rsync -a --delete dist/ "${DOCROOT}/"

echo
echo "==> 5/5  verify what is actually being served"
BUNDLE="$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "${DOCROOT}/index.html" | head -1)"
DIST_BUNDLE="$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)"
[ "$BUNDLE" = "$DIST_BUNDLE" ] || { echo "  ERROR: served ${BUNDLE} != built ${DIST_BUNDLE}" >&2; exit 1; }
[ -f "${DOCROOT}/${BUNDLE}.gz" ] \
  || { echo "  ERROR: precompressed bundle ${BUNDLE}.gz is missing" >&2; exit 1; }

# The proxy branch must survive into the bundle, or the Express-shimmed functions 404.
grep -q '/supabase' "${DOCROOT}/${BUNDLE}" \
  || { echo "  ERROR: '/supabase' proxy path absent — built in the wrong mode?" >&2; exit 1; }

# The live lottery address must be in the bundle.
LOTTERY="$(node -e 'process.stdout.write(require("./src/deployments/4663.json").contracts.BullionGridLottery.replace(/^0x/,""))')"
grep -qi "$LOTTERY" "${DOCROOT}"/assets/*.js \
  || { echo "  ERROR: lottery ${LOTTERY} not found in the served bundle" >&2; exit 1; }

CODE="$(curl -sk -o /dev/null -w '%{http_code}' "${SITE_URL}/" --max-time 20 || echo 000)"
echo "  bundle  ${BUNDLE}"
echo "  proxy   /supabase present"
echo "  lottery 0x${LOTTERY}"
echo "  ${SITE_URL} -> HTTP ${CODE}"
[ "$CODE" = "200" ] || { echo "  WARNING: site did not return 200" >&2; }

echo
echo "deployed."
