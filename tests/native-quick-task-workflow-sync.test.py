"""Category membership traverses the real local sync capture/apply pipeline."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
from sync_store import COLLECTIONS, SyncStore, record

def workspace(**values):
    return {**{kind: [] for kind in COLLECTIONS}, 'ui': {}, 'folders': {'projects': [], 'conversations': []}, '_revision': 1, **values}

def task(**values):
    return {'id': 'synthetic-task', 'title': 'Synthetic coursework', 'workspace': '课程', 'priority': 'high', 'status': 'todo', **values}

class WorkflowSyncTests(unittest.TestCase):
    def test_capture_push_pull_restart_and_null_preserve_membership_without_local_labels_or_source(self):
        with tempfile.TemporaryDirectory(prefix='aibro-workflow-sync-') as directory:
            a, b = SyncStore(Path(directory) / 'a'), SyncStore(Path(directory) / 'b')
            a.capture(workspace(tasks=[task(sourceTaskInbox={'id':'LOCAL_ONLY_SOURCE','category':'P1','version':1})], ui={'taskWorkflowNames':{'P1':'LOCAL_ONLY_LABEL'}}))
            b.capture(workspace(ui={'taskWorkflowNames':{'P1':'Own device label'}}))
            operations = a.pending()
            wire = next(row for row in operations if row['entityType'] == 'tasks')
            self.assertEqual(wire['data']['workflowCategory'], 'P1')
            self.assertNotIn('LOCAL_ONLY', str(operations))
            a.ack([{key: row[key] for key in ('opId','entityType','entityId')} | {'version':1} for row in operations])
            b.apply_changes([{'entityType':'tasks','entityId':'synthetic-task','data':wire['data'],'version':1,'seq':1,'deleted':False}],1)
            saved = SyncStore(Path(directory) / 'b').snapshot()
            self.assertEqual(saved['tasks'][0]['workflowCategory'],'P1')
            self.assertEqual(saved['tasks'][0]['priority'],'high')
            self.assertEqual(saved['ui']['taskWorkflowNames']['P1'],'Own device label')
            self.assertNotIn('sourceTaskInbox',saved['tasks'][0])
            cleared = dict(wire['data'], workflowCategory=None)
            a.apply_changes([{'entityType':'tasks','entityId':'synthetic-task','data':cleared,'version':2,'seq':2,'deleted':False}],2)
            local = a.snapshot()['tasks'][0]
            self.assertIsNone(local['workflowCategory'])
            self.assertEqual(local['sourceTaskInbox']['category'],'P1')
            self.assertIsNone(record('tasks',local)['workflowCategory'])

    def test_invalid_explicit_category_rejected_including_nested_trash(self):
        for bad in ('P4','',3,False,{},[],{'script':'do not run'}):
            with self.assertRaisesRegex(ValueError,'分类'):
                record('tasks',task(workflowCategory=bad))
            with self.assertRaisesRegex(ValueError,'分类'):
                record('trash',{'id':'trash','data':{'tasks':[task(workflowCategory=bad)]}})
        self.assertNotIn('workflowCategory', record('tasks',task(sourceTaskInbox={'category':'invalid'})))
        self.assertIsNone(record('tasks',task(workflowCategory=None,sourceTaskInbox={'category':'P0'}))['workflowCategory'])

if __name__ == '__main__': unittest.main()
