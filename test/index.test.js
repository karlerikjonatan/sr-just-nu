const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateManifest, main } = require('../index');

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

  generateManifest(screenshotDir, {}, manifestPath);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.map(item => item.f), [
    '101_0.png',
    '100_10.png',
    '100_2.png',
    '99_20.png',
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
