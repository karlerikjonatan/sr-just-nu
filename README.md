# sr-just-nu

An automated archive of **"Just nu:"** (Swedish for *"Right now:"*) breaking-news
flashes from [Sveriges Radio](https://www.sverigesradio.se). A scheduled job
screenshots each new flash and publishes them as a static gallery on GitHub Pages,
alongside an analytics dashboard.

- **Gallery:** https://karlerikjonatan.github.io/sr-just-nu/
- **Analytics:** https://karlerikjonatan.github.io/sr-just-nu/analytics

## How it works

There is no server and no database — **the repository itself is the database**, and
GitHub provides compute (Actions) and hosting (Pages). The GitHub Actions schedule
remains enabled until the cron-job.org migration below has been verified.

```
cron (GitHub Actions, every 5 min)
  └─ node index.js
       ├─ Puppeteer loads sverigesradio.se
       ├─ finds new  <h2> headlines containing "Just nu:"
       ├─ screenshots each one → docs/screenshots/<timestamp>_<i>.png
       ├─ updates texts.json (dedupe set) and screenshot-sources.json
       └─ regenerates docs/screenshots.json + docs/index.html
  └─ git commit + push  →  GitHub Pages serves docs/
```

### The scraper — [`index.js`](index.js)

1. Loads existing state: `texts.json` (a `Set` of headlines already seen, used to
   avoid re-capturing) and `screenshot-sources.json`.
2. Launches headless Chrome via Puppeteer and opens `sverigesradio.se`.
3. Scans every `<h2>`, keeps those containing `Just nu:` that haven't been seen,
   and resolves each to its source article URL (nearest ancestor/related anchor,
   made absolute).
4. Screenshots each matching element and records its article link.
5. Persists `texts.json` and `screenshot-sources.json`, then regenerates the gallery.
6. If no new headlines are found, it exits without writing anything. On any error
   it exits non-zero so the Action run shows as failed.

### The gallery — [`docs/index.html`](docs/index.html)

A small static shell (**generated — do not hand-edit**). It fetches
[`docs/screenshots.json`](docs/screenshots.json) — a newest-first manifest of
`{ f, href? }` entries — and renders images in batches of 100 as you scroll, using
an `IntersectionObserver`. The manifest is fetched up front; batching limits the
number of image elements added to the page before they are needed.

### The analytics dashboard — [`docs/analytics/index.html`](docs/analytics/index.html)

A standalone, dependency-free page that fetches `texts.json`, tokenizes the
headlines (with a Swedish stopword list), and renders word-frequency stats plus a
searchable list. Search terms deep-link via a `?search=` query parameter.

### The scheduler — [`.github/workflows/screenshot.yml`](.github/workflows/screenshot.yml)

Runs on cron every 5 minutes — at :02, :07, :12, :17, :22, :27, :32, :37, :42,
:47, :52, and :57 past the hour, offset off the top of the hour where GitHub is
most likely to delay scheduled runs (plus manual dispatch). Each run installs deps
with `npm ci`, runs
`node index.js`, then commits and pushes any changes under `docs/`, `texts.json`,
and `screenshot-sources.json`.

### Migrating the scheduler to cron-job.org

cron-job.org can trigger the existing workflow every five minutes; GitHub Actions
still runs Puppeteer, commits archive updates, and publishes via Pages. No scraper
changes or additional server are needed. Manual runs remain available through
**Actions → Screenshot → Run workflow**.

1. In GitHub **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens**, create a token restricted to `karlerikjonatan/sr-just-nu`
   with repository permission **Actions: Read and write**. Set an expiration and
   a reminder to rotate it. The dispatch token does not need Contents write access;
   the workflow uses its own `GITHUB_TOKEN` for archive commits.
2. In your cron-job.org account, create a job named **sr-just-nu Screenshot** with
   an **every five minutes** schedule. Configure the request in its advanced
   settings:

   | Setting | Value |
   | --- | --- |
   | URL | `https://api.github.com/repos/karlerikjonatan/sr-just-nu/actions/workflows/screenshot.yml/dispatches` |
   | Request method | `POST` |
   | Header: `Authorization` | The word `Bearer`, a space, then your fine-grained token |
   | Header: `Accept` | `application/vnd.github+json` |
   | Header: `Content-Type` | `application/json` |
   | Header: `X-GitHub-Api-Version` | `2022-11-28` |
   | Request body | `{"ref":"main"}` |

   `main` is the repository's default branch. Enter the real token only in the
   private cron-job.org job settings, never in this repository, an issue, or a PR.
   Use the Authorization header, not a token in the URL or HTTP Basic auth.
3. Enable failure and recovery email notifications in cron-job.org. Run its test
   request and check the response: GitHub should return **204 No Content**.
   Then check [Screenshot workflow runs](https://github.com/karlerikjonatan/sr-just-nu/actions/workflows/screenshot.yml)
   for a new `workflow_dispatch` run at the test time, targeting `main`, and verify
   it completes successfully. A run with no new headlines correctly makes no
   archive commit.
4. Enable the cron-job.org job and verify an automatically scheduled dispatch
   also completes successfully. Only then remove the `schedule:` block and its
   cron expression/comments from `.github/workflows/screenshot.yml` on `main`,
   keeping `workflow_dispatch`, permissions, and concurrency unchanged. Update
   the scheduler description and diagram above to identify cron-job.org as the
   scheduler. Until this cutover, both schedulers can trigger runs; existing
   concurrency protection serializes them.

A **204** confirms only that GitHub accepted the dispatch, not that the scraper
succeeded or started immediately. Keep GitHub Actions failure notifications
enabled and monitor both services. For a **401**, check token validity/expiry; for
a **403**, check token permissions and repository access; for a **404**, check the
repository/workflow URL and token access; for a **422**, check the branch and
`workflow_dispatch` configuration. If cron-job.org disables the job after repeated
failures, fix the cause, test it, and re-enable it.

To roll back after cutover, disable the cron-job.org job and restore the original
GitHub schedule (`2,7,12,17,22,27,32,37,42,47,52,57 * * * *`) on `main`.

## Data / state files

| File | Purpose |
| --- | --- |
| `texts.json` | Deduplication set of every headline seen (also the analytics dataset). |
| `screenshot-sources.json` | Map of `screenshot filename → source article URL`. |
| `docs/screenshots/*.png` | One screenshot per captured headline. |
| `docs/screenshots.json` | Generated newest-first manifest driving the gallery. |

## Running locally

Requires Node.js 20+.

```bash
npm ci
node index.js
```

This scrapes the live site and updates the files above. Open `docs/index.html` in a
browser (via a local static server so `fetch` works, e.g. `npx serve docs`) to view
the gallery. Running the scraper locally can modify tracked archive files.

Run the tests with `npm test`.

## Tech

Plain Node.js (CommonJS), one dependency ([Puppeteer](https://pptr.dev/)). No build
step, no framework.
