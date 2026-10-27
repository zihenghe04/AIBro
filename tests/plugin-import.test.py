import json, os, sqlite3, stat, sys, tempfile, unittest
from pathlib import Path

host = tempfile.TemporaryDirectory(prefix='aibro-import-host-'); os.environ.setdefault('AI_WORKSTATION_DATA_DIR', host.name)
import plugin_import as pi
from mcp_plugins import McpError

FIXTURE = str(Path(__file__).resolve().parent / 'fixtures' / 'mcp-fixture-server.py')
os.chmod(FIXTURE, os.stat(FIXTURE).st_mode | stat.S_IXUSR)


class ImportParserTests(unittest.TestCase):
    def test_mcp_servers_json_classifies_each_server(self):
        text = json.dumps({'mcpServers': {
            'local': {'command': FIXTURE, 'args': ['--x'], 'env': {'API_KEY': 'sk-secret-1234'}},
            'search': {'command': 'npx', 'args': ['-y', '@scope/some-search-mcp']},
            'py': {'command': 'uvx', 'args': ['tool-mcp', '--flag']},
            'bare': {'command': 'node', 'args': ['server.js']},
            'loop': {'url': 'http://127.0.0.1:8765/mcp'},
            'remote': {'type': 'sse', 'url': 'https://mcp.example.com/sse'}}})
        by = {s['name']: s for s in pi.parse_text(text)}
        self.assertEqual({k: v['status'] for k, v in by.items()},
                         {'local': 'ready', 'search': 'needs_install', 'py': 'needs_install', 'bare': 'needs_path', 'loop': 'ready', 'remote': 'unsupported'})
        self.assertEqual(by['search']['installCommand'], 'npm install -g @scope/some-search-mcp')
        self.assertEqual(by['py']['installCommand'], 'uv tool install tool-mcp')
        self.assertEqual(by['local']['env'], {'API_KEY': 'sk-secret-1234'})

    def test_public_view_hides_env_values(self):
        item = pi.parse_text(json.dumps({'mcpServers': {'a': {'command': FIXTURE, 'env': {'TOKEN': 'abcdefgh'}}}}))[0]
        view = pi.public(item, 0)
        self.assertEqual(view['env'], ['TOKEN']); self.assertNotIn('abcdefgh', json.dumps(view))

    def test_other_json_shapes(self):
        single = pi.parse_text(json.dumps({'command': FIXTURE, 'args': []}))
        self.assertEqual(single[0]['status'], 'ready')
        self.assertEqual(pi.parse_text(json.dumps({'zotero': {'command': FIXTURE}}))[0]['name'], 'zotero')
        self.assertEqual(pi.parse_text('"zotero": {"command": "%s"},' % FIXTURE)[0]['name'], 'zotero')
        self.assertEqual(pi.parse_text(json.dumps([{'mcpServers': {'a': {'command': FIXTURE}}}]))[0]['name'], 'a')

    def test_commands_and_urls(self):
        item = pi.parse_text(f'{FIXTURE} --read-only')[0]
        self.assertEqual((item['status'], item['transport']['args']), ('ready', ['--read-only']))
        self.assertEqual(pi.parse_text('http://localhost:9000/mcp')[0]['status'], 'ready')
        self.assertEqual(pi.parse_text('npx -y pkg-x')[0]['status'], 'needs_install')
        wrapped = pi.parse_text('/usr/bin/env npx -y pkg-x')[0]
        self.assertEqual((wrapped['status'], wrapped['installCommand'], wrapped['name']), ('needs_install', 'npm install -g pkg-x', 'pkg-x'))
        self.assertEqual(pi.parse_text('npx -y @scope/some-mcp')[0]['name'], 'some-mcp')

    def test_claude_mcp_add_lines(self):
        a = pi.parse_text(f'claude mcp add -s user -e KEY=abc -e OTHER=1 vocab -- {FIXTURE} --read-only')[0]
        self.assertEqual((a['name'], a['status'], a['env'], a['transport']['args']), ('vocab', 'ready', {'KEY': 'abc', 'OTHER': '1'}, ['--read-only']))
        b = pi.parse_text('claude mcp add --transport http local http://127.0.0.1:7000/mcp')[0]
        self.assertEqual((b['name'], b['status']), ('local', 'ready'))
        c = pi.parse_text('claude mcp add search -- npx -y some-pkg')[0]
        self.assertEqual(c['status'], 'needs_install')
        d = pi.parse_text('claude mcp add --transport sse remote https://x.example/sse')[0]
        self.assertEqual(d['status'], 'unsupported')

    def test_bad_input(self):
        self.assertEqual(pi.parse_text(''), [])
        with self.assertRaises(McpError): pi.parse_text('{"mcpServers": ')
        with self.assertRaises(McpError): pi.parse_text('echo "unterminated')
        with self.assertRaises(McpError): pi.parse_text('x' * (pi.MAX_TEXT + 1))
        self.assertEqual(pi.parse_text('{"mcpServers": {"a": 5, "b": {"command": ""}}}')[0]['status'], 'unsupported')

    def test_plugin_root_placeholder_needs_a_path(self):
        item = pi.parse_text(json.dumps({'mcpServers': {'p': {'command': '${CLAUDE_PLUGIN_ROOT}/bin/serve'}}}))[0]
        self.assertEqual(item['status'], 'needs_path')

    def test_app_config_reads_only_mcp_servers(self):
        config = {'theme': 'dark', 'oauthToken': 'DO-NOT-READ', 'mcpServers': {'a': {'command': FIXTURE}},
                  'projects': {'/p': {'mcpServers': {'b': {'url': 'http://127.0.0.1:9/mcp'}, 'a': {'command': 'node'}}, 'history': ['x']}}}
        found = pi.parse_app_config(json.dumps(config))
        self.assertEqual([s['name'] for s in found], ['a', 'b'])
        self.assertNotIn('DO-NOT-READ', json.dumps(found))
        with self.assertRaises(McpError): pi.parse_app_config('not json')
        self.assertEqual(pi.parse_app_config('[]'), [])

    def test_folder_manifest_counts_without_loading(self):
        files = {'my-plugin/.claude-plugin/plugin.json': json.dumps({'name': 'latex-tools', 'version': '1.2.0', 'description': 'LaTeX helpers'}),
                 'my-plugin/.mcp.json': json.dumps({'mcpServers': {'tex': {'command': 'npx', 'args': ['-y', 'tex-mcp']}}}),
                 'my-plugin/skills/proof/SKILL.md': '# proof', 'my-plugin/skills/bib/SKILL.md': '# bib',
                 'my-plugin/commands/a.md': '', 'my-plugin/commands/b.md': '', 'my-plugin/commands/c.md': '', 'my-plugin/agents/x.md': '',
                 'my-plugin/hooks/hooks.json': '{}', 'my-plugin/README.md': ''}
        result = pi.parse_folder(files)
        self.assertEqual(result['plugin']['name'], 'latex-tools')
        self.assertEqual(result['plugin']['counts'], {'skills': 2, 'commands': 3, 'agents': 1, 'hooks': 1})
        self.assertEqual(sorted(result['plugin']['skills']), ['bib', 'proof'])
        self.assertEqual(result['servers'][0]['status'], 'needs_install')
        with self.assertRaises(McpError): pi.parse_folder({'x/README.md': ''})
        with self.assertRaises(McpError): pi.parse_folder({'x/.claude-plugin/plugin.json': '{bad'})
        with self.assertRaises(McpError): pi.parse_folder([])


    def test_folder_by_path_resolves_plugin_root_and_reads_only_named_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'latex-tools'
            (root / '.claude-plugin').mkdir(parents=True); (root / 'bin').mkdir(); (root / 'skills' / 'proof').mkdir(parents=True); (root / '.ssh').mkdir()
            (root / '.claude-plugin' / 'plugin.json').write_text(json.dumps({'name': 'latex-tools'}))
            (root / 'bin' / 'serve').write_text('#!/bin/sh\n'); (root / 'bin' / 'serve').chmod(0o755)
            (root / '.mcp.json').write_text(json.dumps({'mcpServers': {'tex': {'command': '${CLAUDE_PLUGIN_ROOT}/bin/serve', 'args': ['--root', '${CLAUDE_PLUGIN_ROOT}']}}}))
            (root / 'skills' / 'proof' / 'SKILL.md').write_text('SECRET SKILL BODY')
            files = pi.read_folder_path(str(root))
            self.assertIsNone(files['latex-tools/skills/proof/SKILL.md'], 'only the named files are read')
            self.assertNotIn('latex-tools/.ssh', ' '.join(files))
            result = pi.parse_folder(files)
            server = result['servers'][0]
            self.assertEqual((server['status'], server['transport']['command']), ('ready', str(root.resolve() / 'bin' / 'serve')))
            self.assertEqual(server['transport']['args'][1], str(root.resolve()))
            self.assertEqual(result['plugin']['counts']['skills'], 1)
            for bad in ('relative/path', '/no/such/folder', str(root / '.mcp.json'), '', None): 
                with self.assertRaises(McpError, msg=str(bad)): pi.read_folder_path(bad)
            ssh = Path(tmp) / '.ssh'; ssh.mkdir()
            with self.assertRaises(McpError): pi.read_folder_path(str(ssh))

    def test_cc_switch_database_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'fixture.db'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, server_config TEXT NOT NULL)')
            db.execute('CREATE TABLE secrets (v TEXT)'); db.execute("INSERT INTO secrets VALUES ('DO-NOT-READ')")
            db.execute('INSERT INTO mcp_servers VALUES (?,?,?)', ('1', 'vocab', json.dumps({'type': 'stdio', 'command': FIXTURE, 'args': [], 'env': {'K': 'v'}})))
            db.execute('INSERT INTO mcp_servers VALUES (?,?,?)', ('2', 'broken', 'not json'))
            db.execute('INSERT INTO mcp_servers VALUES (?,?,?)', ('3', 'search', json.dumps({'command': 'npx', 'args': ['-y', 'p']})))
            db.commit(); db.close()
            before = path.read_bytes()
            found = pi.parse_ccswitch_db(before)
            self.assertEqual(sorted(s['name'] for s in found), ['search', 'vocab'])
            self.assertNotIn('DO-NOT-READ', json.dumps(found))
            self.assertEqual(path.read_bytes(), before)
        with self.assertRaises(McpError): pi.parse_ccswitch_db(b'not a database')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'empty.db'; sqlite3.connect(path).execute('CREATE TABLE other (a)').connection.commit()
            with self.assertRaises(McpError): pi.parse_ccswitch_db(path.read_bytes())

    def test_cc_switch_default_location_follows_home(self):
        saved = os.environ.get('HOME')
        with tempfile.TemporaryDirectory() as tmp:
            os.environ['HOME'] = tmp
            try:
                with self.assertRaises(McpError): pi.parse_ccswitch_default()
                folder = Path(tmp) / '.cc-switch'; folder.mkdir()
                db = sqlite3.connect(folder / 'cc-switch.db')
                db.execute('CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, server_config TEXT NOT NULL)')
                db.execute('INSERT INTO mcp_servers VALUES (?,?,?)', ('3', 'search', json.dumps({'command': 'npx', 'args': ['-y', 'p']})))
                db.commit(); db.close()
                self.assertEqual([s['name'] for s in pi.parse_ccswitch_default()], ['search'])
            finally:
                if saved is None: os.environ.pop('HOME', None)
                else: os.environ['HOME'] = saved


if __name__ == '__main__':
    unittest.main()
