"""Disposable desktop participant in the mobile reminder cloud integration test."""
import json
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'app'))
from sync_store import SyncStore

config = json.load(sys.stdin)
assert urlparse(config['base']).hostname == '127.0.0.1', 'only the isolated local fixture is supported'


def call(path, body=None):
    request = Request(config['base'] + path,
                      data=None if body is None else json.dumps(body).encode(),
                      headers={'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'})
    with urlopen(request, timeout=10) as response:
        return json.load(response)


with tempfile.TemporaryDirectory(prefix='aibro-desktop-reminder-wire-') as directory:
    desktop = SyncStore(directory)
    incoming = call('/v1/sync/pull?cursor=0&limit=100')
    assert not incoming.get('hasMore'), 'fixture unexpectedly needs another page'
    desktop.apply_changes(incoming['changes'], incoming['cursor'])
    snapshot = desktop.snapshot()
    for task in snapshot['tasks']:
        task['title'] += ' reviewed on desktop'
        if task['id'] == 'early':
            task['reminderMinutes'] = 60
        elif task['id'] == 'week':
            del task['reminderMinutes']
    desktop.capture(snapshot)
    outgoing = desktop.pending()
    result = call('/v1/sync/push', {'operations': outgoing})
    assert not result['conflicts']
    assert len(result['accepted']) == len(outgoing)
    desktop.ack(result['accepted'], result['conflicts'])
    assert desktop.status()['pending'] == 0
    print(json.dumps({'accepted': len(result['accepted'])}))
