const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT_DIR = __dirname;
const BUILD_DIR = path.join(ROOT_DIR, 'build');
const DIST_DIR = path.join(BUILD_DIR, 'dist');
const CHROME_DIR = path.join(BUILD_DIR, 'chrome');
const FIREFOX_DIR = path.join(BUILD_DIR, 'firefox');

// Clean / recreate staging directories while keeping dist/ intact across prod/dev runs
[CHROME_DIR, FIREFOX_DIR].forEach((dir) => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// Common extension files to include
const EXTENSION_FILES = [
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'icon16.png',
  'icon48.png',
  'icon128.png',
  'LICENSE',
  'README.md',
];

const baseManifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'manifest.json'), 'utf8'));
const version = baseManifest.version;
const isDev = process.argv.includes('--dev');
const devFirefoxId = process.env.FIREFOX_ADDON_ID || 'steam-ai-filter-dev@alexratman';

console.log(`Packaging Steam AI Filter v${version}${isDev ? ' (DEV BUILD)' : ''}...`);

function populateTarget(targetDir, manifestData) {
  // Copy top-level files
  for (const file of EXTENSION_FILES) {
    const src = path.join(ROOT_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(targetDir, file));
    }
  }

  // Copy icons directory - only include iconsvg.svg which is actively used
  const iconsTarget = path.join(targetDir, 'icons');
  if (!fs.existsSync(iconsTarget)) fs.mkdirSync(iconsTarget, { recursive: true });
  fs.copyFileSync(path.join(ROOT_DIR, 'icons', 'iconsvg.svg'), path.join(iconsTarget, 'iconsvg.svg'));

  // Write custom manifest
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifestData, null, 2), 'utf8');
}

// 1. Chrome Build
const chromeManifest = { ...baseManifest };
delete chromeManifest.browser_specific_settings;
if (isDev) {
  chromeManifest.name = `${baseManifest.name} (Dev)`;
}
populateTarget(CHROME_DIR, chromeManifest);

// 2. Firefox Build
const firefoxGeckoId = isDev
  ? devFirefoxId
  : (process.env.FIREFOX_ADDON_ID || baseManifest.browser_specific_settings?.gecko?.id || 'extensions@iren.blue');

const firefoxManifest = {
  ...baseManifest,
  name: isDev ? `${baseManifest.name} (Dev)` : baseManifest.name,
  background: {
    scripts: ['background.js'],
  },
  browser_specific_settings: {
    gecko: {
      id: firefoxGeckoId,
      strict_min_version: '128.0',
      data_collection_permissions: {
        required: ['none'],
      },
    },
  },
};
populateTarget(FIREFOX_DIR, firefoxManifest);

// 3. Standards-compliant Pure Node ZIP creator (ensures forward slashes '/' on all OS platforms)
function createValidZip(sourceDir, outputFile) {
  const fileEntries = [];

  function collectFiles(dir, relativePath = '') {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      // STRICT POSIX forward slashes for ZIP format
      const entryPath = relativePath ? `${relativePath}/${file}` : file;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        collectFiles(fullPath, entryPath);
      } else {
        fileEntries.push({
          fullPath,
          entryPath,
          data: fs.readFileSync(fullPath),
          mtime: stat.mtime,
        });
      }
    }
  }

  collectFiles(sourceDir);

  // Compute CRC32
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c;
  }
  function getCrc32(buf) {
    let crc = 0 ^ -1;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of fileEntries) {
    const nameBuf = Buffer.from(entry.entryPath, 'utf8');
    const crc = getCrc32(entry.data);
    const compressedData = zlib.deflateRawSync(entry.data);
    const uncompressedSize = entry.data.length;
    const compressedSize = compressedData.length;

    // Convert date to DOS format
    const d = entry.mtime;
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    // Local Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    localHeader.writeUInt16LE(20, 4); // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // Flags: UTF-8 filename (bit 11)
    localHeader.writeUInt16LE(8, 8); // Compression: Deflate
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field len
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader);
    localHeaders.push(compressedData);

    // Central Directory Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central header signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0x0800, 8); // Flags: UTF-8
    centralHeader.writeUInt16LE(8, 10); // Compression: Deflate
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field len
    centralHeader.writeUInt16LE(0, 32); // Comment len
    centralHeader.writeUInt16LE(0, 34); // Disk num
    centralHeader.writeUInt16LE(0, 36); // Internal attr
    centralHeader.writeUInt32LE(0, 38); // External attr
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  const centralDirBuf = Buffer.concat(centralHeaders);
  const centralDirSize = centralDirBuf.length;

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Disk with central dir
  eocd.writeUInt16LE(fileEntries.length, 8); // Number of entries on this disk
  eocd.writeUInt16LE(fileEntries.length, 10); // Total entries
  eocd.writeUInt32LE(centralDirSize, 12); // Central dir size
  eocd.writeUInt32LE(centralDirOffset, 16); // Central dir offset
  eocd.writeUInt16LE(0, 20); // Comment len

  const fullZip = Buffer.concat([...localHeaders, centralDirBuf, eocd]);
  fs.writeFileSync(outputFile, fullZip);
}

const suffix = isDev ? '-dev' : '';
const chromeZip = path.join(DIST_DIR, `steam-ai-filter-chrome-v${version}${suffix}.zip`);
const firefoxZip = path.join(DIST_DIR, `steam-ai-filter-firefox-v${version}${suffix}.zip`);
const firefoxXpi = path.join(DIST_DIR, `steam-ai-filter-firefox-v${version}${suffix}.xpi`);

createValidZip(CHROME_DIR, chromeZip);
createValidZip(FIREFOX_DIR, firefoxZip);
fs.copyFileSync(firefoxZip, firefoxXpi);

console.log(`Created Chrome Zip: ${chromeZip}`);
console.log(`Created Firefox Zip: ${firefoxZip}`);
console.log(`Created Firefox XPI: ${firefoxXpi}`);
console.log('Packaging successfully finished with POSIX compliant directory separators!');
