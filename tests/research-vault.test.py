"""Durable research exports: real structures, stable identity and source safety."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import unittest
import urllib.request
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
IMPORT_HOME = tempfile.TemporaryDirectory(prefix='workstation-vault-import-')
prior_data_dir = os.environ.get('AI_WORKSTATION_DATA_DIR')
os.environ['AI_WORKSTATION_DATA_DIR'] = IMPORT_HOME.name
try:
    spec = importlib.util.spec_from_file_location('vault_server', ROOT / 'server.py')
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
finally:
    if prior_data_dir is None:
        os.environ.pop('AI_WORKSTATION_DATA_DIR', None)
    else:
        os.environ['AI_WORKSTATION_DATA_DIR'] = prior_data_dir


class ResearchVaultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workstation-vault-test-')
        self.addCleanup(self.temp.cleanup)
        self.store = server.WorkspaceStore(Path(self.temp.name) / 'workspace')
        self.paper = {
            'id': 'paper-stable', 'title': 'Control: a study', 'year': 2025,
            'workspace': '科研', 'projectId': 'project-control',
            'authors': ['A. Researcher'], 'tags': ['control'],
            'sourceAttachmentIds': ['attachment-a'], 'updatedAt': 100,
            'structured': {
                'tldr': {'text': 'Original model summary', 'citations': [
                    {'attachmentId': 'attachment-a', 'page': 2, 'quote': 'A source claim.'}
                ]},
                'abstract': {'text': 'Abstract content'},
                'motivation': 'Motivation content',
                'methods': {'text': 'Method content', 'verified': False, 'citations': [
                    {'attachmentId': 'attachment-a', 'page': 4, 'quote': 'A method claim.\nSecond line.'}
                ]},
                'derivations': {'text': r'$$x_{t+1} = Ax_t + Bu_t$$'},
                'experiments': ['Experiment one', 'Experiment two'],
                'ablations': 'Ablation content',
                'limitations': 'Limitation content',
                'implications': 'Implication content',
                'openQuestions': 'Question content',
            },
            'userEdits': {'tldr': 'Human corrected summary'},
            'confidence': {'overall': 0.8}, 'reviewed': True,
        }
        self.pdf = b'%PDF-1.7\nPreserved original research source\n%%EOF'
        self.store.save_file('attachment-a', self.pdf, 'control.pdf', 'application/pdf')

    def state(self, paper=None):
        return dict(projects=[], tasks=[], notes=[], imports=[], conversations=[],
                    trash=[], agentRuns=[], papers=[paper or self.paper])

    def test_complete_analysis_citations_manual_edits_and_json(self):
        self.store.materialize_papers(self.state())
        folder = self.store.paper_directory(self.paper)
        note = (folder / 'note.md').read_text()
        for text in ('Human corrected summary', 'Abstract content', 'Motivation content',
                     'Method content', r'$$x_{t+1} = Ax_t + Bu_t$$', 'Experiment one',
                     'Experiment two', 'Ablation content', 'Limitation content',
                     'Implication content', 'Question content', 'attachment-a',
                     '第 2 页', '第 4 页', '> A method claim.\n> Second line.',
                     '核验状态：未核验', '本节含人工修订', '## 消融实验'):
            self.assertIn(text, note)
        self.assertNotIn('Original model summary', note)
        self.assertNotIn('尚未记录', note)
        self.assertIn('confidence: {"overall": 0.8}', note)
        exported = json.loads((folder / 'paper.json').read_text())
        self.assertEqual(exported['structured'], self.paper['structured'])
        self.assertEqual(exported['userEdits'], self.paper['userEdits'])
        self.assertEqual(exported['authors'], self.paper['authors'])
        # A deliberate blank human edit must not resurrect generated analysis.
        self.paper['userEdits']['methods'] = ''
        self.store.materialize_papers(self.state())
        self.assertNotIn('Method content', (folder / 'note.md').read_text())

    def test_title_year_rename_and_same_title_distinct_identity(self):
        self.store.materialize_papers(self.state())
        original = self.store.paper_directory(self.paper)
        self.paper.update(title='A completely new title', year=2026, updatedAt=200)
        self.store.materialize_papers(self.state())
        self.assertEqual(self.store.paper_directory(self.paper), original)
        self.assertEqual(len(list(self.store._paper_vault().glob('*/*/paper.json'))), 1)
        other = {**self.paper, 'id': 'paper-distinct'}
        self.store.materialize_papers({'papers': [self.paper, other]})
        self.assertNotEqual(self.store.paper_directory(other), original)
        self.assertEqual(json.loads((original / 'paper.json').read_text())['title'], self.paper['title'])

    def test_manual_canonical_markdown_and_consolidated_sources_are_the_durable_export(self):
        self.paper['noteId'] = 'master-note'
        body = '# My own title\n\nManually corrected complete analysis.\n\n## Additional evidence\n\nMerged second source.\n'
        state = self.state()
        state['notes'] = [{'id': 'master-note', 'paperId': self.paper['id'],
            'projectId': self.paper['projectId'], 'workspace': '科研',
            'title': 'My own title', 'content': body, 'userEdited': True,
            'userEditedAt': 200, 'updatedAt': 300, 'sourceAttachmentIds': ['attachment-b', 'attachment-a'],
            'aiDraft': {'content': 'A pending AI suggestion'}, 'mergedNoteIds': ['fragment']}]
        added = b'%PDF-1.7\nConsolidated second source\n%%EOF'
        self.store.save_file('attachment-b', added, 'additional.pdf', 'application/pdf')
        before = copy.deepcopy(state)
        self.store.materialize_papers(state)
        folder = self.store.paper_directory(self.paper)
        rendered = (folder / 'note.md').read_text()
        self.assertEqual(rendered.split('\n---\n\n', 1)[1], body)
        self.assertNotIn('Human corrected summary', rendered)
        self.assertNotIn('A pending AI suggestion', rendered)
        self.assertIn('attachment-b', rendered)
        self.assertIn('noteTitle: "My own title"', rendered)
        self.assertEqual((folder / 'sources' / 'attachment-b.pdf').read_bytes(), added)
        exported = json.loads((folder / 'paper.json').read_text())
        self.assertEqual(exported['structured'], self.paper['structured'])
        self.assertEqual(exported['userEdits'], self.paper['userEdits'])
        self.assertEqual(exported['sourceAttachmentIds'], ['attachment-a', 'attachment-b'])
        self.assertEqual(state, before, 'export does not mutate the canonical workspace')
        # An intentionally empty full-text edit does not restore prior AI text.
        state['notes'][0]['content'] = ''
        self.store.materialize_papers(state)
        self.assertEqual((folder / 'note.md').read_text().split('\n---\n\n', 1)[1], '')

    def test_only_the_active_unambiguous_same_paper_main_note_can_override_export(self):
        self.paper['noteId'] = 'master'
        main = {'id': 'master', 'paperId': self.paper['id'], 'projectId': self.paper['projectId'],
                'workspace': '科研', 'userEdited': True, 'content': 'Unrelated or unavailable text'}
        for patch in ({'archived': True}, {'deletedAt': 1}, {'status': 'deleted'},
                      {'paperId': 'other-paper'}, {'projectId': 'other-project'},
                      {'workspace': '课程'}, {'userEdited': False}):
            with self.subTest(patch=patch):
                state = self.state(); state['notes'] = [{**main, **patch}]
                self.store.materialize_papers(state)
                text = (self.store.paper_directory(self.paper) / 'note.md').read_text()
                self.assertNotIn(main['content'], text)
                self.assertIn('Human corrected summary', text)
        state = self.state(); state['notes'] = [main, {**main}]
        self.store.materialize_papers(state)
        self.assertNotIn(main['content'], (self.store.paper_directory(self.paper) / 'note.md').read_text())

    def test_extended_typed_sections_and_confidence_match_browser_exports_and_persist_in_one_note(self):
        fields = ('training', 'relatedWork', 'criticalAnalysis', 'counterArguments', 'dataGaps', 'reproduction')
        fixtures = [{**self.paper, 'paperType': kind, 'reviewed': False,
                     'confidence': {'overall': ' MEDIUM ', 'reason': ' Limited independent validation ',
                                    'methods': {'level': 'low', 'reason': 'Code unavailable'}, 'experiments': 0.4},
                     'structured': {**self.paper['structured'], **{key: f'EVIDENCE_{key}' for key in fields}}}
                    for kind in ('method', 'survey', 'benchmark', 'system', 'theory', 'other')]
        frontend = json.loads(subprocess.check_output(['node', '-e',
            "const R=require('./research-library');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(input).map(p=>({labels:R.sectionLabels(p.paperType),confidence:R.normalizeConfidence(p.confidence),markdown:R.paperMarkdown(p)})))));"],
            input=json.dumps(fixtures), text=True, cwd=ROOT))
        for paper, browser in zip(fixtures, frontend):
            with self.subTest(paper_type=paper['paperType']):
                self.assertEqual(browser['labels'], self.store._research_section_labels(paper['paperType']))
                self.assertEqual(browser['confidence'], self.store._research_confidence(paper['confidence']))
                self.store.materialize_papers(self.state(paper))
                directory = self.store.paper_directory(paper)
                markdown = (directory / 'note.md').read_text()
                exported = json.loads((directory / 'paper.json').read_text())
                for key in fields:
                    self.assertIn(f'EVIDENCE_{key}', markdown)
                    self.assertIn(f'EVIDENCE_{key}', browser['markdown'])
                    self.assertIn('## ' + browser['labels'][key] + '\n', markdown)
                self.assertEqual(exported['structured'], paper['structured'])
                self.assertEqual(exported['confidence'], browser['confidence'])
                self.assertEqual(exported['paperType'], paper['paperType'])
                self.assertFalse(exported['reviewed'])
        self.assertEqual(len(list(self.store._paper_vault().rglob('note.md'))), 1)
        state = self.state(fixtures[0])
        self.store.save(state)
        self.assertEqual(self.store.load()['papers'][0]['structured'], fixtures[0]['structured'])
        self.assertEqual(self.store.load()['papers'][0]['paperType'], 'method')

    def test_empty_optional_sections_are_not_exported_and_legacy_section_aliases_remain_readable(self):
        paper = {**self.paper, 'structured': {'method': 'Legacy method', 'results': 'Legacy results',
                 'training': '', 'criticalAnalysis': {'text': ''}, 'dataGaps': [], 'relatedWork': None},
                 'userEdits': {'method': 'Human alias correction'}, 'confidence': ' HIGH '}
        self.store.materialize_papers(self.state(paper))
        markdown = (self.store.paper_directory(paper) / 'note.md').read_text()
        self.assertIn('Human alias correction', markdown)
        self.assertIn('Legacy results', markdown)
        self.assertNotIn('Legacy method', markdown)
        for key in ('training', 'relatedWork', 'criticalAnalysis', 'counterArguments', 'dataGaps', 'reproduction'):
            self.assertNotIn('## ' + self.store._research_section_labels('other')[key] + '\n', markdown)
        self.assertIn('confidence: {"overall": "high", "reason": ""}', markdown)

    def test_legacy_folder_user_files_figures_and_sources_survive_rename(self):
        legacy = self.store._paper_vault() / '2025' / 'Control-a-study'
        legacy.mkdir(parents=True)
        (legacy / 'paper.json').write_text(json.dumps(self.paper))
        (legacy / 'source.pdf').write_bytes(self.pdf)
        (legacy / 'my-reading-notes.md').write_text('Do not lose handwritten work')
        (legacy / 'figures').mkdir()
        (legacy / 'figures' / 'figure.png').write_bytes(b'preserved figure')
        self.paper.update(title='Renamed paper', year=2026, updatedAt=300)
        self.store.materialize_papers(self.state())
        self.assertEqual(self.store.paper_directory(self.paper), legacy)
        self.assertFalse((self.store._paper_vault() / '2026').exists())
        self.assertEqual((legacy / 'my-reading-notes.md').read_text(), 'Do not lose handwritten work')
        self.assertEqual((legacy / 'figures' / 'figure.png').read_bytes(), b'preserved figure')
        self.assertEqual((legacy / 'source.pdf').read_bytes(), self.pdf)

    def test_incremental_sources_do_not_overwrite_preserved_originals(self):
        self.store.materialize_papers(self.state())
        folder = self.store.paper_directory(self.paper)
        self.store.save_file('attachment-a', b'changed external file', 'control.pdf', 'application/pdf')
        next_pdf = b'%PDF-1.7\nAnother original revision\n%%EOF'
        self.store.save_file('attachment-b', next_pdf, 'revision.pdf', 'application/pdf')
        self.paper['sourceAttachmentIds'].append('attachment-b')
        self.store.materialize_papers(self.state())
        self.assertEqual((folder / 'source.pdf').read_bytes(), self.pdf)
        self.assertEqual((folder / 'sources' / 'attachment-a.pdf').read_bytes(), self.pdf)
        self.assertEqual((folder / 'sources' / 'attachment-b.pdf').read_bytes(), next_pdf)

    def test_invalid_ids_and_symlinks_cannot_write_outside_owned_folder(self):
        for paper_id in ('../escape', '/absolute', 'nested/name', r'back\slash', '', 'a' * 161, None):
            with self.subTest(paper_id=paper_id), self.assertRaises(ValueError):
                self.store.materialize_papers({'papers': [{**self.paper, 'id': paper_id}]})
        self.assertFalse(self.store._paper_vault().exists())
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (outside / 'note.md').write_text('untouched')
        year = self.store._paper_vault() / '2025'
        year.mkdir(parents=True)
        (year / self.paper['id']).symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.store.materialize_papers(self.state())
        self.assertEqual((outside / 'note.md').read_text(), 'untouched')
        self.assertFalse((outside / 'paper.json').exists())

    def test_renamed_paper_http_figures_bundle_and_source_recovery(self):
        old_store = server.STORE
        server.STORE = self.store
        self.addCleanup(setattr, server, 'STORE', old_store)
        class QuietHandler(server.Handler):
            def log_message(self, *args): pass
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        def close_server():
            httpd.shutdown()
            httpd.server_close()
            worker.join(2)
        self.addCleanup(close_server)
        state = self.state()
        self.store.save(state)
        original = self.store.paper_directory(self.paper)
        figure = b'example image payload'
        (original / 'figures' / 'figure.png').write_bytes(figure)
        self.paper.update(title='Edited display title', year=2026, updatedAt=500)
        self.paper['noteId'] = 'bundle-master'
        state['notes'] = [{'id': 'bundle-master', 'paperId': self.paper['id'],
            'workspace': '科研', 'projectId': self.paper['projectId'], 'userEdited': True,
            'title': 'Human bundle title', 'content': 'The complete human Markdown survives the HTTP bundle.'}]
        self.store.save(state)
        endpoint = f'http://127.0.0.1:{httpd.server_port}/__papers/{self.paper["id"]}'
        with urllib.request.urlopen(endpoint + '/figures/figure.png') as response:
            self.assertEqual(response.read(), figure)
        with urllib.request.urlopen(endpoint + '/bundle') as response:
            bundle = response.read()
        with ZipFile(io.BytesIO(bundle)) as archive:
            self.assertEqual(archive.namelist().count('paper.json'), 1)
            self.assertEqual(archive.namelist().count('source.pdf'), 1)
            self.assertEqual(archive.read('source.pdf'), self.pdf)
            self.assertEqual(archive.read('figures/figure.png'), figure)
            self.assertEqual(json.loads(archive.read('paper.json'))['structured'], self.paper['structured'])
            self.assertIn('Edited display title', archive.read('note.md').decode())
            self.assertIn('The complete human Markdown survives the HTTP bundle.', archive.read('note.md').decode())
            self.assertNotIn('Human corrected summary', archive.read('note.md').decode())


if __name__ == '__main__':
    unittest.main()
