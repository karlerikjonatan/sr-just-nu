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
    .sort();

  const html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>Just nu: 📸</title>
  </head>
  <body>
    ${files.map(f => `
      <div style="width: 712px; margin: 0 auto;">
        <img src="screenshots/${f}" loading="lazy">
      </div>
    `).join('\n')}
  </body>
</html>
  `.trim();

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
