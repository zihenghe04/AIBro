import copy
import json
import tempfile
import os
import unittest
from pathlib import Path
from unittest.mock import patch

_test_host = tempfile.TemporaryDirectory(prefix="wiki-vault-host-")
os.environ.setdefault("AI_WORKSTATION_DATA_DIR", _test_host.name)
from server import ConflictError, WorkspaceStore
from wiki_vault import WikiVaultError


class WikiVaultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = WorkspaceStore(self.temp.name)
        self.note = dict(id='note-a', title='Synthetic method', content='# Method\n\nEvidence.',
                         workspace='科研', kind='科研 Wiki/method', updatedAt=1)
        s = {k: [] for k in ('projects', 'tasks', 'notes', 'imports', 'conversations', 'trash', 'agentRuns')}
        s['notes'] = [self.note]
        self.store.save(s)
        self.store.enable_wiki()

    def file(self):
        info = self.store._load_cached()['_wikiFiles']['note-a']
        return self.store.wiki.path(info['path'])

    def test_body_restart_external_edit_and_version_history(self):
        path = self.file()
        self.assertIn('Evidence.', path.read_text())
        path.write_text(path.read_text().replace('Evidence.', 'New external evidence.'))
        state = WorkspaceStore(self.temp.name).load()
        self.assertIn('New external evidence.', state['notes'][0]['content'])
        self.assertEqual(state['notes'][0]['revisionHistory'][-1]['content'], self.note['content'])
        revision = state['_revision']
        self.assertEqual(self.store.load()['_revision'], revision)

    def test_drafts_do_not_replace_approved_file_and_adoption_does(self):
        original = self.file().read_bytes()
        s = self.store.load(); s['notes'][0]['aiDraft'] = {'content': '# Proposed'}
        self.store.save(s)
        self.assertEqual(self.file().read_bytes(), original)
        s = self.store.load(); s['notes'][0]['content'] = s['notes'][0].pop('aiDraft')['content']
        self.store.save(s)
        self.assertIn('# Proposed', self.file().read_text())

    def test_stale_writer_does_not_overwrite_external_edit(self):
        stale = self.store.load(); stale['notes'][0]['content'] = '# Concurrent UI edit'
        path = self.file(); path.write_text(path.read_text().replace('Evidence.', 'External wins preservation.'))
        with self.assertRaises(ConflictError): self.store.save(stale)
        self.assertIn('External wins preservation.', path.read_text())
        self.assertTrue(self.store.list_recoveries()['items'])

    def test_metadata_only_save_preserves_external_encoding(self):
        p = self.file(); raw = b'\xef\xbb\xbf' + p.read_bytes()
        p.write_bytes(raw); s = self.store.load(); s['notes'][0]['tags'] = ['edited metadata']
        self.store.save(s)
        self.assertEqual(p.read_bytes(), raw)

    def test_links_track_both_moved_pages_without_rewriting_bodies(self):
        snapshot=self.store.load();a=snapshot['notes'][0];b={**a,'id':'wiki-second','title':'Second','content':'# Second'};snapshot['notes'].append(b);self.store.save(snapshot)
        snapshot=self.store.load();a=snapshot['notes'][0];source=self.store.wiki.path(snapshot['_wikiFiles'][a['id']]['path']);target=self.store.wiki.path(snapshot['_wikiFiles'][b['id']]['path'])
        import posixpath
        href=posixpath.relpath(target,source.parent);a['content']='[Second]('+href+')';self.store.save(snapshot)
        snapshot=self.store.load();self.assertEqual(snapshot['_wikiFiles'][a['id']]['links'][href],b['id'])
        source_bytes=source.read_bytes();target_bytes=target.read_bytes();new_source=source.parent/'moved'/'source.md';new_source.parent.mkdir();source.rename(new_source);new_target=target.parent/'other.md';target.rename(new_target)
        moved=self.store.load();self.assertEqual(moved['_wikiFiles'][a['id']]['links'][href],b['id']);self.assertEqual(new_source.read_bytes(),source_bytes);self.assertEqual(new_target.read_bytes(),target_bytes)

    def test_external_move_keeps_identity_and_new_path(self):
        p=self.file(); moved=p.parent/'topic'/'renamed.md';moved.parent.mkdir();p.rename(moved)
        self.store.load()
        self.assertEqual(self.file(),moved)
        s=self.store.load();s['notes'][0]['content']='# Edited after move';self.store.save(s)
        self.assertIn('Edited after move',moved.read_text());self.assertFalse(p.exists())

    def test_sqlite_failure_rolls_back_all_files(self):
        old = self.file().read_bytes(); s = self.store.load()
        s['notes'][0]['content'] = '# Will fail'
        s['notes'].append({**self.note, 'id': 'note-b', 'title': 'Second'})
        with patch.object(self.store, '_mirror', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): self.store.save(s)
        self.assertEqual(self.file().read_bytes(), old)
        self.assertEqual(len(list(self.store.wiki.root.rglob('*.md'))), 1)
        self.assertFalse(self.store.wiki.journal.exists())

    def test_crash_before_commit_recovers_original(self):
        previous = self.store.load(); proposed = copy.deepcopy(previous)
        proposed['notes'][0]['content'] = '# Interrupted'
        self.store.wiki.publish(previous, proposed)
        self.assertIn('Interrupted', self.file().read_text())
        state = WorkspaceStore(self.temp.name).load()
        self.assertEqual(state['notes'][0]['content'], self.note['content'])
        self.assertNotIn('Interrupted', self.file().read_text())

    def test_committed_journal_cleanup_keeps_new_content(self):
        previous = self.store.load(); proposed = copy.deepcopy(previous)
        proposed['notes'][0]['content'] = '# Committed'
        self.store.wiki.publish(previous, proposed)
        self.store.sync.capture(proposed)
        state = WorkspaceStore(self.temp.name).load()
        self.assertEqual(state['notes'][0]['content'], '# Committed')
        self.assertFalse(self.store.wiki.journal.exists())

    def test_external_edit_after_crash_is_not_replaced(self):
        previous = self.store.load(); proposed = copy.deepcopy(previous)
        proposed['notes'][0]['content'] = '# Interrupted'
        self.store.wiki.publish(previous, proposed)
        self.file().write_text('External work after interruption')
        state = WorkspaceStore(self.temp.name).load()
        self.assertIn('_wikiError', state)
        self.assertTrue(self.store.wiki.journal.exists())
        self.assertEqual(self.file().read_text(), 'External work after interruption')

    def test_missing_invalid_and_symlink_do_not_resurrect(self):
        p = self.file(); old = p.read_bytes(); p.unlink()
        self.assertTrue(self.store.load().get('_wikiErrors')); self.assertFalse(p.exists())
        p.write_bytes(old.replace(b'aibro_id', b'wrong_id'))
        self.assertTrue(self.store.load().get('_wikiErrors'))
        p.unlink(); outside = Path(self.temp.name) / 'outside.md'; outside.write_text('secret')
        p.symlink_to(outside)
        self.assertTrue(self.store.load().get('_wikiErrors'))
        self.assertEqual(outside.read_text(), 'secret')

    def test_broken_file_does_not_block_unrelated_work_and_can_be_repaired(self):
        p=self.file();p.write_text('Invalid frontmatter with external work')
        s=self.store.load();self.assertTrue(s['notes'][0]['wikiFileError'])
        s['tasks'].append({'id':'task-a','title':'Unrelated task'})
        self.store.save(s)
        self.assertEqual(len(self.store.load()['tasks']),1)
        self.store.restore_wiki_file('note-a')
        self.assertFalse(self.store.load().get('_wikiErrors'))
        self.assertIn('Evidence.',p.read_text())
        backups=list((Path(self.temp.name)/'recovery').glob('wiki-*.md'))
        self.assertEqual(backups[0].read_text(),'Invalid frontmatter with external work')
        p.unlink();self.store.restore_wiki_file('note-a');self.assertTrue(p.exists())

    def test_client_cannot_redirect_files_or_disable_vault(self):
        s = self.store.load(); original = self.file()
        s['_wikiFiles']['note-a']['path'] = '../../outside.md'; s['_wikiEnabled'] = False
        s['notes'][0]['content'] = '# Edited'
        self.store.save(s)
        self.assertEqual(self.file(), original)
        self.assertTrue(self.store.load()['_wikiEnabled'])
        self.assertFalse((Path(self.temp.name) / 'outside.md').exists())

    def test_remote_note_updates_authoritative_file(self):
        s = self.store.load()
        pending = self.store.sync.pending()
        self.store.sync.ack([{'opId': x['opId'], 'version': 1} for x in pending])
        remote = {**s['notes'][0], 'content': '# Remote accepted update'}
        self.store.apply_cloud_changes([{'entityType': 'notes', 'entityId': 'note-a',
            'version': 2, 'deleted': False, 'data': remote}], 1)
        self.assertIn('# Remote accepted update', self.file().read_text())
        self.assertEqual(self.store.load()['notes'][0]['content'], remote['content'])

    def test_trash_preserves_file_and_external_edits_restore_with_note(self):
        s = self.store.load(); s['trash'] = [{'id':'trash-a', 'type':'note', 'data':{'notes':s.pop('notes')}}];s['notes']=[]
        self.store.save(s); p = self.file()
        p.write_text(p.read_text().replace('Evidence.', 'While in trash.'))
        s = self.store.load(); s['notes'] = s['trash'].pop()['data']['notes']
        self.store.save(s)
        self.assertIn('While in trash.', self.store.load()['notes'][0]['content'])

    def test_purge_removes_file_and_mapping_transactionally(self):
        s = self.store.load(); p = self.file()
        s['trash']=[{'id':'trash-a','type':'note','data':{'notes':s.pop('notes')}}];s['notes']=[]
        self.store.save(s); current=self.store.load()
        self.store.purge_trash('trash-a',current['_revision'])
        self.assertFalse(p.exists())
        self.assertNotIn('note-a',self.store.load()['_wikiFiles'])


if __name__ == '__main__': unittest.main()
