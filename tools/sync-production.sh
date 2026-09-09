#!/usr/bin/env bash
# Publish this site to PRODUCTION (parcradio.org).
#
#   PARC_PASSCODE=... ./tools/sync-production.sh          # build + verify only
#   PARC_PASSCODE=... ./tools/sync-production.sh --push   # also push a branch
#
# The deployment chain is:
#   this repo  -> parcradio.net  (beta,       parctesting/beta)
#              -> parcradio.org  (production, parctesting/parctesting.github.io)
#
# Production lives in a SEPARATE repo that shares no history with this one - it
# is the pre-facelift 2019 site. So this replaces its tree wholesale; there is
# no sensible merge between the two histories.
#
# Until 2026-09-07 production served all 15 VE exam scripts in plaintext,
# because that repo has no _config.yml and therefore no `exclude:` list. The
# guard below refuses to publish a tree that would repeat that.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD_OWNER="parctesting"
PROD_NAME="parctesting.github.io"
PROD_REPO="git@github.com:$PROD_OWNER/$PROD_NAME.git"
PROD_BRANCH="master"

# Pushing straight to production needs write access to the parctesting account.
# Without it, push to a fork instead and open a cross-repo PR - the normal
# contributor route, and it needs nothing but a fork you own:
#
#   PROD_FORK=collinpikeusa ./tools/sync-production.sh --push
#
# Create the fork once at:
#   https://github.com/parctesting/parctesting.github.io/fork
PROD_FORK="${PROD_FORK:-}"
WORK_BRANCH="production-facelift"
PROD_DOMAIN="parcradio.org"
PUSH="${1:-}"

[ -n "$(git status --porcelain)" ] && { echo "Working tree is not clean. Commit or stash first."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BUILD="$TMP/build"; mkdir -p "$BUILD"

echo "Building for $PROD_DOMAIN …"
git archive HEAD | tar -x -C "$BUILD"
printf '%s' "$PROD_DOMAIN" > "$BUILD/CNAME"
( cd "$BUILD"
  SITE_ORIGIN="https://$PROD_DOMAIN" node tools/retheme.mjs >/dev/null
  node tools/fix-alt.mjs >/dev/null 2>&1 || true
  SITE_ORIGIN="https://$PROD_DOMAIN" node tools/build-seo.mjs >/dev/null
  node tools/build-search-index.mjs >/dev/null )

# --- guards. Any failure here means do not publish. ---
# Written as `if` blocks, not `[ ... ] && { ... }`: under `set -e` a false test
# makes the whole compound return 1 and kills the script silently.
fail=0
# grep exits 1 when it finds nothing, which is a legitimate answer here. Under
# `set -e` + pipefail that aborts the script mid-count, so each of these is
# wrapped: the count is the signal, not grep's exit status.
ENC=$( { grep -rl 've-payload' "$BUILD/pages" 2>/dev/null || true; } | wc -l)
PLAIN=$( { grep -rlE 'read aloud|room scan procedure' "$BUILD/pages" 2>/dev/null || true; } \
         | while read -r f; do grep -q 've-payload' "$f" || echo "$f"; done | wc -l)
TOK=$( { grep -ho '"token": "[a-f0-9]*"' "$BUILD/index.html" || true; } | sed 's/.*: "//;s/"//')

if [ -f "$BUILD/.nojekyll" ]; then echo "  FAIL .nojekyll present - would publish plaintext"; fail=1; fi
if [ -d "$BUILD/_ve-source" ]; then echo "  FAIL _ve-source present"; fail=1; fi
if ! grep -q '_ve-source' "$BUILD/_config.yml" 2>/dev/null; then
  echo "  FAIL _config.yml missing its exclude list"; fail=1; fi
if [ "$ENC" -lt 19 ]; then echo "  FAIL only $ENC encrypted VE pages, expected 19"; fail=1; fi
if [ "$PLAIN" -gt 0 ]; then echo "  FAIL $PLAIN page(s) carry script text without ciphertext"; fail=1; fi
if [ "$TOK" != "86375f5cd0ea45a9a9083404b92011b6" ]; then
  echo "  FAIL wrong analytics token: ${TOK:-none}"; fail=1; fi
if [ "$fail" = "1" ]; then echo "Refusing to publish."; exit 1; fi

echo "  ok  19 VE pages encrypted, no plaintext, exclude list present"
echo "  ok  token $TOK, CNAME $(cat "$BUILD/CNAME")"

if [ "$PUSH" != "--push" ]; then
  echo
  echo "Build verified. Re-run with --push to publish a branch."
  exit 0
fi

if [ -n "$PROD_FORK" ]; then
  PUSH_REPO="git@github.com:$PROD_FORK/$PROD_NAME.git"
  echo "Pushing to fork $PROD_FORK/$PROD_NAME (PR will target $PROD_OWNER)"
else
  PUSH_REPO="$PROD_REPO"
fi

echo "Cloning production …"
git clone -q --depth 20 --branch "$PROD_BRANCH" "$PROD_REPO" "$TMP/prod"
git -C "$TMP/prod" remote set-url --push origin "$PUSH_REPO"
# A fresh clone inherits nothing when there is no global git identity, and the
# commit below then fails with "Author identity unknown". Carry this repo's.
git -C "$TMP/prod" config user.name  "$(git config user.name)"
git -C "$TMP/prod" config user.email "$(git config user.email)"
cd "$TMP/prod"
git checkout -q -b "$WORK_BRANCH"
# Replace the tree: drop every tracked file, then lay the new build down.
git rm -rq . >/dev/null
cp -a "$BUILD/." .
git add -A
git commit -q -m "Replace the 2019 site with the current build

Production was still the pre-facelift site, and with no _config.yml it served
all 15 VE exam scripts in plaintext at guessable URLs. This replaces the tree
with the build already running on parcradio.net, rebuilt for parcradio.org:
CNAME, canonicals, sitemap, robots and the analytics token all name .org.

The 19 VE pages are AES-256-GCM ciphertext with an unlock shell, and the
exclude: list keeps their plaintext out of the published site."
# Force is correct here, not a shortcut. This branch is not developed on: every
# run recreates it from production's master and replaces the whole tree, so a new
# build is never a descendant of the last one and a plain push always rejects.
# Nothing is lost - the content comes from this repo, which has the real history.
git push -u --force origin "$WORK_BRANCH"
echo
echo "Open the PR:"
if [ -n "$PROD_FORK" ]; then
  echo "  https://github.com/$PROD_OWNER/$PROD_NAME/compare/$PROD_BRANCH...$PROD_FORK:$WORK_BRANCH?expand=1"
else
  echo "  https://github.com/$PROD_OWNER/$PROD_NAME/compare/$PROD_BRANCH...$WORK_BRANCH?expand=1"
fi
