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

### The workflow — [`.github/workflows/screenshot.yml`](.github/workflows/screenshot.yml)

Triggered by cron-job.org every 5 minutes via `workflow_dispatch`, or manually
through GitHub Actions. There is no GitHub Actions schedule. Each run installs
deps with `npm ci`, runs
`node index.js`, then commits and pushes any changes under `docs/`, `texts.json`,
and `screenshot-sources.json`.

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
