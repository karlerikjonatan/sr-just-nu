const fs = require('fs');
const path = require('path');

const URL = 'https://www.sverigesradio.se';
const OUTPUT_DIR = path.join(__dirname, 'docs', 'screenshots');
// Stored as a JSON array but used as a Set. Doubles as the scraper's dedup store
// and the dataset the analytics dashboard fetches, so it only ever grows.
const SEEN_TEXTS = path.join(__dirname, 'texts.json');
// Map of screenshot filename -> source article URL and captured headline.
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
  fs.writeFileSync(SEEN_TEXTS, JSON.stringify([...seenTexts]));
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
  fs.writeFileSync(SCREENSHOT_SOURCES, JSON.stringify(screenshotSources, null, 2));
}

function getPngDimensions(filePath) {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(filePath, 'r');

  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return null;
  } finally {
    fs.closeSync(fd);
  }

  if (
    !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return null;
  }

  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
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
  // Use one timestamp per run; generateManifest sorts the numeric filename parts.
  const timestamp = Date.now();
  await fs.promises.mkdir(outputDir, { recursive: true });

  for (let i = 0; i < items.length; i++) {
    const { element, href, text } = items[i];
    const filename = `${timestamp}_${i}.png`;
    await element.screenshot({ path: path.join(outputDir, filename) });
    screenshotSources[filename] = { href, alt: text };
  }
}

function generateManifest(dir, screenshotSources, manifestPath = path.join(__dirname, 'docs', 'screenshots.json')) {
  // Compare the numeric filename components so multi-digit batch indices sort
  // chronologically as well as timestamps.
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png'))
    .sort((a, b) => {
      const [, timestampA = '', indexA = ''] = a.match(/^(\d+)_(\d+)\.png$/) || [];
      const [, timestampB = '', indexB = ''] = b.match(/^(\d+)_(\d+)\.png$/) || [];
      return Number(timestampB) - Number(timestampA) || Number(indexB) - Number(indexA);
    });

  // Dimensions never change, so reuse them from the previous manifest and only
  // read PNG headers for files that are new.
  let previous = [];
  try {
    previous = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {}
  const knownDimensions = new Map(previous.map(item => [item.f, item]));

  const manifest = files.map(f => {
    const source = screenshotSources[f];
    const href = typeof source === 'string' ? source : source?.href;
    const alt = typeof source === 'object' ? source?.alt : null;
    const known = knownDimensions.get(f);
    const dimensions = known?.width > 0 && known?.height > 0
      ? { width: known.width, height: known.height }
      : getPngDimensions(path.join(dir, f));
    return {
      f,
      ...(href ? { href } : {}),
      alt: typeof alt === 'string' && alt ? alt : 'Screenshot of a Just nu breaking-news headline',
      ...(dimensions || {}),
    };
  });

  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}

function generateHTML(
  outputPath = path.join(__dirname, 'docs', 'index.html'),
  manifestPath = path.join(__dirname, 'docs', 'screenshots.json'),
) {
  // Fetch the manifest once, then add image elements in viewport-sized batches.
  // Build nodes with DOM APIs so scraped hrefs are not interpolated into markup.
  // The gallery fetches the manifest itself, so an absent or unreadable one only
  // means no preload hints.
  let manifest = [];
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {}
  const preloadLinks = manifest.slice(0, 8)
    .filter(item => typeof item.f === 'string' && /^\d+_\d+\.png$/.test(item.f))
    .map((item, i) => `  <link rel="preload" as="image" href="screenshots/${item.f}"${i === 0 ? ' fetchpriority="high"' : ''}>`)
    .join('\n');
  const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%B8%3C/text%3E%3C/svg%3E">
  <title>Just nu:</title>
  <meta name="description" content="Ett bildarkiv över Sveriges Radios senaste Just nu-nyheter.">
${preloadLinks}
  <style>
    * { margin: 0; padding: 0; }
    img { display: block; height: auto; max-width: 100%; }
    body { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.25rem; }
    a { display: block; }
    #sentinel { height: 1px; }
  </style>
</head>
<body>
  <div id="gallery"></div>
  <div id="sentinel"></div>
  <script>
(function () {
  var FALLBACK_IMAGE_WIDTH = 768;
  var FALLBACK_IMAGE_HEIGHT = 32;
  var gallery = document.getElementById('gallery');
  var sentinel = document.getElementById('sentinel');
  var items = [];
  var cursor = 0;

  function itemHeight(item) {
    var contentWidth = gallery.clientWidth || window.innerWidth;
    if (item.width > 0 && item.height > 0) {
      return item.height * Math.min(1, contentWidth / item.width);
    }
    return FALLBACK_IMAGE_HEIGHT * Math.min(1, contentWidth / FALLBACK_IMAGE_WIDTH);
  }

  function countForHeight(start, height) {
    var totalHeight = 0;
    var count = 0;
    while (start + count < items.length && totalHeight < height) {
      totalHeight += itemHeight(items[start + count]);
      count++;
    }
    return Math.max(count, 1);
  }

  function renderBatch() {
    var end = Math.min(cursor + countForHeight(cursor, window.innerHeight * 2), items.length);
    var eagerCount = countForHeight(0, window.innerHeight);
    var frag = document.createDocumentFragment();
    for (; cursor < end; cursor++) {
      var item = items[cursor];
      var img = document.createElement('img');
      img.setAttribute('src', 'screenshots/' + item.f);
      img.setAttribute('alt', item.alt || 'Screenshot of a Just nu breaking-news headline');
      img.setAttribute('loading', cursor < eagerCount ? 'eager' : 'lazy');
      img.setAttribute('decoding', 'async');
      if (cursor === 0) img.setAttribute('fetchpriority', 'high');
      if (item.width > 0 && item.height > 0) {
        img.setAttribute('width', item.width);
        img.setAttribute('height', item.height);
      }
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
  </script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html);
}

async function main({
  launchBrowser = options => require('puppeteer').launch(options),
  findElements = getElements,
  captureScreenshots = saveScreenshots,
  outputDir = OUTPUT_DIR,
  seenTexts = loadSeenTexts(),
  screenshotSources = loadScreenshotSources(),
} = {}) {
  let browser;

  try {
    browser = await launchBrowser({
      headless: true,
      // --no-sandbox is required to run Chrome as root in the CI container.
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle2' });

    const elements = await findElements(page, seenTexts);

    if (elements.length === 0) {
      // Nothing new: skip all writes so the workflow makes no commit this run.
      console.log('No new matching elements found');
      return;
    }

    // The homepage lists newest first. Reverse this local result array in place so
    // filenames are assigned oldest to newest; the manifest sorts newest first.
    await captureScreenshots(elements.reverse(), outputDir, screenshotSources);
    console.log(`Saved ${elements.length} new screenshot(s)`);

    // Write order matters: nothing is committed if any write below throws.
    saveSeenTexts(seenTexts);
    console.log('Updated texts.json');
    saveScreenshotSources(screenshotSources);
    console.log('Updated screenshot-sources.json');

    generateManifest(outputDir, screenshotSources);
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

module.exports = { generateManifest, generateHTML, getElements, main };
