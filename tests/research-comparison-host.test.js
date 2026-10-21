const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const body = source.slice(source.indexOf('// Mark a cited excerpt in the document just opened.'), source.indexOf('\nwindow.SourceComparison?.init'));
function fixture() {
  let release, allowed = true;
  const calls = [], toasts = [], context = vm.createContext({
    storageHydrated: true, serverConflict: false, state: {previewRecord: null}, pdfReaderHandle: null,
    window: {PrivateMode: {isOn: () => false}, NoteConsolidation: {resolveId: (_, id) => id},
      WorkstationI18n: {getLanguage: () => 'zh'}, CitationEvidence: {reveal: ({excerpt}) => {calls.push(['quote', excerpt]); return true;}}},
    document: {dispatchEvent: event => calls.push(['event', event.type])}, CustomEvent: class {constructor(type) {this.type = type;}},
    $: () => ({}), toast: text => toasts.push(text),
    openPreview: async (kind, id, page, guard, canOpen) => {calls.push(['leave',kind,id,page,guard]); await new Promise(r => release = r); if(canOpen()) context.state.previewRecord={type:kind,id};},
    openActivityTarget: async (target, canOpen) => canOpen()
  });
  vm.runInContext(body, context);
  return {context, calls, toasts, guard: () => allowed, revoke: () => {allowed=false;}, release: () => release(true)};
}
test('evidence target uses one editor leave and the exact original record/page', async () => {
  const f=fixture(), pending=f.context.openComparisonTarget({kind:'import',id:'source-a',comparisonEvidence:{page:3,quote:'Exact supporting passage'}},f.guard);
  f.release(); assert.equal(await pending,true);
  assert.deepEqual(f.calls.map(c=>c[0]),['leave','quote','event']);
  assert.deepEqual(f.calls[0].slice(1,4),['import','source-a',3]);
  assert.equal(f.context.state.previewRecord.id,'source-a');
});
test('source access revoked while editor leave is pending prevents navigation and highlight', async () => {
  const f=fixture(), pending=f.context.openComparisonTarget({kind:'note',id:'original',comparisonEvidence:{quote:'Frozen quote'}},f.guard);
  f.revoke();f.release();assert.equal(await pending,false);assert.equal(f.context.state.previewRecord,null);assert.equal(f.calls.length,1);
});
test('merged identities and another active reader cannot be treated as the requested evidence', async () => {
  const f=fixture();f.context.window.NoteConsolidation.resolveId=()=> 'substitute';
  assert.equal(await f.context.openComparisonTarget({kind:'note',id:'original'},f.guard),false);assert.equal(f.calls.length,0);
  f.context.window.NoteConsolidation.resolveId=(_,id)=>id;
  f.context.window.ReadingPane={isActive:()=>false};f.context.ReadingPane=f.context.window.ReadingPane;
  const pending=f.context.openComparisonTarget({kind:'note',id:'original',comparisonEvidence:{quote:'No highlight'}},f.guard);
  f.release();assert.equal(await pending,false);assert.equal(f.calls.length,1);
});
test('an unlocatable quote opens the source honestly with no invented page', async () => {
  const f=fixture();f.context.window.CitationEvidence.reveal=()=>false;
  const pending=f.context.openComparisonTarget({kind:'import',id:'source-a',comparisonEvidence:{page:-1,quote:'Old passage'}},f.guard);
  f.release();assert.equal(await pending,true);assert.equal(f.calls[0][3],1);assert.match(f.toasts[0],/未能唯一定位/);
});
