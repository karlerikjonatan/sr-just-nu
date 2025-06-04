const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL = 'https://www.sverigesradio.se';
const OUTPUT_DIR = path.join(__dirname, 'docs', 'screenshots');

async function ensureDir(dir) {
  return fs.promises.mkdir(dir, { recursive: true });
}

async function getElements(page) {
  const spans = await page.$$('span');
  const elements = [];

  for (const span of spans) {
    const text = await page.evaluate(el => el.textContent, span);
    if (text.includes('Just nu: ')) {
      const parentElement = await page.evaluateHandle(el => {
        let parent = el;
        while (parent && parent.tagName !== 'H2') {
          parent = parent.parentElement;
        }
        return parent;
      }, span);

      const element = parentElement.asElement();
      if (element) elements.push(element);
    }
  }

  return elements;
}

async function saveScreenshots(elements, outputDir) {
  const timestamp = Date.now();
  await ensureDir(outputDir);

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const filename = `${timestamp}_${i}.png`;
    await element.screenshot({ path: path.join(outputDir, filename) });
  }
}

function generateHTML(dir) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .reverse();

  const html = `<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%B8%3C/text%3E%3C/svg%3E"><title>Just nu</title><style>*{margin:0;padding:0}img{display:block;height:auto;max-width:100%}body{align-items:center;display:flex;flex-direction:column;gap:0.25rem;padding:0.25rem}</style></head><body>${files.map(f => `<img src="screenshots/${f}" loading="lazy" width="768" height="32">`).join("")}</body></html>`;

  fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), html);
}

async function main() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle2' });

    const elements = await getElements(page);

    if (elements.length === 0) {
      console.log('No matching elements found');
      return;
    }

    await saveScreenshots(elements, OUTPUT_DIR);
    console.log(`Saved ${elements.length} screenshot(s)`);
    generateHTML(OUTPUT_DIR);
    console.log('Generated HTML');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    if (browser) await browser.close();
  }
}

main();
