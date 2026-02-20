const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL = 'https://www.sverigesradio.se';
const OUTPUT_DIR = path.join(__dirname, 'docs', 'screenshots');
const SEEN_TEXTS = path.join(__dirname, 'texts.json');

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

async function ensureDir(dir) {
  return fs.promises.mkdir(dir, { recursive: true });
}

async function getElements(page, seenTexts) {
  await page.$eval('[data-state="open"]', dialog => dialog.remove());

  const spans = await page.$$('h2');
  const elements = [];


  for (const span of spans) {
    const text = await page.evaluate(el => el.textContent.trim(), span);

    if (text.includes('Just nu:') && !seenTexts.has(text)) {
      seenTexts.add(text);

      const url = await page.evaluate(el => {
        // Find closest a tag
        let closestLink = null;
        let current = el;

        // First check if the element itself is within an anchor
        while (current && !closestLink) {
          if (current.tagName === 'A' && current.href) {
            closestLink = current.href;
            break;
          }
          current = current.parentElement;
        }

        // If not found in parents, check siblings and children
        if (!closestLink) {
          let parent = el;
          while (parent && parent.tagName !== 'H2') {
            parent = parent.parentElement;
          }
          if (parent) {
            const link = parent.querySelector('a[href]') || parent.closest('a[href]');
            if (link) closestLink = link.href;
          }
        }

        return closestLink;
      }, span);

      const parentElement = await page.evaluateHandle(el => {
        let parent = el;
        while (parent && parent.tagName !== 'H2') {
          parent = parent.parentElement;
        }
        return parent;
      }, span);

      const element = parentElement.asElement();
      if (element) elements.push({ element, text, url });
    }
  }

  return elements;
}

async function saveScreenshots(items, outputDir) {
  const timestamp = Date.now();
  await ensureDir(outputDir);
  const metadata = [];

  for (let i = 0; i < items.length; i++) {
    const { element, url } = items[i];
    const filename = `${timestamp}_${i}.png`;
    await element.screenshot({ path: path.join(outputDir, filename) });
    metadata.push({ filename, url });
  }

  return metadata;
}

function generateHTML(dir, metadata = []) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .reverse();

  const urlMap = new Map(metadata.map(m => [m.filename, m.url]));

  const html = `<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%B8%3C/text%3E%3C/svg%3E"><title>Just nu</title><style>*{margin:0;padding:0}img{display:block;height:auto;max-width:100%}body{align-items:center;display:flex;flex-direction:column;gap:0.25rem;padding:0.25rem}</style></head><body>${files.map(f => {
    const img = `<img src="screenshots/${f}" loading="lazy" width="768" height="32">`;
    const url = urlMap.get(f);
    return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${img}</a>` : img;
  }).join("")}</body></html>`;

  fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), html);
}

async function main() {
  let browser;
  const seenTexts = loadSeenTexts();

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle2' });

    const elements = await getElements(page, seenTexts);

    if (elements.length === 0) {
      console.log('No new matching elements found');
      return;
    }

    const metadata = await saveScreenshots(elements.reverse(), OUTPUT_DIR);
    console.log(`Saved ${elements.length} new screenshot(s)`);

    saveSeenTexts(seenTexts);
    console.log('Updated text.json');

    generateHTML(OUTPUT_DIR, metadata);
    console.log('Generated HTML');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    if (browser) await browser.close();
  }
}

main();
