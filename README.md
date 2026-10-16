# sr-just-nu

An automated archive of **"Just nu:"** (Swedish for *"Right now:"*) breaking-news
flashes from [Sveriges Radio](https://www.sverigesradio.se). A scheduled job
screenshots each new flash and publishes them as a static gallery on GitHub Pages,
alongside an analytics dashboard.

- **Gallery:** https://karlerikjonatan.github.io/sr-just-nu/
- **Analytics:** https://karlerikjonatan.github.io/sr-just-nu/analytics

## How it works

There is no server and no database — **the repository itself is the database**, and
GitHub provides compute (Actions) and hosting (Pages), with cron-job.org providing
the schedule through workflow dispatch.

```
cron (cron-job.org, every 5 min) → GitHub Actions workflow dispatch
  └─ node index.js
       ├─ Puppeteer loads sverigesradio.se
       ├─ finds new  <h2> headlines containing "Just nu:"
       ├─ screenshots each one → docs/screenshots/<timestamp>_<i>.png
       ├─ atomically updates docs/archive.json (headlines + captures)
       └─ regenerates docs/index.html
  └─ git commit + push  →  GitHub Pages serves docs/
```

### The scraper — [`index.js`](index.js)

1. Loads and validates `docs/archive.json`, building a `Set` of exact headline
   texts to avoid re-capturing. Missing, invalid, or unsupported storage fails
   the run rather than silently starting an empty archive.
2. Launches headless Chrome via Puppeteer and opens `sverigesradio.se`.
3. Scans every `<h2>`, keeps those containing `Just nu:` that haven't been seen,
   and resolves each to its source article URL (nearest ancestor/related anchor,
   made absolute).
4. Screenshots each matching element into a staging directory and records its
   headline reference, article link (when available), and capture time.
5. Publishes the complete batch and atomically replaces `docs/archive.json`,
   then regenerates the gallery shell. If capturing or saving state fails, the
   previous archive stays intact and images created by that attempt are removed,
   so those headlines remain eligible on the next run.
6. If no new headlines are found, it exits without writing anything. On any error
   it exits non-zero so the Action run shows as failed.

### The gallery — [`docs/index.html`](docs/index.html)

A small static shell (**generated — do not hand-edit**). It fetches
[`docs/archive.json`](docs/archive.json), sorts captures newest-first by numeric
filename timestamp and batch index, and renders images in batches of 100 as you
scroll, using an `IntersectionObserver`. The archive is fetched up front;
batching limits the number of image elements added before they are needed.
Known article URLs make screenshots clickable.

### The analytics dashboard — [`docs/analytics/index.html`](docs/analytics/index.html)

A standalone, dependency-free page that fetches `../archive.json` from the same
site, tokenizes the headlines (with a Swedish stopword list), and renders
word-frequency stats plus a searchable list. Search terms deep-link via a
`?search=` query parameter. Existing whitespace normalization and analytics
deduplication are unchanged; the scraper still deduplicates by exact text.

### The workflow — [`.github/workflows/screenshot.yml`](.github/workflows/screenshot.yml)

Triggered by cron-job.org every 5 minutes via `workflow_dispatch`, or manually
through GitHub Actions. There is no GitHub Actions schedule. Each run installs
deps with `npm ci`, runs
`node index.js`, then commits and pushes any changes under `docs/`.

## Data / state files

| File | Purpose |
| --- | --- |
| `docs/archive.json` | Canonical versioned storage used by the scraper, gallery, and analytics. |
| `docs/screenshots/*.png` | One screenshot per captured headline. |

### Archive schema (version 1)

```json
{
  "schemaVersion": 1,
  "headlines": [
    { "id": "<SHA-256 of exact UTF-8 text>", "text": "Just nu: Example" }
  ],
  "captures": [
    {
      "filename": "1781809174400_0.png",
      "headlineId": null,
      "articleUrl": null,
      "capturedAt": "2026-06-18T18:59:34.400Z"
    }
  ]
}
```

`headlines` preserves original insertion order and exact text. IDs are
deterministic lowercase SHA-256 hex strings. The same exact headline is never
captured again, even if it appears on a different article.

Each capture has a unique filename, a nullable headline ID, a nullable HTTP(S)
article URL, and a UTC ISO capture timestamp derived from its filename.
`capturedAt` describes scraper observation time, not article publication time.
Capture array order is not the gallery's display order.

The historical migration preserves 10,782 headlines, 10,781 screenshots, and
1,471 known article links. The old files did not connect headline texts to
screenshots, so historical `headlineId` fields are deliberately `null`; the
9,310 unknown article URLs are also `null`. No positional pairing or historical
recovery is attempted. New captures always reference their headline.

The one-time migration helper is `scripts/migrate-archive.js`. It expects the
original root-level `texts.json` and `screenshot-sources.json` plus the screenshot
directory, validates their contents, and refuses to overwrite an existing
archive. Those legacy JSON files and the generated `docs/screenshots.json`
manifest are no longer used or stored.

Screenshots left unreferenced by an interrupted process are not imported or
overwritten on retry. Temporary staging directories and JSON writes are ignored
by Git. Actions serializes runs; do not run multiple local scrapers against the
same archive concurrently.

## Running locally

Requires Node.js 22.12 or later, matching the Puppeteer version in the lockfile.
The GitHub Actions workflow currently uses Node.js 24.

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
