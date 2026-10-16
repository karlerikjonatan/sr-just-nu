const fs = require('node:fs');
const path = require('node:path');
const { ARCHIVE_PATH, capturedAt, headlineId, saveArchive, validateArchive } = require('../archive');

function migrateArchive(texts, sources, filenames) {
  if (!Array.isArray(texts) || !texts.every(text => typeof text === 'string') ||
      new Set(texts).size !== texts.length) {
    throw new Error('Legacy headlines must be unique strings');
  }
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new Error('Legacy sources must be a filename-to-URL map');
  }
  const files = new Set(filenames);
  for (const filename of Object.keys(sources)) {
    if (!files.has(filename)) throw new Error(`Source has no screenshot: ${filename}`);
  }
  return validateArchive({
    schemaVersion: 1,
    headlines: texts.map(text => ({ id: headlineId(text), text })),
    captures: [...filenames].sort().map(filename => ({
      filename,
      headlineId: null,
      articleUrl: Object.hasOwn(sources, filename) ? sources[filename] : null,
      capturedAt: capturedAt(filename),
    })),
  });
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  if (fs.existsSync(ARCHIVE_PATH)) throw new Error('Archive already exists; refusing to overwrite');
  const texts = JSON.parse(fs.readFileSync(path.join(root, 'texts.json'), 'utf8'));
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'screenshot-sources.json'), 'utf8'));
  const files = fs.readdirSync(path.join(root, 'docs', 'screenshots')).filter(file => file.endsWith('.png'));
  const archive = migrateArchive(texts, sources, files);
  saveArchive(archive);
  console.log(`Migrated ${archive.headlines.length} headlines and ${archive.captures.length} captures`);
}

module.exports = { migrateArchive };
