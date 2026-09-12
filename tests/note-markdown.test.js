const {test}=require('node:test');const assert=require('node:assert/strict');const M=require('../note-markdown');
test('export writes current identity and all source IDs while preserving exact edited body and custom YAML',()=>{
 const body='\n# My edited title\n\n```yaml\nsourceAttachmentIds: []\n```\n';
 const note={id:'n',paperId:'p',title:'New',projectId:'new-project',workspace:'科研',sourceAttachmentIds:['a','b'],content:'---\nid: "p"\ntitle: Old\nsourceAttachmentIds:\n  - a\ncustom:\n  private_label: yes\n---\n'+body};
 const output=M.serialize(note);assert.ok(output.endsWith(body));assert.match(output,/sourceAttachmentIds: \["a","b"\]/);assert.match(output,/custom:\n  private_label: yes/);assert.doesNotMatch(output,/title: Old/);assert.match(output,/projectId: "new-project"/);assert.match(output,/paperId: "p"/);
 assert.equal(M.serialize({...note,content:output}),output);
});
test('incomplete YAML-like body is treated as literal content, not discarded',()=>{
 const content='---\nno closing delimiter\n';const result=M.serialize({id:'n',content,title:'Title'});assert.ok(result.includes(content));
});
test('BOM and quoted managed YAML keys cannot override current source identity',()=>{
 const result=M.serialize({id:'current',sourceAttachmentIds:['new'],content:'\uFEFF---\n"sourceAttachmentIds": ["old"]\n\'id\': old-id\ncustom: kept\n---\n# Body'});
 assert.doesNotMatch(result,/old-id|\["old"\]/);assert.equal((result.match(/^---$/gm)||[]).length,2);assert.ok(result.endsWith('# Body'));assert.match(result,/custom: kept/);
});
