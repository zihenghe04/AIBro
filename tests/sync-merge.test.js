const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SyncMerge = require('../app/sync-merge');
const fixtures = require('./fixtures/sync-merge.json');
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

for (const fixture of fixtures) test(fixture.name, () => {
  const values = freeze(clone([fixture.base, fixture.proposed, fixture.current]));
  if (fixture.conflict) assert.throws(() => SyncMerge.merge(...values), error => error instanceof SyncMerge.MergeConflict && JSON.stringify(error.path) === JSON.stringify(fixture.conflict));
  else {
    const result = SyncMerge.merge(...values);
    assert.deepEqual(result, fixture.expected);
    assert.notEqual(result, values[1]);
  }
  assert.deepEqual(values, [fixture.base, fixture.proposed, fixture.current]);
});

test('browser export is pure, preserves prototype safety and uses the same JSON fixtures', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../app/sync-merge'), 'utf8'), context);
  assert.equal(typeof context.SyncMerge.merge, 'function');
  const fixture = fixtures.find(item => item.name.startsWith('prototype-like'));
  const result = context.SyncMerge.merge(fixture.base, fixture.proposed, fixture.current);
  assert.deepEqual(clone(result), fixture.expected);
  assert.equal({}.x, undefined);
});

test('shared library folders merge by stable ID and reject scoped name collisions across independent creates',()=>{
 const folder=(id,folderPath)=>({id,folderPath,workspace:'科研',projectId:'p'}),base={folders:{projects:[{id:'sidebar',name:'keep'}],conversations:[],library:[]}};
 const left=clone(base),right=clone(base);left.folders.library=[folder('a','A')];right.folders.library=[folder('b','B')];
 const result=SyncMerge.merge(base,left,right);assert.deepEqual(result.folders.library,[folder('a','A'),folder('b','B')]);assert.deepEqual(result.folders.projects,base.folders.projects);
 right.folders.library=[folder('b','A')];assert.throws(()=>SyncMerge.merge(base,left,right),error=>error instanceof SyncMerge.MergeConflict&&error.path.join('/')==='folders/library');
 right.folders.library=[{...folder('b','A'),projectId:'other'}];assert.equal(SyncMerge.merge(base,left,right).folders.library.length,2);
});
