const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateHTML, generateManifest, main } = require('../index');

test('generateHTML sizes batches and eager loading to the viewport', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-just-nu-'));
  const htmlPath = path.join(directory, 'index.html');
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify([
    { f: '123_0.png', alt: 'Just nu: test headline' },
    { f: '122_0.png', alt: 'Just nu: another headline' },
  ]));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  generateHTML(htmlPath, manifestPath);
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.match(html, /function itemHeight\(item\)/);
  assert.match(html, /function countForHeight\(start, height\)/);
  assert.match(html, /countForHeight\(cursor, window\.innerHeight \* 2\)/);
  assert.match(html, /countForHeight\(0, window\.innerHeight\)/);
  assert.match(html, /img\.setAttribute\('width', item\.width\)/);
  assert.match(html, /<link rel="preload" as="image" href="screenshots\/123_0\.png" fetchpriority="high">/);
  assert.match(html, /<link rel="preload" as="image" href="screenshots\/122_0\.png">/);
  assert.match(html, /meta name="description"/);
  assert.match(html, /img\.setAttribute\('alt', item\.alt \|\| /);
  assert.match(html, /var eagerCount = countForHeight\(0, window\.innerHeight\);/);
  assert.match(html, /img\.setAttribute\('loading', cursor < eagerCount \? 'eager' : 'lazy'\);/);
  assert.match(html, /img\.setAttribute\('decoding', 'async'\);/);
  assert.match(html, /if \(cursor === 0\) img\.setAttribute\('fetchpriority', 'high'\);/);
  assert.doesNotMatch(html, /setAttribute\('width', '768'\)/);
});

test('generateManifest sorts timestamp and batch index numerically, newest first', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-just-nu-'));
  const manifestPath = path.join(directory, 'manifest.json');
  const screenshotDir = path.join(directory, 'screenshots');
  fs.mkdirSync(screenshotDir);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const filenames = ['100_2.png', '99_20.png', '100_10.png', '101_0.png'];
  for (const filename of filenames) {
    fs.writeFileSync(path.join(screenshotDir, filename), '');
  }
  const pngHeader = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader);
  pngHeader.write('IHDR', 12, 'ascii');
  pngHeader.writeUInt32BE(688, 16);
  pngHeader.writeUInt32BE(24, 20);
  fs.writeFileSync(path.join(screenshotDir, '101_0.png'), pngHeader);

  generateManifest(screenshotDir, {
    '101_0.png': { href: 'https://example.com/article', alt: 'Just nu: newest headline' },
    '100_10.png': 'https://example.com/legacy-article',
  }, manifestPath);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest, [
    {
      f: '101_0.png',
      href: 'https://example.com/article',
      alt: 'Just nu: newest headline',
      width: 688,
      height: 24,
    },
    {
      f: '100_10.png',
      href: 'https://example.com/legacy-article',
      alt: 'Screenshot of a Just nu breaking-news headline',
    },
    {
      f: '100_2.png',
      alt: 'Screenshot of a Just nu breaking-news headline',
    },
    {
      f: '99_20.png',
      alt: 'Screenshot of a Just nu breaking-news headline',
    },
  ]);
});

test('main exits nonzero when saving scraper state fails', async t => {
  const writeFileSync = fs.writeFileSync;
  const originalExitCode = process.exitCode;
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const logs = [];
  const stateFile = path.resolve(__dirname, '..', 'texts.json');

  fs.writeFileSync = function (file, ...args) {
    if (path.resolve(file) === stateFile) {
      throw new Error('simulated state write failure');
    }
    return writeFileSync.call(this, file, ...args);
  };
  console.error = (...args) => logs.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));

  t.after(() => {
    fs.writeFileSync = writeFileSync;
    process.exitCode = originalExitCode;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  });

  await main({
    launchBrowser: async () => ({
      newPage: async () => ({ goto: async () => {} }),
      close: async () => {},
    }),
    findElements: async () => [{ text: 'Just nu: test', href: null }],
    captureScreenshots: async () => {},
    seenTexts: new Set(),
    screenshotSources: {},
  });

  assert.equal(process.exitCode, 1);
  assert.ok(logs.some(message => message.includes('simulated state write failure')), logs.join('\n'));
  assert.ok(!logs.includes('Updated texts.json'));
});
