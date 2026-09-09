#!/usr/bin/env bash
# Deploy the PARC reviews Worker.
#
# Authenticate exactly as for deploy-worker.sh — see the comments at the top of
# that file. Do not paste a Cloudflare token into a chat, a file, or a commit.
#
# This Worker needs two things the availability one does not: a KV namespace to
# store reviews in, and an admin key that gates moderation.
set -euo pipefail
cd "$(dirname "$0")"

CFG="wrangler-reviews.toml"
W="npx --yes wrangler@latest"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ ! -f "$HOME/.config/.wrangler/config/default.toml" ]; then
  echo "Not authenticated."
  echo "Set CLOUDFLARE_API_TOKEN or run: npx wrangler login"
  exit 1
fi

if grep -q 'PASTE_THE_ID_WRANGLER_PRINTS' "$CFG"; then
  echo "No KV namespace yet. Creating one…"
  echo
  $W kv namespace create PARC_REVIEWS --config "$CFG"
  echo
  echo "Copy the id from the output above into $CFG (replacing"
  echo "PASTE_THE_ID_WRANGLER_PRINTS), then run this script again."
  exit 1
fi

echo "Deploying parc-reviews…"
$W deploy --config "$CFG"

echo
echo "Now set the moderation key. Choose a long random one — it is the only"
echo "thing standing between the public and the approve/delete buttons."
echo "wrangler will prompt for it and will not echo it:"
echo
$W secret put ADMIN_KEY --config "$CFG"

cat <<'NEXT'

Deployed. Copy the https://parc-reviews.<your-subdomain>.workers.dev URL printed
above, then from the repository root:

  node tools/set-reviews-url.mjs https://parc-reviews.<your-subdomain>.workers.dev

That wires it into the reviews page, rebuilds, and verifies it responds.

To read what people have submitted:

  export REVIEWS_URL=https://parc-reviews.<your-subdomain>.workers.dev
  export REVIEWS_ADMIN_KEY=<the key you just set>
  node tools/moderate-reviews.mjs
NEXT
