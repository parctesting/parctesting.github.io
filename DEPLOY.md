# Deploying parcradio.net

Two audiences: **the site owner** (`parctesting`, who owns the live site) and
**contributors** working from a fork.

Everything here is enforced by `node tools/deploy.mjs`, which refuses to commit
or push if any check fails. When in doubt, run it — it will tell you what's wrong.

---

## How this site is wired

| | |
|---|---|
| `parctesting/beta` | Owner's repo. **Public, Pages enabled — this serves parcradio.net.** |
| `collinpikeusa/parc-website-beta` | Fork. Contributors work here and open PRs. |
| Live URL | `parcradio.net` (via the `CNAME` file) |

**The repository must stay public.** GitHub Pages on the **Free** plan requires
it: *"If the account that owns the repository uses GitHub Free… the repository
must be public."* Making it private would take the site offline unless the
account upgrades to Pro or Team.

That is safe here because **the exam scripts are encrypted, not merely hidden.**
Repository visibility protects nothing; the AES-256-GCM encryption does.

---

## ⚠️ Four things that will break this site

**1. Never commit `_ve-source/`.** It holds the plaintext exam scripts.
Forks cannot be made private, and per GitHub: *"Commits can remain accessible in
the repository network even after a fork is deleted."* One accidental push is
permanent — force-pushing and deleting the fork will not remove it.

**2. Never create a `.nojekyll` file.** It disables Jekyll, which disables the
`exclude:` list in `_config.yml`, which publishes every build directory.

**3. Never run `retheme.mjs` after `parc-lock.mjs`.** retheme regenerates
`pages/`, and an earlier version silently replaced the encrypted VE pages with
empty unlock forms. It now refuses to touch them, and `deploy.mjs` checks that
all 18 still carry ciphertext.

**4. Never hand-edit a file in `pages/`.** Everything there is generated. Edit
the source (`_ve-source/` for scripts, `tools/site-data.mjs` for titles and nav)
and rebuild. Anything typed directly into `pages/` disappears on the next build.

---

## One-time setup

### A. Repository and Pages — required

- [ ] Repo `parctesting/beta` is **public** (required for Free-plan Pages)
- [ ] **Settings → Pages → Source:** Deploy from a branch → `main` / `(root)`
- [ ] `CNAME` contains `parcradio.net` and is committed
- [ ] **Settings → Pages → Enforce HTTPS** is ticked
- [ ] Confirm no `.nojekyll` file exists anywhere in the repo

### B. Prove the plaintext is not published — do this after the first deploy

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://parcradio.net/_ve-source/script.html
```

**Must print `404`.** If it prints `200`, the exam scripts are live in plaintext:
stop, check `_config.yml`, and confirm no `.nojekyll` exists. Repeat for:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://parcradio.net/tools/parc-lock.mjs
curl -s -o /dev/null -w "%{http_code}\n" "https://parcradio.net/Documents/PARC%20Handbook1.pdf"
```

Both must also be `404`.

### C. Keep the plaintext scripts somewhere safe — required

`_ve-source/` is gitignored, so it is **not backed up by this repository**.

- [ ] Create a **separate private repo** (private repos are free; they simply
      cannot serve Pages) and keep `_ve-source/` there
- [ ] Give access to whoever maintains exam scripts — without these files nobody
      can rebuild the encrypted pages
- [ ] Keep an offline copy as well (`tar czf parc-ve-source.tar.gz _ve-source`)

### D. Schedule availability — required, or the calendar goes stale

The schedule page reads `data/availability.json`, a snapshot of all Calendly
sessions. Left alone it decays: within about a week the page advertises times
that are already booked. Pick **one**:

**Option 1 — scheduled refresh (simplest).** A GitHub Action that refreshes and
commits. Create `.github/workflows/refresh-availability.yml`:

```yaml
name: Refresh schedule availability
on:
  schedule:
    - cron: '17 */6 * * *'     # every 6 hours
  workflow_dispatch:
permissions:
  contents: write
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: node tools/fetch-availability.mjs --days=21
      - run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/availability.json
          git diff --staged --quiet || git commit -m "Refresh schedule availability"
          git push
```

Free on public repos. **Note:** GitHub disables scheduled workflows after 60
days with no repository activity — re-enable from the Actions tab if it stops.

**Option 2 — Cloudflare Worker (live data, never stale).** See below.

### E. Cloudflare Worker — optional, replaces the snapshot with live data

The Worker exists because Calendly's availability endpoint sends no CORS header,
so the page cannot call it directly. The Worker's only job is to add that header
and merge the calendars.

- [ ] Create a free Cloudflare account
- [ ] Deploy:

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

- [ ] Copy the URL it prints, e.g. `https://parc-availability.<you>.workers.dev`
- [ ] Put it in `pages/calendar.html` on the `<div id="schedule">` element:

```html
<div id="schedule" data-availability-endpoint="https://parc-availability.<you>.workers.dev">
```

- [ ] Rebuild and deploy

**No DNS change is needed** — it runs on `workers.dev`, and parcradio.net keeps
being served by GitHub Pages. The page prefers the Worker and falls back to the
snapshot automatically, so both paths work.

> This reads an **undocumented** Calendly endpoint. Calendly can change it
> without notice. If the merged calendar ever stops appearing, that is the first
> thing to check — the site keeps working, it just falls back.

### F. Reviews and Our Team — one Worker, a KV store, and a Turnstile widget

`pages/reviews.html` collects a star rating and a short comment. It needs a
second Worker plus somewhere to keep what people write, so this is a little more
involved than section E.

**Reviews appear on the page as soon as they are submitted.** Nobody has to
approve them. What keeps the page usable is Cloudflare Turnstile stopping
automated submissions, a cap of three a day from one address, and a hard refusal
of anything containing a phone number or email address. What none of that stops
is a real person writing something abusive — that is visible until somebody
deletes it, which is the trade for not having a queue to read.

#### 1. Deploy the Worker and its storage

```bash
cd worker
./deploy-reviews-worker.sh
```

The script creates the KV namespace on the first run and stops so you can paste
the id it prints into `wrangler-reviews.toml`. Run it again and it deploys, then
prompts for the moderation key.

- [ ] **Choose a long random moderation key** when prompted (`openssl rand -base64 24`).
      It is the only thing between the public and the delete button. Store it in
      a password manager — it is never written into this repository and cannot be
      recovered from Cloudflare, only replaced.

#### 2. Create the Turnstile widget

- [ ] Cloudflare dashboard → **Turnstile** → Add widget
- [ ] Name it `parc-reviews`; **Hostnames:** `radiotests.org`, `parcradio.net`,
      `parcradio.org`; **Widget mode:** Managed
- [ ] It gives you two keys. They are not interchangeable:

| Key | Where it goes | Public? |
|---|---|---|
| **Site key** | the web page, via the command below | yes, by design |
| **Secret key** | the Worker, as `TURNSTILE_SECRET` | **never commit it** |

- [ ] Put the secret in the Worker: Workers & Pages → `parc-reviews` → Settings →
      Variables and Secrets → Add → type **Secret** → name `TURNSTILE_SECRET`
- [ ] Put the site key in the page, from the repository root:

```bash
node tools/set-turnstile-key.mjs 0xYOUR_SITE_KEY
```

That command refuses a key of secret-key length, so pasting the wrong half stops
rather than publishing it.

#### 3. Wire up the Worker URL and deploy

```bash
node tools/set-reviews-url.mjs https://parc-reviews.<you>.workers.dev
```

Then `node tools/deploy.mjs --push`.

**Half-configured is safe in one direction only.** With no site key the page never
loads Turnstile and the Worker accepts submissions without a token — the form
works, unprotected. With the secret set but no site key, every submission is
refused. So set the site key first, or both together.

#### 4. Taking a review down

Set these once per terminal session:

```bash
export REVIEWS_URL=https://parc-reviews.<you>.workers.dev
```

```bash
export REVIEWS_ADMIN_KEY=<the key you chose>
```

Then `node tools/moderate-reviews.mjs` lists what is on the page with an id each,
and this removes one:

```bash
node tools/moderate-reviews.mjs delete <id>
```

Deletion is immediate and permanent. The page reads live, so nothing needs
rebuilding — and there is nothing to undo it with.

#### 5. Our Team page

The same Worker also serves `pages/team.html` — **no second Worker, no second KV
namespace, no second copy of the secrets.** Team records live in the namespace
you already made, under their own prefix. Pasting the current
`worker/parc-reviews.js` into the existing Worker is the whole deployment.

**The submission form is not on the public page.** It sits on a passcode-locked
VE page, `pages/team-submit.html`, reachable from the VE section. The public page
only displays profiles.

**Profiles publish as soon as they are sent**, and come off again with a delete:

```bash
node tools/moderate-team.mjs
```

That lists everyone on the page with an id each. `delete <id>` removes a profile
and its photo together, immediately — the page reads live, so nothing needs
rebuilding. Uses the same `REVIEWS_URL` and `REVIEWS_ADMIN_KEY` as the review
tool.

Photographs are resized to a 480px square in the volunteer's browser before
upload, so a photo straight from a phone is fine, and are served from their own
cached URL rather than inlined in the list.

##### Optional: make the VE lock a real gate

The form already sits behind the VE passcode, which keeps visitors away from it.
The Worker endpoint, though, is reachable by anyone who works out the URL and the
shape of the request — so on its own this is an unlisted door, not a locked one.

If that matters, give the locked page a submit code:

```bash
node tools/set-team-code.mjs "$(openssl rand -base64 24)"
```

Add the same value to the Worker as a secret named `TEAM_SUBMIT_CODE`, then
rebuild so the page is re-encrypted with it:

```bash
PARC_PASSCODE=... node tools/parc-lock.mjs
```

The code then exists only inside that page's ciphertext, so holding it is proof
of holding the VE passcode. **Re-run `set-team-code.mjs` whenever the VE passcode
changes** — anyone who had the old passcode kept a copy of the code with it.

Skip all of this and the form still works; it is simply not gated, and the team
page is worth glancing at now and then.

> **No `AggregateRating` markup, deliberately.** Star ratings can be made to show
> in Google results, but only from an independent review platform. Google's own
> guidance treats self-serving markup — a site publishing rating markup about
> itself — as ineligible, and acting on it risks a manual action against the
> whole domain. The page shows the average to visitors; it does not claim it to
> search engines.

### G. Search visibility — owner only

- [ ] Verify `parcradio.net` in [Google Search Console](https://search.google.com/search-console)
- [ ] Paste the verification token into `SITE.googleSiteVerification` in
      `tools/site-data.mjs`, rebuild, deploy
- [ ] Submit `https://parcradio.net/sitemap.xml`
- [ ] **Removals →** request removal of any `parcradio.net/pages/script*` URLs
      already indexed, and the equivalent github.com URLs. `noindex` works on its
      own but takes weeks; removal requests take hours.
- [ ] Consider a Google Business Profile for the in-person Roanoke/Auburn sessions

### H. Traffic analytics — already wired, one token per domain

Cloudflare Web Analytics. Cookieless, no personal data, no consent banner — the
reason it is here rather than Google Analytics is that the schedule page asks
minors for a date of birth, so anything setting cookies is the wrong tool.

The token is chosen by hostname at build time from `SITE.analyticsTokens` in
`tools/site-data.mjs`, resolved through `SITE_ORIGIN`:

| Domain | Token |
|---|---|
| `radiotests.org` | `9ba7325d05ee4c318c7d359aefcac7a8` |
| `parcradio.net` | `a3f57bbf8cf048d69b86140eb93c297d` |
| `parcradio.org` | `86375f5cd0ea45a9a9083404b92011b6` |

**These are not secrets.** Each ships in the HTML of every page it builds and is
readable in View Source. Do not store them with `ADMIN_KEY` or `TURNSTILE_SECRET`.

Three things worth knowing:

- **`noindex` pages get no beacon.** That is all 19 VE pages plus `payhere`,
  `team-submit` and `ve-file`. Examiners reopen script pages repeatedly during a
  live session, which would inflate pageviews and make any old-site/new-site
  comparison meaningless. It also keeps volunteers out of the data.
- **An unlisted host emits no beacon at all**, rather than falling back to another
  domain's token. Silence is the safe failure; mislabelled traffic is not. Add the
  host to `analyticsTokens` when you add a domain.
- **`sync-live-branch.sh` prints the token it built with.** Check that line: a
  wrong token still renders perfectly and only shows up as another site's traffic
  climbing for no reason.

To add a domain: create the site in Cloudflare dash → Web Analytics → Add a site,
add the hostname and token to `analyticsTokens`, rebuild, deploy.

---

## Routine: updating the site

### Change page text, nav, titles, or descriptions

Edit the real source — never a file in `pages/`:

| To change | Edit |
|---|---|
| Page title / description / SEO | `tools/site-data.mjs` |
| Navigation menu | `tools/site-data.mjs` (`NAV`) |
| Footer, contact details | `tools/site-data.mjs` (`SITE`) |
| A public page's body text | that page in `pages/`, between `<div class="container">` and `<footer>` |
| An exam script | `_ve-source/<name>.html` |
| Colours, fonts, layout | `css/site.css` |

Then:

```bash
PARC_PASSCODE='...' node tools/deploy.mjs --refresh --push
```

That rebuilds in the correct order, refreshes availability, runs every check,
commits, and pushes. **If any check fails it stops and pushes nothing.**

Leave off `--push` to review first, or use `--check` to verify without building.

### Change the VE passcode

```bash
node tools/parc-lock.mjs        # prompts; never written to the repo
node tools/deploy.mjs --push
```

Re-encrypts every page and PDF with a fresh salt, which invalidates every VE's
cached key so everyone is asked again. **Tell the VE team the new passphrase
before deploying** — the old one stops working immediately.

> The passcode is currently `2018`, built with `--allow-weak`. Short codes are
> normally refused: the published ciphertext lets an attacker guess offline with
> no rate limit, and 10,000 four-digit combinations fall in roughly two hours on
> a Raspberry Pi and under a second on a GPU. It still keeps the scripts out of
> every search index and stops casual discovery, but it will not stop someone
> who decides to target it. A four-word passphrase is dramatically stronger and
> costs nothing.

---

## Contributor workflow (fork → PR)

```bash
git checkout -b my-change
# …edit…
node tools/deploy.mjs --check          # must pass before you push
git push -u origin my-change
```

Open the PR against `parctesting/beta`. Before merging, the owner should confirm
the PR **does not** touch `_ve-source/`, `design/`, or add `.nojekyll`.

---

## If something goes wrong

**Roll the live site back:**

```bash
git checkout main
git reset --hard pre-facelift-2026-08-22
git push --force-with-lease origin main
```

`pre-facelift-2026-08-22` (and the branch `backup/pre-facelift`) point at the
site exactly as it was before this rebuild. Pages redeploys in a minute or two.

**Exam scripts look wrong:** they are encrypted, so check `_ve-source/`, then
`node tools/deploy.mjs --check` — it compares script text against the tag and
fails if a single word has drifted.

**VE pages show a passphrase box that never unlocks:** `retheme.mjs` ran after
`parc-lock.mjs` and wiped the ciphertext. Re-run
`PARC_PASSCODE='...' node tools/parc-lock.mjs`.

**The merged calendar disappeared:** the availability snapshot or Worker failed.
The page falls back on its own; run `node tools/fetch-availability.mjs --days=21`.

---

## Pre-launch checklist

- [ ] `node tools/deploy.mjs --check` passes with no failures
- [ ] `_ve-source/` backed up to a private repo **and** offline
- [ ] VE team has the passcode
- [ ] Availability refresh scheduled (Action or Worker)
- [ ] Pages set to `main` / `(root)`, HTTPS enforced
- [ ] After deploy: `/_ve-source/script.html`, `/tools/parc-lock.mjs`, and
      `/Documents/PARC%20Handbook1.pdf` all return **404**
- [ ] Spot-check on a phone: schedule page, a script page unlock, the nav menu
- [ ] Search Console verified, sitemap submitted, removals requested
