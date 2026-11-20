const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { ARCHIVE_PATH, loadArchive, saveArchive, validateArchive } = require('../archive');

async function migrateScreenshotsToWebp(
  screenshotsDirectory = path.join(__dirname, '..', 'docs', 'screenshots'),
  archivePath = ARCHIVE_PATH,
) {
  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const updated = {
    ...archive,
    captures: archive.captures.map(capture => ({
      ...capture,
      filename: capture.filename.replace(/\.png$/, '.webp'),
    })),
  };
  validateArchive(updated);

  const pngFiles = fs.readdirSync(screenshotsDirectory).filter(file => file.endsWith('.png'));
  const existing = new Set(fs.readdirSync(screenshotsDirectory));
  const archived = new Set(archive.captures.map(capture => capture.filename));
  for (const capture of archive.captures) {
    if (capture.filename.endsWith('.png') && !existing.has(capture.filename)) {
      throw new Error(`Missing screenshot: ${capture.filename}`);
    }
  }
  for (const filename of pngFiles) {
    if (!/^\d+_\d+\.png$/.test(filename)) throw new Error(`Invalid screenshot filename: ${filename}`);
    const webpFilename = filename.replace(/\.png$/, '.webp');
    if (existing.has(webpFilename) && !archived.has(webpFilename)) {
      throw new Error(`WebP screenshot already exists: ${webpFilename}`);
    }
  }

  const stagingDirectory = fs.mkdtempSync(path.join(screenshotsDirectory, '.webp-migration-'));
  const promoted = [];
  let archiveSaved = false;
  try {
    const conversions = pngFiles.filter(filename => !existing.has(filename.replace(/\.png$/, '.webp')));
    const batchSize = 16;
    for (let i = 0; i < conversions.length; i += batchSize) {
      await Promise.all(conversions.slice(i, i + batchSize).map(filename => {
        const source = path.join(screenshotsDirectory, filename);
        const destination = path.join(stagingDirectory, filename.replace(/\.png$/, '.webp'));
        return sharp(source).webp({ lossless: true }).toFile(destination);
      }));
    }

    for (const filename of conversions) {
      const webpFilename = filename.replace(/\.png$/, '.webp');
      const destination = path.join(screenshotsDirectory, webpFilename);
      fs.linkSync(path.join(stagingDirectory, webpFilename), destination);
      promoted.push(destination);
    }

    if (archive.captures.some(capture => capture.filename.endsWith('.png'))) {
      saveArchive(updated, archivePath);
      archiveSaved = true;
    } else {
      loadArchive(archivePath);
    }

    for (const filename of pngFiles) fs.unlinkSync(path.join(screenshotsDirectory, filename));
    return { converted: conversions.length, removed: pngFiles.length };
  } catch (error) {
    if (!archiveSaved) {
      for (const filename of promoted) fs.unlinkSync(filename);
    }
    throw error;
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  migrateScreenshotsToWebp().then(({ converted, removed }) => {
    console.log(`Converted ${converted} screenshots and removed ${removed} PNG files`);
  }).catch(error => {
    console.error('Screenshot migration failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { migrateScreenshotsToWebp };
