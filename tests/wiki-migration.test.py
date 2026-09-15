import copy,os,tempfile,unittest,base64,io,zipfile
from unittest.mock import patch
host=tempfile.TemporaryDirectory(prefix='aibro-wiki-migration-host-');os.environ.setdefault('AI_WORKSTATION_DATA_DIR',host.name)
from server import WorkspaceStore
from wiki_migration import WikiMigration
from wiki_vault import WikiVaultError
class MigrationTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=WorkspaceStore(self.tmp.name);self.m=WikiMigration(self.store)
  self.store.save({'projects':[{'id':'p','workspace':'科研','name':'Synthetic'},{'id':'q','workspace':'课程','name':'Course'}],'notes':[{'id':'n','title':'Existing note','kind':'笔记','workspace':'科研','projectId':'p','content':'# Preserve\r\n\r\n[Other](other.md)','aiDraft':{'content':'Pending'},'sourceNoteIds':['s'],'updatedAt':1},{'id':'course','title':'Course','workspace':'课程','projectId':'q','content':'Private course'}],'tasks':[],'imports':[],'conversations':[],'trash':[],'agentRuns':[]})
 def test_adopt_keeps_identity_body_history_and_sources(self):
  original=copy.deepcopy(self.store.load()['notes'][0]);preview=self.m.preview()['entries'];self.assertEqual(len(preview),1);self.assertFalse(self.store.wiki.root.exists());result=self.m.adopt({'entries':preview});n=result['snapshot']['notes'][0]
  for key in ('id','title','kind','content','aiDraft','sourceNoteIds','updatedAt'):self.assertEqual(n[key],original[key])
  path=result['snapshot']['_wikiFiles']['n']['path'];self.assertEqual(self.store.wiki.decode(self.store.wiki.read(path),'n')[1],original['content']);self.assertEqual(self.m.preview()['entries'],[])
 def test_stale_and_cross_workspace_rejected_without_partial_adoption(self):
  row=self.m.preview()['entries'][0];s=self.store.load();s['notes'][0]['content']='User changed';self.store.save(s);self.assertRaises(WikiVaultError,self.m.adopt,{'entries':[row]});self.assertFalse(self.store.wiki.root.exists())
  row=self.m.preview()['entries'][0];self.assertRaises(WikiVaultError,self.m.adopt,{'entries':[row,{'id':'course','version':'fake'}]});self.assertFalse(self.store.load()['notes'][0].get('wikiFileBacked'))
 def test_import_body_and_batch_idempotency_and_wrong_project(self):
  payload={'requestId':'same-batch','projectId':'p','category':'method','files':[{'name':'one.md','content':'# One\r\n[Two](two.md)'},{'name':'two.md','content':'# Two'}]};first=self.m.import_markdown(payload);second=self.m.import_markdown(payload);self.assertEqual(first['ids'],second['ids']);self.assertEqual(len(second['snapshot']['notes']),4)
  n=next(n for n in second['snapshot']['notes'] if n['id']==first['ids'][0]);self.assertEqual(n['content'],payload['files'][0]['content']);self.assertEqual(n['wikiImportBatch'],'same-batch');path=second['snapshot']['_wikiFiles'][n['id']]['path'];self.assertTrue(path.endswith('/one.md'));self.assertTrue(self.store.wiki.path(path).with_name('two.md').exists())
  self.assertRaises(WikiVaultError,self.m.import_markdown,{**payload,'projectId':'q'});self.assertRaises(WikiVaultError,self.m.import_markdown,{**payload,'category':'output'})
 def test_duplicate_names_and_non_markdown_rejected(self):
  for files in ([{'name':'a.md','content':'a'},{'name':'a.md','content':'b'}],[{'name':'secret.py','content':'x'}],[{'name':'../bad.md','content':'x'}]):self.assertRaises(WikiVaultError,self.m.import_markdown,{'requestId':'r','files':files})
 def test_nested_directory_retains_relative_links_and_rejects_escape(self):
  files=[{'name':'index.md','relativePath':'研究/index.md','content':'[Paper](papers/index.md)'},{'name':'index.md','relativePath':'研究/papers/index.md','content':'[Home](../index.md)'}]
  payload={'requestId':'nested','projectId':'p','files':files};result=self.m.import_markdown(payload);a,b=result['ids'];mapping=result['snapshot']['_wikiFiles']
  self.assertTrue(mapping[a]['path'].endswith('/研究/index.md'));self.assertTrue(mapping[b]['path'].endswith('/研究/papers/index.md'));self.assertEqual(mapping[a]['links']['papers/index.md'],b);self.assertEqual(mapping[b]['links']['../index.md'],a)
  self.assertEqual(self.m.import_markdown(payload)['ids'],result['ids'])
  for path in ('../index.md','/index.md','研究/../index.md','研究/.hidden/index.md','研究\\index.md'):
   self.assertRaises(WikiVaultError,self.m.import_markdown,{'requestId':'invalid','files':[{**files[0],'relativePath':path}]})
 def test_transaction_failure_removes_new_files_and_leaves_database(self):
  original=self.store.load();row=self.m.preview()['entries'][0];mirror=self.store._mirror
  def fail(snapshot):mirror(snapshot);raise RuntimeError('Synthetic failure')
  with patch.object(self.store,'_mirror',side_effect=fail):self.assertRaises(RuntimeError,self.m.adopt,{'entries':[row]})
  self.assertEqual(self.store.load()['notes'],original['notes']);self.assertFalse(list(self.store.wiki.root.rglob('*.md')))
 def test_directory_sources_links_export_and_retry(self):
  payload={'requestId':'sources','projectId':'p','files':[{'name':'index.md','relativePath':'Paper/index.md','content':'[PDF](paper.pdf)\n![Figure](figures/a.png)\n`[example](paper.pdf)`'}],'assets':[{'name':'paper.pdf','relativePath':'Paper/paper.pdf','base64':base64.b64encode(b'%PDF-synthetic').decode()},{'name':'a.png','relativePath':'Paper/figures/a.png','base64':base64.b64encode(b'\x89PNG\r\n\x1a\nsynthetic').decode()}]}
  result=self.m.import_markdown(payload);n=next(n for n in result['snapshot']['notes'] if n['id'] in result['ids']);self.assertEqual(len(n['sourceAttachmentIds']),2);self.assertEqual(len(n['wikiSourceLinks']),2)
  for source in result['snapshot']['imports']:self.assertEqual(source['analysis']['status'],'pending');self.assertEqual(source['status'],'original-only');self.assertTrue(self.store.file_path(source['id']).exists())
  self.assertEqual(self.m.import_markdown(payload)['ids'],result['ids']);self.assertRaises(WikiVaultError,self.m.import_markdown,{**payload,'assets':[]})
  from wiki_bundle import WikiBundle
  b=WikiBundle(self.store)
  with zipfile.ZipFile(io.BytesIO(b.build({**b.preview(result['ids']),'includeSources':True}))) as z:
   self.assertIn('outputs/import-sources/Paper/paper.pdf',z.namelist());self.assertIn('outputs/import-sources/Paper/figures/a.png',z.namelist());self.assertIn('![Figure](figures/a.png)',z.read(result['snapshot']['_wikiFiles'][n['id']]['path']).decode())
 def test_directory_source_failure_rolls_back_originals_and_invalid_type(self):
  payload={'requestId':'fail-sources','files':[{'name':'index.md','content':'[PDF](paper.pdf)'}],'assets':[{'name':'paper.pdf','relativePath':'paper.pdf','base64':base64.b64encode(b'%PDF-synthetic').decode()}]}
  original=self.store.load()
  with patch.object(self.store,'_mirror',side_effect=RuntimeError('Synthetic commit failure')):self.assertRaises(RuntimeError,self.m.import_markdown,payload)
  self.assertEqual(self.store.load()['notes'],original['notes']);self.assertEqual(list((self.store.directory/'files').iterdir()),[])
  payload['assets'][0]['base64']=base64.b64encode(b'<script>wrong</script>').decode();self.assertRaises(WikiVaultError,self.m.import_markdown,payload)
 def test_paper_guide_requires_opt_in_and_preserves_full_body(self):
  s=self.store.load();s['notes'][0].update(paperId='paper',kind='论文分析');self.store.save(s);self.store.enable_wiki();self.assertNotIn('n',self.store.load()['_wikiFiles']);row=self.m.preview()['entries'][0];self.assertEqual(row['category'],'paper');result=self.m.adopt({'entries':[row]});self.assertIn('sources/papers',result['snapshot']['_wikiFiles']['n']['path']);self.assertIn('Preserve',result['snapshot']['notes'][0]['content'])
if __name__=='__main__':unittest.main()
