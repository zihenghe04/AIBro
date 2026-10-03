"""Shared library directory contracts. Disposable SQLite fixtures, no server calls."""
import sys,json,tempfile,unittest,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from sync_store import SyncStore,COLLECTIONS,project,record,wire_id
from sync_merge import merge_local_snapshot,MergeConflict

def folder(identifier='f',path='Reading',**extra):
    return dict(id=identifier,name=path.split('/')[-1],folderPath=path,workspace='科研',projectId='p',createdAt=1,updatedAt=1,**extra)
def state(folders=None):
    s={key:[] for key in COLLECTIONS};s.update(projects=[dict(id='p',name='Project',workspace='科研')],folders={'projects':[dict(id='sidebar',name='Sidebar',workspace='旧字段')],'conversations':[],'library':folders or []},agentRuns=[]);return s
class LibraryFolderSync(unittest.TestCase):
    def test_sqlite_roundtrip_and_second_device_rebuild_keep_directory_identity_and_scope(self):
        with tempfile.TemporaryDirectory() as root:
            a,b=SyncStore(Path(root)/'a'),SyncStore(Path(root)/'b');a.capture(state([folder()]));b.capture(state())
            public=[op for op in a.pending() if op['entityType']=='folders' and not op['deleted']]
            library=next(op for op in public if op['data']['kind']=='library')
            self.assertEqual(library['data']['folderPath'],'Reading');self.assertEqual(library['data']['projectId'],'p')
            # Existing sidebar folder projection remains byte-for-byte compatible.
            legacy=next(op for op in public if op['data']['kind']=='projects');self.assertNotIn('workspace',legacy['data'])
            b.apply_changes([dict(entityType='folders',entityId=library['entityId'],version=1,deleted=False,data=library['data'])],1)
            self.assertEqual(b.snapshot()['folders']['library'],[folder()]);self.assertEqual(b.snapshot()['imports'],[])
            reopened=SyncStore(Path(root)/'a');self.assertEqual(reopened.snapshot()['folders']['library'],[folder()])
            b.apply_changes([dict(entityType='folders',entityId=library['entityId'],version=2,deleted=True,data=None)],2)
            self.assertEqual(b.snapshot()['folders']['library'],[])
    def test_projection_filters_hidden_folder_or_owner_and_retains_local_private_metadata_on_other_changes(self):
        for private_on in ['folder','project']:
            s=state([folder()]);(s['folders']['library'][0] if private_on=='folder' else s['projects'][0])['private']=True
            self.assertFalse(any(value.get('kind')=='library' for value in project(s).values()))
            with tempfile.TemporaryDirectory() as root:
                store=SyncStore(root);store.capture(s)
                store.apply_changes([dict(entityType='notes',entityId='public',version=1,deleted=False,data=dict(id='public',title='note',content='public'))],1)
                self.assertEqual(store.snapshot()['folders']['library'],s['folders']['library'])
    def test_project_whitelist_rejects_invalid_paths_and_does_not_send_local_or_unknown_folder_fields(self):
        row=folder();row.update(kind='library',localPath='/private/example',token='secret',extra='ignore')
        value=record('folders',row);self.assertNotIn('localPath',value);self.assertNotIn('token',value);self.assertNotIn('extra',value)
        for path in ['/absolute','../up','A//B','A/ B','A\\B','A\nB','a/b/c/d/e/f/g']:
            with self.assertRaises(ValueError,msg=path): record('folders',{**row,'folderPath':path})
    def test_retired_folder_and_protected_members_never_publish_directory_metadata(self):
        for status in ['archived','deleted']:
            s=state([folder(status=status)])
            self.assertFalse(any(value.get('kind')=='library' for value in project(s).values()))
        for privacy in ['direct','conversation','retired-run','duplicate']:
            s=state([folder()]);s['notes']=[dict(id='n',folderPath='Reading/Child',workspace='科研',projectId='p')]
            note=s['notes'][0]
            if privacy=='direct': note['private']=True
            if privacy=='conversation':
                note['sourceConversationId']='c';s['conversations']=[dict(id='c',private=True)]
            if privacy=='retired-run':
                note['runId']='r';s['trash']=[dict(id='trash',data={'runs':[dict(id='r',private=True)]})]
            if privacy=='duplicate': s['notes'].append(dict(note,folderPath='Other'))
            # Direct helper avoids unrelated legacy duplicate-record rejection.
            from sync_store import public_library_folder
            self.assertFalse(public_library_folder(s,s['folders']['library'][0]),privacy)
            if privacy!='duplicate':
                self.assertFalse(any(value.get('kind')=='library' for value in project(s).values()),privacy)
    def test_two_sides_merge_separate_folders_and_old_collections_unchanged(self):
        base=state();left=copy.deepcopy(base);right=copy.deepcopy(base)
        left['folders']['library']=[folder('a','A')];right['folders']['library']=[folder('b','B')]
        result=merge_local_snapshot(base,left,right)
        self.assertEqual({x['id'] for x in result['folders']['library']},{'a','b'});self.assertEqual(result['folders']['projects'],base['folders']['projects'])
        right['folders']['library']=[folder('b','A')]
        with self.assertRaises(MergeConflict):merge_local_snapshot(base,left,right)
        with self.assertRaises(ValueError):project(state([folder('a','A'),folder('b','A')]))
    def test_same_folder_rename_conflicts_with_another_rename_but_independent_metadata_survives(self):
        base=state([folder()]);left=copy.deepcopy(base);right=copy.deepcopy(base)
        left['folders']['library'][0]['folderPath']='Left';right['folders']['library'][0]['folderPath']='Right'
        with self.assertRaises(MergeConflict):merge_local_snapshot(base,left,right)
        right=copy.deepcopy(base);right['folders']['library'][0]['updatedAt']=3
        result=merge_local_snapshot(base,left,right);self.assertEqual(result['folders']['library'][0]['folderPath'],'Left');self.assertEqual(result['folders']['library'][0]['updatedAt'],3)
if __name__=='__main__':unittest.main()
