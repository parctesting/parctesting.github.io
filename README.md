# parcradio.net

Static site for PARC Radio & Technology.

**This repository is a public fork of `parctesting/beta`.** The upstream repo is
what serves parcradio.net via GitHub Pages; changes reach the live site by pull
request to the owner.

---

## ⚠️ Never commit the plaintext exam scripts

The VE scripts live in `_ve-source/`, which is **gitignored on purpose**. Only the
encrypted output (`pages/*.html`, `ve/files/*.enc`) belongs in this repository.

Two GitHub behaviours make a mistake here permanent, both quoted from their docs:

- *"You cannot change the visibility of a fork by itself."* This repo cannot be
  made private while `parctesting/beta` is public.
- *"Commits can remain accessible in the repository network even after a fork is
  deleted."* Anything pushed here stays retrievable by commit SHA through the
  upstream repo. Deleting the fork or force-pushing does **not** undo it.

So the encryption — not repository visibility — is what protects the scripts.
That is the correct design regardless: it also means GitHub Pages keeps working
on the **Free** plan, which requires the repository to be public
(*"If the account that owns the repository uses GitHub Free… the repository must
be public"*).

**Keep `_ve-source/` in a separate private repository.** Private repos are free;
they simply cannot serve Pages, which does not matter because they only hold
source. A dated tarball backup also sits at `~/parc-ve-source-backup-*.tar.gz`.

Before any push, confirm nothing plaintext is staged:

```bash
git status --porcelain | grep _ve-source && echo "STOP" || echo "clean"
```

---

## Layout

| Path | What it is |
|---|---|
| `index.html`, `pages/*.html`, `404.html` | Published pages |
| `_ve-source/*.html` | **Plaintext exam scripts — edit these**, never `pages/script.html` |
| `_ve-source/documents/` | VE training PDFs, plaintext |
| `css/site.css` | The whole stylesheet |
| `js/` | `site.js` (nav), `schedule.js`, `ve-lock.js`, `ve-file.js` |
| `tools/` | Build scripts (not published) |
| `worker/` | Cloudflare Worker for merged Calendly availability |
| `design/` | Unused art and PSDs (not published) |

`_ve-source/`, `tools/`, `worker/`, and `design/` are kept off the live site by
the `exclude:` list in `_config.yml`.

## Deploying

See **[DEPLOY.md](DEPLOY.md)** for the full checklist — one-time setup, the
Cloudflare Worker, scheduled availability refresh, Search Console, and rollback.

Day to day, one command does everything and refuses to push if anything is wrong:

```bash
PARC_PASSCODE='...' node tools/deploy.mjs --refresh --push
```

Verify without changing anything:

```bash
node tools/deploy.mjs --check
```

## Everyday tasks

### Build order matters

`tools/retheme.mjs` regenerates public pages. `tools/parc-lock.mjs` generates the
encrypted VE pages. **Run retheme first, then parc-lock.** retheme now refuses to
touch VE pages for exactly this reason — an earlier version regenerated them as
empty unlock forms and silently discarded the ciphertext, leaving pages that
could never be unlocked.

```bash
node tools/retheme.mjs && node tools/build-seo.mjs && node tools/parc-lock.mjs
```

**Edit an exam script** — edit the file in `_ve-source/`, then re-lock:

```bash
node tools/parc-lock.mjs
```

**Change page titles, descriptions, or the nav** — edit `tools/site-data.mjs`, then:

```bash
node tools/retheme.mjs && node tools/build-seo.mjs
```

`retheme.mjs` rewrites only the head, header, nav, and footer of each page. Everything
between `<div class="container">` and `<footer>` is copied through untouched.

**Changing the VE passphrase:**

```bash
node tools/parc-lock.mjs
```

It prompts, re-encrypts every page and PDF with a fresh salt, and invalidates every
VE's cached key so everyone is asked again. The passphrase is never written to the repo.

**The passcode is currently `2018`**, built with `--allow-weak`. Short codes are refused
by default for a reason: the published ciphertext lets an attacker guess offline with no
rate limit, and 10,000 four-digit combinations fall in about two hours on a Raspberry Pi
and under a second on a GPU. It still keeps the scripts out of every search index
completely, and stops anyone casually poking around. It will not stop someone who decides
to target it. Upgrading is one command with no `--allow-weak`.

## Before pushing

```bash
node tools/check-content.mjs verify .baseline   # exam script text unchanged
node tools/check-links.mjs                      # no broken internal links
```

Re-baseline after an intentional content edit with
`node tools/check-content.mjs snapshot .baseline`.

## After deploying — the check that matters

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://parcradio.net/_ve-source/script.html
```

Must print **404**. If it prints 200, the plaintext scripts are live: stop and fix
`_config.yml` before anything else.

## Refreshing schedule availability

`pages/calendar.html` shows one merged calendar built from every PARC Calendly session.
It reads `data/availability.json`, a snapshot fetched at build time:

```bash
node tools/fetch-availability.mjs --days=21
```

**Re-run this regularly** (a cron job or GitHub Action works well) — otherwise the page
starts advertising times that are already booked. It says so on its own when the data is
over a day old, but that is a safety net, not a substitute for refreshing it.

Every time links out to Calendly, which is always authoritative about what is still free.

## Live availability instead of a snapshot (optional)

Deploying the Worker replaces the snapshot with live data, so nothing goes stale:

```bash
cd worker && npx wrangler deploy
```

Then put the deployed URL into the `data-availability-endpoint` attribute on
`<div id="schedule">` in `pages/calendar.html`. The page prefers the Worker and falls
back to the snapshot automatically, so both paths give the same UI.
