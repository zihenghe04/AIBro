// A single resource contract for the HTTP server and both desktop builders.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readManifest(root = __dirname) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'asset-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.web) || !Array.isArray(manifest.runtime)) {
    throw new Error('Invalid asset manifest');
  }
  const optional = manifest.optionalRuntime || [];
  if (!Array.isArray(optional)) throw new Error('Invalid optional runtime resources');
  const declared = [...manifest.web, ...manifest.runtime, ...optional, 'asset-manifest.json'];
  if (new Set(declared).size !== declared.length || declared.some(file => typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file))) {
    throw new Error('The asset manifest must contain unique, root-relative filenames');
  }
  const files = [...manifest.web, ...manifest.runtime, ...optional.filter(file => fs.existsSync(path.join(root, file))), 'asset-manifest.json'];
  for (const file of files) {
    if (!fs.existsSync(path.join(root, file)) || !fs.statSync(path.join(root, file)).isFile()) {
      throw new Error(`Missing application resource: ${file}`);
    }
  }
  return { ...manifest, files };
}

function validateAssets(root = __dirname) {
  const manifest = readManifest(root);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/gi)].map(match => match[1].split(/[?#]/)[0]);
  for (const file of references.filter(file => !/^(?:https?:|data:|#)/.test(file))) {
    if (!manifest.web.includes(file.replace(/^\.\//, ''))) throw new Error(`HTML references an unpublished resource: ${file}`);
  }
  return manifest;
}

function fingerprint(root = __dirname) {
  const hash = crypto.createHash('sha256');
  for (const file of readManifest(root).files.sort()) {
    hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(path.join(root, file))); hash.update('\0');
  }
  return hash.digest('hex');
}

function copyAssets(destination, root = __dirname) {
  const manifest = validateAssets(root);
  fs.mkdirSync(destination, { recursive: true });
  // A reused destination must not silently retain an addon that the current
  // build omitted. Only remove declared optional files, never other contents.
  for (const file of manifest.optionalRuntime || []) {
    if (!manifest.files.includes(file)) fs.rmSync(path.join(destination, file), { force: true });
  }
  for (const file of manifest.files) fs.copyFileSync(path.join(root, file), path.join(destination, file));
  return manifest.files.length;
}

module.exports = { readManifest, validateAssets, fingerprint, copyAssets };
if (require.main === module) {
  if (process.argv[2] === '--copy' && process.argv[3]) {
    console.log(`Copied ${copyAssets(path.resolve(process.argv[3]))} application resources`);
  } else {
    const manifest = validateAssets();
    console.log(`Validated ${manifest.files.length} application resources (${fingerprint().slice(0, 12)})`);
  }
}
