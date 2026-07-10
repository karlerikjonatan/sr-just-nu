const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL = 'https://www.sverigesradio.se';
const OUTPUT_DIR = path.join(__dirname, 'docs', 'screenshots');
// Stored as a JSON array but used as a Set. Doubles as the scraper's dedup store
// and the dataset the analytics dashboard fetches, so it only ever grows.
const SEEN_TEXTS = path.join(__dirname, 'texts.json');
// Map of screenshot filename -> source article URL, consumed by the gallery.
const SCREENSHOT_SOURCES = path.join(__dirname, 'screenshot-sources.json');

function loadSeenTexts() {
  if (fs.existsSync(SEEN_TEXTS)) {
    try {
      const data = fs.readFileSync(SEEN_TEXTS, 'utf-8');
      return new Set(JSON.parse(data));
    } catch (err) {
      console.error('Error reading texts.json:', err);
    }
  }
  return new Set();
}

function saveSeenTexts(seenTexts) {
  try {
    fs.writeFileSync(SEEN_TEXTS, JSON.stringify([...seenTexts]));
  } catch (err) {
    console.error('Error writing texts.json:', err);
  }
}

function loadScreenshotSources() {
  if (fs.existsSync(SCREENSHOT_SOURCES)) {
    try {
      const data = JSON.parse(fs.readFileSync(SCREENSHOT_SOURCES, 'utf-8'));
      // Only accept a plain object map; guard against a corrupted/legacy shape.
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data;
      }
    } catch (err) {
      console.error('Error reading screenshot-sources.json:', err);
    }
  }
  return {};
}

function saveScreenshotSources(screenshotSources) {
  try {
    fs.writeFileSync(SCREENSHOT_SOURCES, JSON.stringify(screenshotSources, null, 2));
  } catch (err) {
    console.error('Error writing screenshot-sources.json:', err);
  }
}

async function ensureDir(dir) {
  return fs.promises.mkdir(dir, { recursive: true });
}

async function getElements(page, seenTexts) {
  // Remove Sveriges Radio's cookie/consent dialog overlays ([data-open]) so they
  // don't sit on top of the headlines we screenshot.
  await page.$$eval('[data-open]', dialogs => {
    for (const dialog of dialogs) dialog.remove();
  });

  // Query the handles (needed for element.screenshot()) and the derived
  // { text, href } data in one round-trip each. Both use the same selector, so
  // the arrays line up by index.
  const headings = await page.$$('h2');
  const info = await page.$$eval('h2', els => els.map(el => {
    const toAbsoluteUrl = rawHref => {
      if (!rawHref) return null;
      try {
        return new URL(rawHref, window.location.href).href;
      } catch {
        return null;
      }
    };

    // A "Just nu:" <h2> may or may not be wrapped in a link: prefer the heading's
    // own anchor, else the first link in its nearest container, made absolute.
    const resolveHref = () => {
      const ownAnchor = el.closest('a[href]');
      if (ownAnchor) return toAbsoluteUrl(ownAnchor.getAttribute('href'));

      const container = el.closest('article,section,li,div');
      if (container) {
        const relatedAnchor = container.querySelector('a[href]');
        if (relatedAnchor) return toAbsoluteUrl(relatedAnchor.getAttribute('href'));
      }

      return null;
    };

    return { text: (el.textContent || '').trim(), href: resolveHref() };
  }));

  const elements = [];
  for (let i = 0; i < headings.length; i++) {
    const { text, href } = info[i];
    if (text.includes('Just nu:') && !seenTexts.has(text)) {
      seenTexts.add(text);
      elements.push({ element: headings[i], text, href });
    }
  }

  return elements;
}

async function saveScreenshots(items, outputDir, screenshotSources) {
  // One timestamp per run; `${timestamp}_${i}.png` is named so a plain
  // lexicographic filename sort is also chronological (see generateManifest).
  const timestamp = Date.now();
  await ensureDir(outputDir);

  for (let i = 0; i < items.length; i++) {
    const { element, href } = items[i];
    const filename = `${timestamp}_${i}.png`;
    await element.screenshot({ path: path.join(outputDir, filename) });
    if (href) {
      screenshotSources[filename] = href;
    }
  }
}

function generateManifest(dir, screenshotSources) {
  // Filenames are timestamp-prefixed, so sort() is chronological and reverse()
  // gives newest-first — the order the gallery renders in.
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .reverse();

  const manifest = files.map(f => {
    const href = screenshotSources[f];
    return href ? { f, href } : { f };
  });

  fs.writeFileSync(path.join(__dirname, 'docs', 'screenshots.json'), JSON.stringify(manifest));
}

function generateHTML() {
  // Static shell. The gallery is populated client-side from screenshots.json in
  // batches so the page loads instantly regardless of archive size. Nodes are
  // built with DOM APIs (never innerHTML), so scraped hrefs can't inject markup.
  const html = `<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%B8%3C/text%3E%3C/svg%3E"><title>Just nu:</title><style>*{margin:0;padding:0}img{display:block;height:auto;max-width:100%}body{display:flex;flex-direction:column;gap:0.25rem;padding:0.25rem}a{display:block}#sentinel{height:1px}</style></head><body><div id="gallery"></div><div id="sentinel"></div><script>
(function () {
  var BATCH = 100;
  var gallery = document.getElementById('gallery');
  var sentinel = document.getElementById('sentinel');
  var items = [];
  var cursor = 0;

  function renderBatch() {
    var end = Math.min(cursor + BATCH, items.length);
    var frag = document.createDocumentFragment();
    for (; cursor < end; cursor++) {
      var item = items[cursor];
      var img = document.createElement('img');
      img.setAttribute('src', 'screenshots/' + item.f);
      img.setAttribute('loading', 'lazy');
      img.setAttribute('width', '768');
      img.setAttribute('height', '32');
      if (item.href) {
        var a = document.createElement('a');
        a.setAttribute('href', item.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.appendChild(img);
        frag.appendChild(a);
      } else {
        frag.appendChild(img);
      }
    }
    gallery.appendChild(frag);
    if (cursor >= items.length) observer.disconnect();
  }

  var observer = new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting && cursor < items.length) renderBatch();
  });

  fetch('screenshots.json', { cache: 'no-cache' })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      items = data;
      renderBatch();
      observer.observe(sentinel);
    })
    .catch(function (err) { console.error('Could not load screenshots.json', err); });
})();
</script></body></html>`;

  fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), html);
}

async function main() {
  let browser;
  const seenTexts = loadSeenTexts();
  const screenshotSources = loadScreenshotSources();

  try {
    browser = await puppeteer.launch({
      headless: true,
      // --no-sandbox is required to run Chrome as root in the CI container.
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle2' });

    const elements = await getElements(page, seenTexts);

    if (elements.length === 0) {
      // Nothing new: skip all writes so the workflow makes no commit this run.
      console.log('No new matching elements found');
      return;
    }

    // getElements returns headings in page order (newest at the top). Reverse so
    // the batch is numbered oldest->newest; generateManifest's sort then restores
    // newest-first for display.
    await saveScreenshots(elements.reverse(), OUTPUT_DIR, screenshotSources);
    console.log(`Saved ${elements.length} new screenshot(s)`);

    saveSeenTexts(seenTexts);
    console.log('Updated texts.json');
    saveScreenshotSources(screenshotSources);
    console.log('Updated screenshot-sources.json');

    generateManifest(OUTPUT_DIR, screenshotSources);
    console.log('Generated screenshots.json');
    generateHTML();
    console.log('Generated HTML');
  } catch (err) {
    console.error('Error:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

// Run only when executed directly (node index.js); the exports let the generators
// be imported for tooling/tests without triggering a scrape.
if (require.main === module) {
  main();
}

module.exports = { generateManifest, generateHTML, getElements };
