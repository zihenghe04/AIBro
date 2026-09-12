"""Same-named figures must resolve to the owning paper, never a global hit."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server


def get(origin, suffix):
    try: response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(origin + suffix, timeout=3)
    except urllib.error.HTTPError as error: return error.code, error.read()
    with response: return response.status, response.read()


with tempfile.TemporaryDirectory(prefix='workstation-figure-test-') as temporary:
    store = server.WorkspaceStore(temporary)
    papers = [{'id': 'paper-one', 'title': 'First Paper', 'year': 2026}, {'id': 'paper-two', 'title': 'Second Paper', 'year': 2026}]
    state = {key: [] for key in ('projects', 'tasks', 'notes', 'imports', 'conversations', 'trash', 'agentRuns')}
    store.save({**state, '_revision': 0, 'papers': papers})
    directories = [store.paper_directory(paper) / 'figures' for paper in papers]
    filename = 'page-1-figure-1.png'
    values = [b'\x89PNG\r\n\x1a\nfirst-paper-image', b'\x89PNG\r\n\x1a\nsecond-paper-image']
    for directory, value in zip(directories, values):
        directory.mkdir(exist_ok=True)
        (directory / filename).write_bytes(value)
    (directories[0] / 'linked.png').symlink_to(directories[1] / filename)
    (directories[0] / 'outside.png').symlink_to(Path(temporary) / 'workspace.json')

    class QuietHandler(server.Handler):
        def log_message(self, *args): pass
    original_store = server.STORE
    server.STORE = store
    httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{httpd.server_port}'
    try:
        for paper, value in zip(papers, values):
            assert get(origin, f'/__papers/{paper["id"]}/figures/{filename}') == (200, value)
        assert get(origin, f'/__papers/missing/figures/{filename}')[0] == 404
        assert get(origin, '/__papers/paper-one/figures/missing.png')[0] == 404
        for filename in ('linked.png', 'outside.png', '..%2Fpaper.json', '%2e%2e', 'dir%5Cfile.png', 'nested/file.png'):
            assert get(origin, f'/__papers/paper-one/figures/{filename}')[0] == 400, filename
        directories[0].rename(directories[0].with_name('figures-original'))
        directories[0].symlink_to(directories[1], target_is_directory=True)
        assert get(origin, '/__papers/paper-one/figures/page-1-figure-1.png')[0] == 400
        assert get(origin, '/__papers/paper-two/figures/page-1-figure-1.png') == (200, values[1])
    finally:
        httpd.shutdown(); httpd.server_close(); thread.join(timeout=3)
        server.STORE = original_store

print('Paper figure ownership, duplicate filenames, missing papers and traversal/symlink tests passed')
