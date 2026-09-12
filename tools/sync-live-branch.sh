#!/usr/bin/env bash
# Stage main onto the parcradio.net branch, ready for a PR to parctesting/beta.
#
#   ./tools/sync-live-branch.sh           # merge, rebuild, verify - pushes nothing
#   ./tools/sync-live-branch.sh --push    # ...then push parcradio-net
#
# main is the source and serves radiotests.org (gh-pages-preview is force-pushed
# from it). parcradio-net is the same content built for parcradio.net; PRs to
# parctesting/beta come from it. The branches differ in CNAME and in what a build
# stamps from it: canonicals, sitemap, robots and the analytics token. Production
# (parcradio.org) is a separate, later step - tools/sync-production.sh.
#
# Merged, never copied. An earlier version copied main's whole tree over this
# branch, which left it sharing no recent history with the upstream it targets,
# so every PR fought its own base.
#
# data/availability.json is not ours to change. The upstream repo's scheduled job
# rewrites it every three hours, so this branch always carries upstream's copy: a
# PR can neither include the snapshot nor roll it back. Before the workflow was
# limited to the parctesting repos the fork rewrote it too, and every sync
# conflicted on it.
#
# Generated files that conflict are rebuilt, not hand-merged. Any other conflict
# aborts the merge and stops: that is a real disagreement and needs a person.
# (Staging whatever was on disk after a conflict once put conflict markers on the
# live site.)
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=main
NET=parcradio-net
DOMAIN=parcradio.net
SNAP=data/availability.json
UPSTREAM_URL=https://github.com/parctesting/beta.git
PUSH="${1:-}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash first:"
  git status --short | sed 's/^/  /'
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi
git fetch -q upstream
git fetch -q origin
OWNER=$(git remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+$#\1#')

RETURN_TO=$(git rev-parse --abbrev-ref HEAD)
trap 'git checkout -q "$RETURN_TO" 2>/dev/null || true' EXIT
git checkout -q "$NET"

build() {
  SITE_ORIGIN="https://$DOMAIN" node tools/retheme.mjs >/dev/null
  node tools/fix-alt.mjs >/dev/null 2>&1 || true
  SITE_ORIGIN="https://$DOMAIN" node tools/build-seo.mjs >/dev/null
  node tools/build-search-index.mjs >/dev/null
}

markers() {
  grep -rlE '^(<<<<<<<|>>>>>>>) ' . --exclude-dir=.git --exclude-dir=_ve-source \
       --exclude-dir=design --exclude-dir=node_modules 2>/dev/null || true
}

# Merge a ref in, resolving only what is safe to resolve mechanically.
merge_in() {
  local ref="$1" rebuild=0 f left
  if git merge -q --no-edit --no-ff "$ref" >/dev/null 2>&1; then
    echo "  merged $ref"
    return 0
  fi
  while IFS= read -r f; do
    case "$f" in
      CNAME)   printf '%s' "$DOMAIN" > CNAME; git add CNAME ;;
      "$SNAP") git checkout upstream/main -- "$SNAP" ;;
      sitemap.xml|robots.txt|data/search-index.json|index.html|404.html|pages/*.html) rebuild=1 ;;
      *)
        echo "  conflict in $f while merging $ref - that needs a person"
        git merge --abort
        exit 1 ;;
    esac
  done < <(git diff --name-only --diff-filter=U)
  if [ "$rebuild" = "1" ]; then printf '%s' "$DOMAIN" > CNAME; build; fi
  left=$(markers)
  if [ -n "$left" ]; then
    echo "  conflict markers survived the rebuild while merging $ref:"
    echo "$left" | sed 's/^/    /'
    git merge --abort
    exit 1
  fi
  git add -A
  git commit -q --no-edit
  echo "  merged $ref (generated files rebuilt)"
}

echo "Staging $SRC onto $NET for $DOMAIN"
merge_in upstream/main    # stay current with what the PR targets
merge_in "$SRC"

# A page that arrived from main cleanly still carries radiotests.org's canonical
# and token. retheme is idempotent on pages that are already right.
SITE_ORIGIN="https://$DOMAIN" node tools/retheme.mjs >/dev/null
if [ -n "$(git status --porcelain -- index.html 404.html pages)" ]; then
  git add -A index.html 404.html pages
  git commit -q -m "Rebuild pages for $DOMAIN"
  echo "  rebuilt pages that arrived with another domain's values"
fi

# The VE pages are upstream's too. The private VE_Scripts repo's deploy workflow
# encrypts them straight into parctesting/beta, so a PR from here must never carry
# older copies back over them.
VE_OUT=$(node -e "import('./tools/site-data.mjs').then(m => console.log(m.VE_PAGES.join(' ')))")
git checkout upstream/main -- $VE_OUT js/ve-manifest.json ve/files 2>/dev/null || true
if ! git diff --cached --quiet -- $VE_OUT js/ve-manifest.json ve/files; then
  git commit -q -m "Carry upstream's VE pages" -- $VE_OUT js/ve-manifest.json ve/files
  echo "  took upstream's VE pages"
fi

# The snapshot is upstream's, whatever either merge did to it.
git checkout upstream/main -- "$SNAP"
if ! git diff --cached --quiet -- "$SNAP"; then
  git commit -q -m "Carry upstream's availability snapshot" -- "$SNAP"
  echo "  took upstream's availability snapshot"
fi

echo
WANT=$(SITE_ORIGIN="https://$DOMAIN" node -e "import('./tools/site-data.mjs').then(m => console.log(m.SITE.analyticsToken))")
CANON=$(node -e "import('./tools/site-data.mjs').then(m => console.log(m.SITE.canonicalOrigin))")
fail=0
ok()  { printf "  ok    %s\n" "$1"; }
bad() { printf "  FAIL  %s\n" "$1"; fail=1; }

if [ "$(cat CNAME)" = "$DOMAIN" ]; then ok "CNAME $DOMAIN"; else bad "CNAME is $(cat CNAME)"; fi

wrong=""
for f in index.html pages/*.html; do
  if grep -q 'name="robots"[^>]*noindex' "$f"; then continue; fi
  t=$(grep -ho '"token": "[a-f0-9]*"' "$f" | head -1 | sed 's/.*: "//;s/"//' || true)
  c=$(grep -o 'rel="canonical" href="[^"]*"' "$f" | head -1 || true)
  case "$c" in *"$CANON/"*) ;; *) wrong="$wrong $f" ;; esac
  if [ "$t" != "$WANT" ]; then wrong="$wrong $f"; fi
done
if [ -z "$wrong" ]; then ok "every public page credits $CANON and carries $DOMAIN's token"; else bad "wrong canonical or token in:$wrong"; fi

if grep -q "https://$DOMAIN/" sitemap.xml; then ok "sitemap names $DOMAIN"; else bad "sitemap does not name $DOMAIN"; fi
if [ -z "$(markers)" ]; then ok "no conflict markers"; else bad "conflict markers present"; fi
if git merge-tree --write-tree upstream/main HEAD >/dev/null 2>&1; then ok "merges into upstream cleanly"; else bad "would conflict with upstream"; fi
if node tools/deploy.mjs --check >/dev/null 2>&1; then ok "deploy checks"; else bad "tools/deploy.mjs --check - run it to see why"; fi

echo "  a PR would carry:"
git diff --name-only upstream/main HEAD | sed 's/^/    /'

if [ "$fail" = "1" ]; then echo; echo "Not pushing."; exit 1; fi

if [ "$PUSH" = "--push" ]; then
  git push -q origin "$NET"
  echo
  echo "Pushed. Open the PR:"
  echo "  https://github.com/parctesting/beta/compare/main...$OWNER:$NET?expand=1"
else
  echo
  echo "Verified. Re-run with --push to push $NET."
fi
