"""Native capture identity survives local trash, cloud assembly and real restore."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
from sync_store import COLLECTIONS, SyncStore, record


def workspace(**values):
    return {**{kind: [] for kind in COLLECTIONS}, 'ui': {},
            'folders': {'projects': [], 'conversations': []}, 'agentRuns': [],
            '_revision': 1, **values}


def client(action, state, request=None, trash_id='quick-capture-trash'):
    """Use the production JS save and content lifecycle, rather than imitating them."""
    script = r"""
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const {webcrypto} = require('node:crypto');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = process.argv[1];
const lifecycle = require(path.join(root, 'app/content-lifecycle.js'));
if (input.action === 'remove') {
  const result = lifecycle.remove(input.state, [{type:'note', id:input.request.id}], {},
    {uid:()=>input.trashID, now:1000});
  process.stdout.write(JSON.stringify(result));
} else if (input.action === 'restore') {
  process.stdout.write(JSON.stringify(lifecycle.restore(input.state, input.trashID)));
} else {
  let saves = 0;
  const context = {state:input.state, storageHydrated:true, serverConflict:false,
    crypto:webcrypto, TextEncoder, CaptureNotes:require(path.join(root, 'app/capture-notes.js')),
    saveDocumentDurably:async()=>{saves++; return true;}, document:{body:{dataset:{view:'conversation'}}}};
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'native/Resources/quick-capture.js'),'utf8'),context);
  context.NativeQuickCapture.save(input.request).then(receipt=>{
    process.stdout.write(JSON.stringify({state:context.state,receipt,saves}));
  }).catch(error=>{console.error(error); process.exitCode=1;});
}
"""
    result = subprocess.run(['node', '-e', script, str(ROOT)],
                            input=json.dumps({'action': action, 'state': state, 'request': request,
                                              'trashID': trash_id}),
                            text=True, capture_output=True, timeout=15, check=True)
    return json.loads(result.stdout)


def acknowledge(store, version):
    operations = store.pending()
    store.ack([{key: op[key] for key in ('opId', 'entityType', 'entityId')} | {'version': version}
               for op in operations])
    return operations


def change(kind, data, version=1):
    return {'entityType': kind, 'entityId': data['id'], 'data': data,
            'version': version, 'seq': version, 'deleted': False}


class NativeQuickCaptureSyncTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aibro-quick-capture-sync-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.store = SyncStore(self.directory / 'device-a')
        self.request = {'id': 'quick_capture_019cdd43-1b23-7461-a234-567890abcdef',
                        'text': 'A published capture\nWith another line', 'tags': ['research']}

    def created(self):
        result = client('save', workspace(), self.request)
        self.assertEqual(result['receipt'], {'status': 'saved', 'id': self.request['id']})
        self.assertEqual(result['saves'], 1)
        return result['state']

    def test_lost_ack_then_trash_pull_and_real_restore_keeps_same_capture_retry(self):
        # The workspace committed, but the native client retained its request
        # because it did not receive the receipt. Its separate recovery file is
        # not an input to sync, and must remain private and byte-for-byte intact.
        created = self.created()
        original = copy.deepcopy(created['notes'][0])
        self.store.capture(created)
        recovery = self.store.directory / 'native-quick-capture-draft.json'
        recovery_bytes = json.dumps({'pending': self.request, 'privateDraft': 'UNPUBLISHED_PRIVATE_DRAFT'}).encode()
        recovery.write_bytes(recovery_bytes)
        published = acknowledge(self.store, 1)
        removed = client('remove', self.store.snapshot(), self.request)['state']
        self.assertEqual(removed['notes'], [])
        self.store.capture(removed)
        trashed = acknowledge(self.store, 2)
        wire = json.dumps(published + trashed)
        for local in ('sourceQuickCaptureId', 'quickCaptureFingerprint', 'nativeQuickCaptureReceipts',
                      'UNPUBLISHED_PRIVATE_DRAFT'):
            self.assertNotIn(local, wire)

        # Even an unrelated changed record causes every entity to be assembled
        # from its public projection; this used to strip the nested receipt.
        applied = self.store.apply_changes([change('projects', {'id': 'peer-project', 'name': 'From another device'})], 3)
        self.assertTrue(applied['changed'])
        restarted = SyncStore(self.store.directory)
        retained = restarted.snapshot()['trash'][0]['data']['notes'][0]
        self.assertEqual(retained['sourceQuickCaptureId'], original['sourceQuickCaptureId'])
        self.assertEqual(retained['quickCaptureFingerprint'], original['quickCaptureFingerprint'])
        self.assertEqual(retained['content'], original['content'])
        self.assertEqual(recovery.read_bytes(), recovery_bytes)

        restored = client('restore', restarted.snapshot())
        self.assertEqual(len(restored['restored']), 1)
        self.assertEqual(restored['state']['trash'], [])
        restarted.capture(restored['state'])
        retried = client('save', restarted.snapshot(), self.request)
        self.assertEqual(retried['receipt'], {'status': 'saved', 'id': self.request['id']})
        self.assertEqual(len(retried['state']['notes']), 1)
        self.assertEqual(retried['state']['notes'][0], original)
        self.assertEqual(retried['state']['ui']['nativeQuickCaptureReceipts'], created['ui']['nativeQuickCaptureReceipts'])
        self.assertEqual(recovery.read_bytes(), recovery_bytes)
        self.assertNotIn('quickCaptureFingerprint', json.dumps(restarted.pending()))

    def test_remote_trash_edit_keeps_only_own_receipt_without_overwriting_remote_content(self):
        created = self.created()
        original = copy.deepcopy(created['notes'][0])
        removed = client('remove', created, self.request)['state']
        removed['trash'][0]['data']['notes'][0]['privateRecoveryDraft'] = 'DO_NOT_COPY_OR_UPLOAD'
        self.store.capture(removed)
        acknowledge(self.store, 1)

        incoming = copy.deepcopy(removed['trash'][0])
        incoming_note = incoming['data']['notes'][0]
        incoming_note.update(content='Peer edited the published capture', title='Peer title', tags=['peer'],
                             sourceQuickCaptureId='forged-source', quickCaptureFingerprint='forged-fingerprint',
                             privateRecoveryDraft='REMOTE_PRIVATE_FIELD')
        incoming['data']['notes'].append({'id': 'peer-note', 'kind': '随记', 'content': 'Another record',
                                         'sourceQuickCaptureId': original['sourceQuickCaptureId'],
                                         'quickCaptureFingerprint': original['quickCaptureFingerprint']})
        self.store.apply_changes([change('trash', incoming, 2)], 2)
        saved = self.store.snapshot()['trash'][0]['data']['notes']
        self.assertEqual(saved[0]['content'], incoming_note['content'])
        self.assertEqual(saved[0]['title'], incoming_note['title'])
        self.assertEqual(saved[0]['tags'], ['peer'])
        self.assertEqual(saved[0]['sourceQuickCaptureId'], original['sourceQuickCaptureId'])
        self.assertEqual(saved[0]['quickCaptureFingerprint'], original['quickCaptureFingerprint'])
        self.assertNotIn('privateRecoveryDraft', saved[0], 'This fix must not copy unrelated nested local metadata')
        self.assertNotIn('sourceQuickCaptureId', saved[1], 'Remote fields may not forge a local receipt on another note')
        self.assertNotIn('quickCaptureFingerprint', saved[1])

        restored = client('restore', self.store.snapshot())['state']
        retried = client('save', restored, self.request)
        self.assertEqual(retried['receipt']['status'], 'saved')
        same_note = next(item for item in retried['state']['notes'] if item['id'] == self.request['id'])
        self.assertEqual(same_note['content'], incoming_note['content'], 'Retry must recognize original creation without reverting a later edit')
        peer = SyncStore(self.directory / 'device-b')
        peer.capture(workspace())
        peer.apply_changes([change('trash', incoming, 2)], 2)
        peer_notes = peer.snapshot()['trash'][0]['data']['notes']
        for note in peer_notes:
            self.assertNotIn('sourceQuickCaptureId', note)
            self.assertNotIn('quickCaptureFingerprint', note)
            self.assertNotIn('privateRecoveryDraft', note)
        projected = record('trash', self.store.snapshot()['trash'][0])
        self.assertNotIn('quickCaptureFingerprint', json.dumps(projected))
        self.assertNotIn('DO_NOT_COPY_OR_UPLOAD', json.dumps(projected))


if __name__ == '__main__': unittest.main()
