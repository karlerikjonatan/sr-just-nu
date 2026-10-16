const fs = require('fs');
const path = require('path');
const { ARCHIVE_PATH, capturedAt, headlineId, loadArchive, saveArchive, validateArchive } = require('./archive');

const URL = 'https://www.sverigesradio.se';
const OUTPUT_DIR = path.join(__dirname, 'docs', 'screenshots');

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

async function saveScreenshots(items, outputDir, archive, archivePath) {
  await fs.promises.mkdir(outputDir, { recursive: true });
  const existing = new Set([
    ...fs.readdirSync(outputDir),
    ...archive.captures.map(capture => capture.filename),
  ]);
  let timestamp = Date.now();
  // Interrupted runs may leave unreferenced images. Never overwrite those files.
  while (items.some((_, i) => existing.has(`${timestamp}_${i}.png`))) timestamp++;
  const stagingDirectory = fs.mkdtempSync(path.join(outputDir, '.capture-'));
  const promoted = [];
  const headlines = [];
  const captures = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const { element, text, href } = items[i];
      const filename = `${timestamp}_${i}.png`;
      await element.screenshot({ path: path.join(stagingDirectory, filename) });
      const id = headlineId(text);
      headlines.push({ id, text });
      captures.push({ filename, headlineId: id, articleUrl: href ?? null, capturedAt: capturedAt(filename) });
    }
    const updated = validateArchive({
      schemaVersion: 1,
      // Capture oldest first, but retain the homepage's headline insertion order.
      headlines: [...archive.headlines, ...headlines.reverse()],
      captures: [...archive.captures, ...captures],
    });
    for (const { filename } of captures) {
      const destination = path.join(outputDir, filename);
      // Exclusive creation also protects against a concurrent local writer.
      fs.linkSync(path.join(stagingDirectory, filename), destination);
      promoted.push(destination);
    }
    fs.rmSync(stagingDirectory, { recursive: true });
    saveArchive(updated, archivePath);
  } catch (err) {
    for (const filename of promoted) fs.unlinkSync(filename);
    throw err;
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function generateHTML(file = path.join(__dirname, 'docs', 'index.html')) {
  // Fetch the archive once, then add image elements in batches as the user scrolls.
  // Build nodes with DOM APIs so scraped hrefs are not interpolated into markup.
  const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%B8%3C/text%3E%3C/svg%3E">
  <title>Just nu:</title>
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

  fetch('archive.json', { cache: 'no-cache' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data || data.schemaVersion !== 1 || !Array.isArray(data.captures)) {
        throw new Error('Unsupported archive schema');
      }
      items = data.captures.slice().sort(function (a, b) {
        var partsA = a.filename.slice(0, -4).split('_');
        var partsB = b.filename.slice(0, -4).split('_');
        return Number(partsB[0]) - Number(partsA[0]) || Number(partsB[1]) - Number(partsA[1]);
      }).map(function (capture) {
        return { f: capture.filename, href: capture.articleUrl };
      });
      renderBatch();
      observer.observe(sentinel);
    })
    .catch(function (err) { console.error('Could not load archive.json', err); });
})();
  </script>
</body>
</html>`;

  fs.writeFileSync(file, html);
}

async function main({
  launchBrowser = options => require('puppeteer').launch(options),
  findElements = getElements,
  captureScreenshots = saveScreenshots,
  outputDir = OUTPUT_DIR,
  archivePath = ARCHIVE_PATH,
  generatePage = generateHTML,
} = {}) {
  let browser;

  try {
    const archive = loadArchive(archivePath);
    const seenTexts = new Set(archive.headlines.map(headline => headline.text));
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
    // filenames are assigned oldest to newest; the gallery sorts newest first.
    await captureScreenshots(elements.reverse(), outputDir, archive, archivePath);
    console.log(`Saved ${elements.length} new screenshot(s)`);

    console.log('Updated archive.json');
    generatePage();
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

module.exports = { generateHTML, getElements, saveScreenshots, main };
