#!/usr/bin/env bash
# Rebuild the parcradio.net branch from main.
#
#   PARC_PASSCODE=... ./tools/sync-live-branch.sh
#
# main is the live site: Pages serves radiotests.org from it, so main is built
# for radiotests.org and carries that CNAME. parcradio-net is the same tree
# rebuilt for parcradio.net, and is what upstream PRs come from.
#
# The two branches must differ in exactly two ways: the CNAME file, and the
# SITE_ORIGIN the build is run with. Everything else is identical.
#
# The direction used to be the other way round - a production branch synced out
# to a preview branch. Do not restore that: whichever branch Pages serves has to
# be the one carrying the live CNAME and the live analytics token, or the site
# advertises the wrong canonical and files its traffic under the wrong domain.
#
# This exists because doing it by hand went wrong twice. Copying only
# `tools css js` left pages/ behind, so a label edited on the production branch
# never reached the live site; and running `git checkout <branch> -- ...` over an
# uncommitted tree silently discarded work in progress. Both are avoided here:
# the tree must be clean before anything happens, and every source path is
# copied, not a hand-picked subset.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC_BRANCH="main"            # the live site (radiotests.org)
LIVE_BRANCH="parcradio-net"  # derived; the source for PRs to upstream
LIVE_DOMAIN="parcradio.net"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash first —"
  echo "this script overwrites files from $SRC_BRANCH and would discard them."
  git status --short | sed 's/^/  /'
  exit 1
fi

if [ -z "${PARC_PASSCODE:-}" ]; then
  echo "PARC_PASSCODE is not set; the VE pages could not be re-encrypted."
  echo "Set it so the locked pages are rebuilt from _ve-source/."
  exit 1
fi

echo "Syncing $LIVE_BRANCH from $SRC_BRANCH …"
git checkout -q "$LIVE_BRANCH"

# Everything except CNAME, which is the one file that must differ.
git checkout "$SRC_BRANCH" -- .
echo "$LIVE_DOMAIN" > CNAME

WEAK=""
[ "${#PARC_PASSCODE}" -lt 8 ] && WEAK="--allow-weak"

SITE_ORIGIN="https://$LIVE_DOMAIN" node tools/retheme.mjs >/dev/null
node tools/fix-alt.mjs >/dev/null
SITE_ORIGIN="https://$LIVE_DOMAIN" node tools/build-seo.mjs >/dev/null
node tools/build-search-index.mjs >/dev/null
SITE_ORIGIN="https://$LIVE_DOMAIN" node tools/parc-lock.mjs $WEAK >/dev/null

echo
echo "  CNAME      : $(cat CNAME)"
echo "  canonical  : $(grep -o 'canonical" href="https://[^/]*' index.html | sed 's/.*href="//')"
# The analytics token is keyed off SITE_ORIGIN in tools/site-data.mjs. Printed
# because the failure is silent: a wrong token still renders, it just files this
# site's traffic under another domain, and an empty result means an unlisted host.
echo "  analytics  : $(grep -ho '"token": "[a-f0-9]*"' index.html | sed 's/.*: "//;s/"//')"
echo "  VE payloads: $(grep -l 've-payload' pages/*.html | wc -l)/18"
echo "  tracked _ve-source: $(git ls-files | grep -c '^_ve-source/' || true)"
echo
echo "Review, then:  git add -A && git commit && git push origin $LIVE_BRANCH"
