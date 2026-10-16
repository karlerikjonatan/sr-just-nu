const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const { generateHTML, getElements, saveScreenshots, main } = require('../index');
const { capturedAt, headlineId, loadArchive, saveArchive, validateArchive } = require('../archive');
const { migrateArchive } = require('../scripts/migrate-archive');

const emptyArchive = () => ({ schemaVersion: 1, headlines: [], captures: [] });

function fixture(t, archive = emptyArchive()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-just-nu-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'archive.json');
  const outputDir = path.join(directory, 'screenshots');
  fs.mkdirSync(outputDir);
  saveArchive(archive, archivePath);
  return { directory, archivePath, outputDir };
}

function item(text, href = null) {
  return {
    text, href,
    element: { screenshot: async ({ path: file }) => fs.writeFileSync(file, 'image') },
  };
}

function quietMain(t) {
  const originalExitCode = process.exitCode;
  const log = console.log;
  const error = console.error;
  const messages = [];
  console.log = console.error = (...args) => messages.push(args.join(' '));
  t.after(() => {
    process.exitCode = originalExitCode;
    console.log = log;
    console.error = error;
  });
  return messages;
}

function browser() {
  return {
    newPage: async () => ({ goto: async () => {} }),
    close: async () => {},
  };
}

test('migration preserves text order, exact characters, all filenames and known URLs', () => {
  const texts = ['Just nu: A', 'Just nu: a', 'Just nu: A\u00a0B'];
  const sources = { '100_10.png': 'https://example.com/article' };
  const files = ['100_2.png', '100_10.png', '99_0.png'];
  const archive = migrateArchive(texts, sources, files);
  assert.deepEqual(archive.headlines.map(h => h.text), texts);
  assert.deepEqual(archive.headlines.map(h => h.id), texts.map(headlineId));
  assert.deepEqual(archive.captures.map(c => c.filename), [...files].sort());
  for (const capture of archive.captures) {
    assert.equal(capture.headlineId, null);
    assert.equal(capture.articleUrl, sources[capture.filename] ?? null);
    assert.equal(capture.capturedAt, capturedAt(capture.filename));
  }
  assert.deepEqual(migrateArchive(texts, sources, files), archive);
  assert.throws(() => migrateArchive(texts, { '1_0.png': 'https://example.com' }, files), /no screenshot/);
  assert.throws(() => migrateArchive([...texts, texts[0]], sources, files), /unique strings/);
});

test('archive rejects invalid schema, duplicates, references, timestamps and URLs', () => {
  const archive = migrateArchive(['Just nu: A'], {}, ['100_0.png']);
  const invalid = [
    null,
    { ...archive, schemaVersion: 2 },
    { ...archive, headlines: [...archive.headlines, archive.headlines[0]] },
    { ...archive, headlines: [{ id: 'wrong', text: 'Just nu: A' }] },
    { ...archive, captures: [...archive.captures, archive.captures[0]] },
    ...[
      { headlineId: 'unknown' },
      { headlineId: undefined },
      { filename: '../100_0.png' },
      { capturedAt: 'wrong' },
      { articleUrl: 'not a URL' },
      { articleUrl: 'javascript:alert(1)' },
      { articleUrl: undefined },
    ].map(fields => ({ ...archive, captures: [{ ...archive.captures[0], ...fields }] })),
  ];
  for (const value of invalid) assert.throws(() => validateArchive(value));
});

test('missing and malformed storage fail rather than initialize empty state', t => {
  const { directory } = fixture(t);
  const missing = path.join(directory, 'missing.json');
  assert.throws(() => loadArchive(missing), /ENOENT/);
  fs.writeFileSync(missing, '{');
  assert.throws(() => loadArchive(missing), SyntaxError);
});

test('getElements deduplicates exact text within a run without normalizing it', async () => {
  const info = [
    { text: 'Just nu: Seen', href: 'https://example.com/different-article' },
    { text: 'Just nu: New', href: null },
    { text: 'Just nu: New', href: 'https://example.com/another' },
    { text: 'Just nu: new', href: null },
    { text: 'Ordinary news', href: null },
  ];
  const page = {
    $$: async () => info.map(() => ({})),
    $$eval: async selector => selector === 'h2' ? info : undefined,
  };
  const items = await getElements(page, new Set(['Just nu: Seen']));
  assert.deepEqual(items.map(i => i.text), ['Just nu: New', 'Just nu: new']);
});

test('successful batch links captures and preserves headline insertion order', async t => {
  const old = migrateArchive(['Just nu: Old'], {}, ['99_0.png']);
  const { archivePath, outputDir } = fixture(t, old);
  const original = JSON.stringify(old);
  await saveScreenshots([
    item('Just nu: Earlier'),
    item('Just nu: Latest', 'https://example.com/latest'),
  ], outputDir, old, archivePath);
  const archive = loadArchive(archivePath);
  assert.equal(JSON.stringify(old), original);
  assert.deepEqual(archive.headlines.map(h => h.text), ['Just nu: Old', 'Just nu: Latest', 'Just nu: Earlier']);
  assert.equal(archive.captures[1].headlineId, headlineId('Just nu: Earlier'));
  assert.equal(archive.captures[1].articleUrl, null);
  assert.equal(archive.captures[2].headlineId, headlineId('Just nu: Latest'));
  assert.equal(archive.captures[2].articleUrl, 'https://example.com/latest');
  assert.ok(archive.captures[1].filename.endsWith('_0.png'));
  assert.ok(archive.captures[2].filename.endsWith('_1.png'));
  assert.deepEqual(fs.readdirSync(outputDir).sort(), archive.captures.slice(1).map(c => c.filename).sort());
});

test('failed screenshot batch leaves archive intact, removes staged files, and can retry', async t => {
  const { archivePath, outputDir } = fixture(t);
  const before = fs.readFileSync(archivePath, 'utf8');
  const failing = item('Just nu: Failure');
  failing.element.screenshot = async ({ path: file }) => {
    fs.writeFileSync(file, 'partial');
    throw new Error('capture failed');
  };
  await assert.rejects(saveScreenshots([item('Just nu: Success'), failing], outputDir, emptyArchive(), archivePath), /capture failed/);
  assert.equal(fs.readFileSync(archivePath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(outputDir), []);
  await saveScreenshots([item('Just nu: Success'), item('Just nu: Failure')], outputDir, emptyArchive(), archivePath);
  assert.equal(loadArchive(archivePath).headlines.length, 2);
});

test('archive replacement failure rolls back only this batch and retries successfully', async t => {
  const { archivePath, outputDir, directory } = fixture(t);
  const before = fs.readFileSync(archivePath, 'utf8');
  fs.writeFileSync(path.join(outputDir, '1_0.png'), 'orphan');
  const renameSync = fs.renameSync;
  t.after(() => { fs.renameSync = renameSync; });
  fs.renameSync = (source, destination) => {
    if (destination === archivePath) throw new Error('simulated state write failure');
    return renameSync(source, destination);
  };
  await assert.rejects(saveScreenshots([item('Just nu: Retry')], outputDir, emptyArchive(), archivePath), /state write failure/);
  assert.equal(fs.readFileSync(archivePath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(outputDir), ['1_0.png']);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['archive.json', 'screenshots']);
  fs.renameSync = renameSync;
  await saveScreenshots([item('Just nu: Retry')], outputDir, emptyArchive(), archivePath);
  assert.equal(loadArchive(archivePath).headlines[0].text, 'Just nu: Retry');
});

test('failed temporary archive write preserves state and removes new images', async t => {
  const { archivePath, outputDir, directory } = fixture(t);
  const before = fs.readFileSync(archivePath, 'utf8');
  const writeFileSync = fs.writeFileSync;
  t.after(() => { fs.writeFileSync = writeFileSync; });
  fs.writeFileSync = (file, ...args) => {
    if (path.basename(file).startsWith('.archive-')) {
      writeFileSync(file, 'partial');
      throw new Error('disk full');
    }
    return writeFileSync(file, ...args);
  };
  await assert.rejects(saveScreenshots([item('Just nu: Retry')], outputDir, emptyArchive(), archivePath), /disk full/);
  assert.equal(fs.readFileSync(archivePath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(outputDir), []);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['archive.json', 'screenshots']);
});

test('image publication failure rolls back promoted files without removing a competing file', async t => {
  const { archivePath, outputDir } = fixture(t);
  const before = fs.readFileSync(archivePath, 'utf8');
  const linkSync = fs.linkSync;
  let competingFile;
  t.after(() => { fs.linkSync = linkSync; });
  fs.linkSync = (source, destination) => {
    if (destination.endsWith('_1.png')) {
      competingFile = destination;
      fs.writeFileSync(destination, 'competing file');
    }
    return linkSync(source, destination);
  };
  await assert.rejects(saveScreenshots([item('Just nu: A'), item('Just nu: B')], outputDir, emptyArchive(), archivePath), /EEXIST/);
  assert.equal(fs.readFileSync(archivePath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(outputDir), [path.basename(competingFile)]);
  assert.equal(fs.readFileSync(competingFile, 'utf8'), 'competing file');
});

test('interrupted-run images are neither overwritten nor imported', async t => {
  const { archivePath, outputDir } = fixture(t);
  const now = Date.now;
  Date.now = () => 100;
  t.after(() => { Date.now = now; });
  fs.writeFileSync(path.join(outputDir, '100_0.png'), 'orphan');
  await saveScreenshots([item('Just nu: New')], outputDir, emptyArchive(), archivePath);
  assert.equal(fs.readFileSync(path.join(outputDir, '100_0.png'), 'utf8'), 'orphan');
  assert.equal(loadArchive(archivePath).captures[0].filename, '101_0.png');
});

test('main skips every write on no-change runs', async t => {
  quietMain(t);
  const { archivePath, outputDir } = fixture(t);
  const before = fs.statSync(archivePath).mtimeMs;
  await main({
    archivePath, outputDir, launchBrowser: async () => browser(),
    findElements: async () => [],
    captureScreenshots: async () => assert.fail('unexpected capture'),
    generatePage: () => assert.fail('unexpected generation'),
  });
  assert.equal(fs.statSync(archivePath).mtimeMs, before);
  assert.deepEqual(fs.readdirSync(outputDir), []);
});

test('main reports state failures nonzero and closes browser without generating page', async t => {
  const messages = quietMain(t);
  const { archivePath, outputDir } = fixture(t);
  let closed = false;
  await main({
    archivePath, outputDir,
    launchBrowser: async () => ({ ...browser(), close: async () => { closed = true; } }),
    findElements: async () => [item('Just nu: New')],
    captureScreenshots: async () => { throw new Error('simulated state write failure'); },
    generatePage: () => assert.fail('unexpected generation'),
  });
  assert.equal(process.exitCode, 1);
  assert.ok(closed);
  assert.ok(messages.some(message => message.includes('simulated state write failure')));
  assert.ok(!messages.includes('Updated archive.json'));
});

test('main fails before launching browser when archive cannot be loaded', async t => {
  quietMain(t);
  const { archivePath } = fixture(t);
  fs.writeFileSync(archivePath, 'invalid');
  await main({
    archivePath,
    launchBrowser: async () => assert.fail('unexpected browser launch'),
  });
  assert.equal(process.exitCode, 1);
});

test('main captures new exact headlines once and preserves run ordering end to end', async t => {
  quietMain(t);
  const { archivePath, outputDir, directory } = fixture(t);
  const texts = ['Just nu: Latest', 'Just nu: Earlier', 'Just nu: Latest'];
  const handles = texts.map(text => item(text).element);
  const options = {
    archivePath, outputDir,
    launchBrowser: async () => ({
      ...browser(),
      newPage: async () => ({
        goto: async () => {},
        $$: async () => handles,
        $$eval: async selector => selector === 'h2'
          ? texts.map(text => ({ text, href: 'https://example.com/article' })) : undefined,
      }),
    }),
    generatePage: () => generateHTML(path.join(directory, 'index.html')),
  };
  await main(options);
  const archive = loadArchive(archivePath);
  assert.deepEqual(archive.headlines.map(h => h.text), texts.slice(0, 2));
  assert.deepEqual(archive.captures.map(c => c.headlineId),
    ['Just nu: Earlier', 'Just nu: Latest'].map(headlineId));
  const before = fs.readFileSync(archivePath, 'utf8');
  const pageBefore = fs.statSync(path.join(directory, 'index.html')).mtimeMs;
  await main(options);
  assert.equal(fs.readFileSync(archivePath, 'utf8'), before);
  assert.equal(fs.statSync(path.join(directory, 'index.html')).mtimeMs, pageBefore);
  assert.equal(fs.readdirSync(outputDir).length, 2);
});

function htmlScript(html) {
  return html.match(/<script>([\s\S]*?)<\/script>/)[1];
}

test('gallery reads unified archive, sorts numerically, and preserves image/link rendering', async t => {
  const { directory } = fixture(t);
  const file = path.join(directory, 'index.html');
  generateHTML(file);
  assert.equal(fs.readFileSync(file, 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8'));
  const nodes = new Map();
  function node(tag) {
    return {
      tag, attributes: {}, children: [],
      setAttribute(key, value) { this.attributes[key] = value; },
      appendChild(child) {
        if (child.tag === 'fragment') this.children.push(...child.children);
        else this.children.push(child);
      },
    };
  }
  const archive = migrateArchive([], { '100_10.png': 'https://example.com/article' },
    ['100_2.png', '99_20.png', '100_10.png', '101_0.png']);
  vm.runInNewContext(htmlScript(fs.readFileSync(file, 'utf8')), {
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, node(id));
        return nodes.get(id);
      },
      createElement: node,
      createDocumentFragment: () => node('fragment'),
    },
    IntersectionObserver: class { observe() {} disconnect() {} },
    fetch: async url => {
      assert.equal(url, 'archive.json');
      return { ok: true, json: async () => archive };
    },
    console: { error: (...args) => assert.fail(args.join(' ')) },
  });
  await new Promise(resolve => setImmediate(resolve));
  const children = nodes.get('gallery').children;
  const images = children.map(child => child.tag === 'a' ? child.children[0] : child);
  assert.deepEqual(images.map(img => img.attributes.src),
    ['101_0.png', '100_10.png', '100_2.png', '99_20.png'].map(f => `screenshots/${f}`));
  assert.equal(children[1].attributes.href, 'https://example.com/article');
  assert.equal(children[1].attributes.rel, 'noopener noreferrer');
  assert.equal(images[0].attributes.loading, 'lazy');
});

test('analytics reads same-origin archive while preserving normalization and metrics', async () => {
  const nodes = new Map();
  const element = () => ({
    innerHTML: '', textContent: '', value: '', addEventListener() {},
    querySelectorAll: () => [],
  });
  const archive = migrateArchive(['Just nu: A', 'Just nu: A\u00a0B', 'Just nu: A B'], {}, []);
  vm.runInNewContext(htmlScript(fs.readFileSync(path.join(__dirname, '..', 'docs', 'analytics', 'index.html'), 'utf8')), {
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
      },
    },
    window: { location: { search: '' } },
    URLSearchParams,
    Intl,
    fetch: async url => {
      assert.equal(url, '../archive.json');
      return { ok: true, json: async () => archive };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!nodes.get('overview').innerHTML.includes('class="error"'), nodes.get('overview').innerHTML);
  assert.match(nodes.get('overview').innerHTML, /class="metric">2<\/div>/);
  assert.match(nodes.get('textList').innerHTML, /<span>A B<\/span>/);
});
