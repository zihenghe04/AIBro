const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// app/halaska-ui.js is a build output. A bundle edited by hand, or left stale
// after a change to app/ui/*.jsx or *.css, would ship code the source no longer
// describes and be silently undone by the next rebuild.
test('committed Halaska bundle is exactly what the source builds', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/build-halaska-ui.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
