const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const url = 'https://www.sverigesradio.se';
const outputDir = path.join(__dirname, 'docs', 'screenshots');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });

  const spanHandles = await page.$$('span');
  const matchingParents = [];

  for (const span of spanHandles) {
    const text = await page.evaluate(el => el.textContent, span);
    if (text.includes("Just nu: ")) {
      const parentH2Handle = await page.evaluateHandle(el => {
        let parent = el;
        while (parent && parent.tagName !== 'H2') {
          parent = parent.parentElement;
        }
        return parent;
      }, span);

      const element = parentH2Handle.asElement();
      if (element) {
        matchingParents.push(element);
      }
    }
  }

  if (matchingParents.length === 0) {
    await browser.close();
    process.exit(0);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  for (let i = 0; i < matchingParents.length; i++) {
    const element = matchingParents[i];
    const filename = `${Date.now()}.png`;
    await element.screenshot({ path: path.join(outputDir, filename) });
  }

  await browser.close();

  generateHTML(outputDir);
})();

function generateHTML(dir) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .reverse();

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Just nu:</title>
    </head>
    <body>
      ${files.map(f => `
        <div style="width: 712px; margin: 0 auto;">
          <img src="screenshots/${f}">
        </div>
      `).join('\n')}
    </body>
    </html>
    `
    .trim();

  fs.writeFileSync(path.join(__dirname, 'docs', 'index.html'), html);
}