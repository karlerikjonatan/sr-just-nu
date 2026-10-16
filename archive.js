const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ARCHIVE_PATH = path.join(__dirname, 'docs', 'archive.json');
const SCREENSHOT_PATTERN = /^(\d+)_(\d+)\.png$/;

function headlineId(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function capturedAt(filename) {
  const match = filename.match(SCREENSHOT_PATTERN);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new Error(`Invalid screenshot filename: ${filename}`);
  }
  const date = new Date(Number(match[1]));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid screenshot timestamp: ${filename}`);
  return date.toISOString();
}

function validateArchive(archive) {
  const fail = message => { throw new Error(`Invalid archive: ${message}`); };
  if (!archive || archive.schemaVersion !== 1 ||
      !Array.isArray(archive.headlines) || !Array.isArray(archive.captures)) {
    fail('expected schemaVersion 1 with headlines and captures arrays');
  }
  const ids = new Set();
  const texts = new Set();
  for (const headline of archive.headlines) {
    if (!headline || typeof headline.text !== 'string' || !headline.text.trim() ||
        headline.id !== headlineId(headline.text)) {
      fail('headline must have nonempty exact text and its SHA-256 ID');
    }
    if (ids.has(headline.id) || texts.has(headline.text)) fail('duplicate headline');
    ids.add(headline.id);
    texts.add(headline.text);
  }
  const filenames = new Set();
  for (const capture of archive.captures) {
    if (!capture || typeof capture.filename !== 'string') fail('capture needs a filename');
    if (filenames.has(capture.filename)) fail(`duplicate capture ${capture.filename}`);
    filenames.add(capture.filename);
    if (capture.capturedAt !== capturedAt(capture.filename)) fail('capture time must match filename');
    if (capture.headlineId !== null && !ids.has(capture.headlineId)) fail('unknown headline reference');
    if (capture.articleUrl !== null) {
      if (typeof capture.articleUrl !== 'string') fail('articleUrl must be a URL or null');
      let url;
      try {
        url = new URL(capture.articleUrl);
      } catch {
        fail('invalid article URL');
      }
      if (!['http:', 'https:'].includes(url.protocol)) fail('article URL must use HTTP(S)');
    }
  }
  return archive;
}

function loadArchive(file = ARCHIVE_PATH) {
  return validateArchive(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function saveArchive(archive, file = ARCHIVE_PATH) {
  validateArchive(archive);
  const temporaryFile = path.join(path.dirname(file), `.archive-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(archive, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryFile, file);
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
}

module.exports = { ARCHIVE_PATH, SCREENSHOT_PATTERN, headlineId, capturedAt, validateArchive, loadArchive, saveArchive };
