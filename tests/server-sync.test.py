"""Renderer saves racing a background sync, against the actual durable store."""
import copy
import tempfile
import unittest
from pathlib import Path
import server


def base_state():
    return dict(_revision=0, projects=[], tasks=[], imports=[], papers=[], conversations=[],
                attachments=[], trash=[], agentRuns=[], links=[], folders={'projects': [], 'conversations': []},
                notes=[{'id':'n','title':'笔记','content':'初稿','workspace':'科研'}])


class RendererSaveRaceTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory(prefix='aw-save-sync-race-')
        self.addCleanup(self.directory.cleanup)
        self.store=server.WorkspaceStore(Path(self.directory.name))
        self.store.save(base_state())
        self.ack()
        self.original=self.store.load()

    def ack(self):
        self.store.sync.ack([{**op,'version':1} for op in self.store.sync.pending()])

    def remote(self, item, deleted=False, identifier='n', version=2):
        self.store.apply_cloud_changes([{'entityType':'notes','entityId':identifier,
            'data':item,'deleted':deleted,'version':version}],version)

    def test_new_local_task_does_not_remove_remote_note_or_its_next_autosave(self):
        incoming={'id':'remote','title':'另一台设备的知识','content':'远程资料','workspace':'科研'}
        self.remote(incoming,identifier='remote',version=1)
        draft=copy.deepcopy(self.original)
        draft['tasks'].append({'id':'t','title':'本机任务','workspace':'日常'})
        draft['ui']={'theme':'dark'}
        result=self.store.save(draft)
        self.assertIn('mergedSnapshot',result)
        snapshot=result['mergedSnapshot']
        self.assertEqual({item['id'] for item in snapshot['notes']},{'n','remote'})
        self.assertEqual(snapshot['tasks'][0]['id'],'t')
        self.assertEqual(snapshot['ui']['theme'],'dark')
        self.store.save(snapshot)
        self.assertIn('remote',{item['id'] for item in self.store.load()['notes']})
        self.assertFalse(any(op['entityId']=='remote' and op['deleted'] for op in self.store.sync.pending()))

    def test_remote_delete_stays_deleted_during_unrelated_local_save(self):
        self.remote(None,deleted=True)
        draft=copy.deepcopy(self.original)
        draft['tasks'].append({'id':'t','title':'新任务','workspace':'日常'})
        result=self.store.save(draft)
        self.assertEqual(result['mergedSnapshot']['notes'],[])
        self.assertEqual(self.store.load()['tasks'][0]['id'],'t')
        self.assertFalse(any(op['entityId']=='n' for op in self.store.sync.pending()))

    def test_independent_note_fields_merge(self):
        remote=copy.deepcopy(self.original['notes'][0]);remote['content']='另一台设备补充正文'
        self.remote(remote)
        draft=copy.deepcopy(self.original);draft['notes'][0]['title']='本机新标题'
        self.store.save(draft)
        self.assertEqual(self.store.load()['notes'][0]['title'],'本机新标题')
        self.assertEqual(self.store.load()['notes'][0]['content'],'另一台设备补充正文')

    def test_same_field_conflict_preserves_recovery_and_canonical_snapshot(self):
        remote=copy.deepcopy(self.original['notes'][0]);remote['content']='云端修改'
        self.remote(remote)
        draft=copy.deepcopy(self.original);draft['notes'][0]['content']='本地修改'
        before=self.store.load();queue=self.store.sync.pending()
        with self.assertRaises(server.ConflictError) as caught:self.store.save(draft)
        self.assertEqual(self.store.load(),before)
        self.assertEqual(self.store.sync.pending(),queue)
        self.assertTrue(caught.exception.recovery['saved'])
        import json
        recovered=json.loads(self.store.recovery_path(caught.exception.recovery['id']).read_text())
        self.assertEqual(recovered['notes'][0]['content'],'本地修改')


if __name__=='__main__':unittest.main()
