import json
import socket
import tempfile
import threading
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from server import ASSET_FINGERPRINT, ConflictError, Handler, LoopbackHTTPServer, WorkspaceStore

# Preserve the stdlib request-thread/reuse behavior while avoiding its blocking
# reverse lookup. Use a real ephemeral socket and the actual health handler.
with patch.object(socket, 'getfqdn', side_effect=AssertionError('Unexpected reverse DNS')), \
     patch.object(socket, 'gethostbyaddr', side_effect=AssertionError('Unexpected reverse DNS')):
    httpd = LoopbackHTTPServer(('127.0.0.1', 0), Handler)
    assert httpd.daemon_threads == ThreadingHTTPServer.daemon_threads
    assert httpd.allow_reuse_address == ThreadingHTTPServer.allow_reuse_address
    assert httpd.server_name == '127.0.0.1'
    assert httpd.server_port == httpd.socket.getsockname()[1] > 0
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{httpd.server_port}/__health', timeout=3) as response:
            health = json.load(response)
        assert health['assetFingerprint'] == ASSET_FINGERPRINT
        assert health['app'] == 'ai-workstation' and health['port'] == httpd.server_port
    finally:
        httpd.shutdown(); httpd.server_close(); thread.join(timeout=3)

with tempfile.TemporaryDirectory() as directory:
    store = WorkspaceStore(directory)
    state = {key: [] for key in ('projects', 'tasks', 'notes', 'imports', 'conversations', 'trash', 'agentRuns')}
    state['_revision'] = 0
    state['_pendingLocalSave'] = True
    result = store.save(state)
    assert result['revision'] == 1
    saved = store.load()
    assert saved['_revision'] == 1
    assert '_pendingLocalSave' not in saved, 'Client dirty markers must not hydrate other clients as unsynchronized drafts'
    stale = {**state, '_revision': 0}
    try:
        store.save(stale)
    except ConflictError:
        pass
    else:
        raise AssertionError('stale state must be rejected')
    metadata = store.save_file('att-test', b'pdf bytes', '材料.pdf', 'application/pdf')
    assert metadata['size'] == 9
    assert (Path(directory) / 'files' / 'att-test').read_bytes() == b'pdf bytes'
print('server store tests passed')
