import copy,io,json,os,tempfile,unittest,zipfile
host=tempfile.TemporaryDirectory();os.environ.setdefault('AI_WORKSTATION_DATA_DIR',host.name)
from server import WorkspaceStore
from wiki_migration import WikiMigration
from wiki_bundle import WikiBundle
class BundleTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.store=WorkspaceStore(self.tmp.name);self.bundle=WikiBundle(self.store)
  self.store.save({'projects':[{'id':'p','workspace':'科研'}],'notes':[],'tasks':[],'imports':[],'conversations':[],'trash':[],'agentRuns':[]})
  result=WikiMigration(self.store).import_markdown({'requestId':'batch','projectId':'p','files':[{'name':'a.md','content':'[B](b.md)\n`[B](b.md)`'},{'name':'b.md','content':'B'}]});self.ids=result['ids'];s=result['snapshot'];s['notes'][0]['sourceAttachmentIds']=['pdf','missing'];s['imports']=[{'id':'pdf','name':'Paper.pdf','mimeType':'application/pdf','projectId':'p'},{'id':'missing','name':'Missing.png','projectId':'p'}];self.store.save_file('pdf',b'%PDF-synthetic','Paper.pdf','application/pdf');self.store.save(s)
 def test_bundle_paths_sources_missing_and_unchanged_store(self):
  s=self.store.load();p=self.store.wiki.path(s['_wikiFiles'][self.ids[1]]['path']);target=self.store.wiki.root/'concepts/b.md';target.parent.mkdir(exist_ok=True);p.rename(target)
  preview=self.bundle.preview(self.ids);before=copy.deepcopy(self.store.load());raw=self.bundle.build({**preview,'includeSources':True})
  with zipfile.ZipFile(io.BytesIO(raw)) as z:
   manifest=json.loads(z.read('AIBRO-EXPORT.json'));self.assertEqual(len(manifest['notes']),2);self.assertEqual(len(manifest['sources']),1);self.assertEqual(manifest['missing'][0]['sourceId'],'missing');self.assertEqual(z.read(manifest['sources'][0]['path']),b'%PDF-synthetic')
   content=z.read(before['_wikiFiles'][self.ids[0]]['path']).decode();self.assertIn('../../concepts/b.md',content);self.assertIn('`[B](b.md)`',content);self.assertIn('Source files',content)
  self.assertEqual(self.store.load(),before)
 def test_selection_source_optout_and_stale_review(self):
  preview=self.bundle.preview([self.ids[0]])
  with zipfile.ZipFile(io.BytesIO(self.bundle.build({**preview,'includeSources':False}))) as z:
   m=json.loads(z.read('AIBRO-EXPORT.json'));self.assertEqual(m['sources'],[]);self.assertEqual(m['linksOutsideSelection'][0]['targetId'],self.ids[1]);self.assertNotIn('concepts/b.md',z.namelist())
  s=self.store.load();s['notes'][0]['content']='changed';self.store.save(s);self.assertRaises(ValueError,self.bundle.build,{**preview,'includeSources':True})
 def test_deleted_source_not_exported_and_symlink_rejected(self):
  s=self.store.load();s['imports'][0]['archived']=True;self.store.save(s)
  with zipfile.ZipFile(io.BytesIO(self.bundle.build({**self.bundle.preview(self.ids),'includeSources':True}))) as z:self.assertEqual(json.loads(z.read('AIBRO-EXPORT.json'))['sources'],[])
  s=self.store.load();s['imports'][0]['archived']=False;self.store.save(s);path=self.store.file_path('pdf');path.unlink();path.symlink_to('/etc/hosts');self.assertRaises(OSError,self.bundle.build,{**self.bundle.preview(self.ids),'includeSources':True})
if __name__=='__main__':unittest.main()
