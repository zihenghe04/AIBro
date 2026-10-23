const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const extract = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];

function fixture({ searchOpen = false } = {}) {
  const calls = [];
  const search = { open: searchOpen, close() { calls.push('search.dialog'); this.open = false; } };
  const env = {
    calls,
    $: selector => selector === '#searchDialog' ? search : null,
    commandSearchController: () => ({ close: reason => { calls.push(`search:${reason}`); search.open = false; } }),
    window: {
      CommandSearch: {},
      WorkstationRunHistory: { close: () => calls.push('history') },
      ActivityCenter: { close: () => calls.push('activity') },
      Shortcuts: { close: () => calls.push('shortcuts') },
    },
    showView: { navigationVersion: 0 },
    previewOpenIntent: 0,
    workspaceRouteIntent: 0,
    beforePreviewSwitch: async () => true,
  };
  vm.runInNewContext(`${extract('closeRouteOverlays')}\n${extract('prepareWorkspaceRoute')}\nthis.closeRouteOverlays=closeRouteOverlays;this.prepareWorkspaceRoute=prepareWorkspaceRoute;window.closeRouteOverlays=closeRouteOverlays;`, env);
  return env;
}

test('route change dismisses run history and other page-like overlays', () => {
  const env = fixture({ searchOpen: true });
  env.closeRouteOverlays();
  assert.deepEqual(env.calls, ['history', 'activity', 'shortcuts', 'search:selection']);
  env.calls.length = 0; env.closeRouteOverlays();
  assert.deepEqual(env.calls, ['history', 'activity', 'shortcuts'], 'a closed search dialog is left alone');
});

test('every view change, including native-only destinations, runs the overlay cleanup', async () => {
  assert.match(extract('showView'), /^function showView\(viewId, label\) \{\n  window\.ComposerDictation\?\.cancel\(\);\n  window\.closeRouteOverlays\?\.\(\);/);
  const env = fixture();
  const current = await env.prepareWorkspaceRoute();
  assert.equal(current(), true);
  assert.deepEqual(env.calls, ['history', 'activity', 'shortcuts']);
});

test('a cancelled route gate keeps the overlay open', async () => {
  const env = fixture();
  env.beforePreviewSwitch = async () => false;
  assert.equal(await env.prepareWorkspaceRoute(), null);
  assert.deepEqual(env.calls, []);
});
