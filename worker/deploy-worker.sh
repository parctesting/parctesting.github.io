#!/usr/bin/env bash
# Deploy the PARC availability Worker.
#
# Run this yourself — it needs your Cloudflare credentials, which nobody else
# should handle. Two ways to authenticate:
#
#   A) API token (works on a headless machine over SSH — recommended here)
#      Create one at:
#        https://dash.cloudflare.com/profile/api-tokens
#        → Create Token → "Edit Cloudflare Workers" template → Continue → Create
#      Then, in your own shell:
#        export CLOUDFLARE_API_TOKEN='paste-it-here'
#        ./deploy-worker.sh
#      Do not paste the token into a chat, a file, or a commit.
#
#   B) Browser login (only if you are sitting at a machine with a browser)
#        npx wrangler login && ./deploy-worker.sh
#      Over SSH this needs a port forward, because the OAuth callback goes to
#      localhost:8976 on whichever machine wrangler is running on:
#        ssh -L 8976:localhost:8976 pi@10.0.0.38
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ ! -f "$HOME/.config/.wrangler/config/default.toml" ]; then
  echo "Not authenticated."
  echo "Set CLOUDFLARE_API_TOKEN (option A above) or run: npx wrangler login"
  exit 1
fi

echo "Deploying parc-availability…"
npx --yes wrangler@latest deploy

cat <<'NEXT'

Deployed. Copy the https://parc-availability.<your-subdomain>.workers.dev URL
printed above, then from the repository root:

  node tools/set-worker-url.mjs https://parc-availability.<your-subdomain>.workers.dev

That wires it into the schedule page, rebuilds, and verifies it returns data.
NEXT
