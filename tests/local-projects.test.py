"""Read-only local projects and HTTP boundaries; only temporary fixtures."""
import json
import os
import tempfile
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from http_test_support import python_http_service

from local_projects import LocalProjectError, LocalProjects

ROOT = Path(__file__).resolve().parents[1]


def reject(action, status=None):
    try:
        action()
    except LocalProjectError as error:
        if status is not None:
            assert error.status == status, (str(error), error.status)
    else:
        raise AssertionError('unsafe or invalid request was accepted')


def fixture(base):
    root = base / 'projects'
    site = root / 'my-portfolio'
    (site / 'src').mkdir(parents=True)
    (site / 'README.md').write_text('# Personal homepage\nThe site uses Vite.\n')
    (site / 'package.json').write_text('{"name":"personal-homepage","scripts":{"dev":"vite"}}')
    (site / 'index.html').write_text('<html><body>Homepage</body></html>')
    (site / 'src' / 'App.tsx').write_text('export default function App() { return <main>Hello</main>; }')
    (site / '.env').write_text('TOKEN=do-not-disclose-env')
    (site / 'credentials.json').write_text('{"secret":"do-not-disclose-credentials"}')
    (site / 'access_token.json').write_text('{"token":"do-not-disclose-token"}')
    (site / 'private-key.pem').write_text('do-not-disclose-key')
    (site / '.git').mkdir()
    (site / '.git' / 'config').write_text('do-not-disclose-git')
    (site / 'node_modules' / 'package').mkdir(parents=True)
    (site / 'node_modules' / 'package' / 'index.html').write_text('do-not-disclose-dependency')
    (site / 'dist').mkdir()
    (site / 'dist' / 'index.html').write_text('do-not-disclose-build')
    (site / 'secrets').mkdir()
    (site / 'secrets' / 'README.md').write_text('do-not-disclose-secret-dir')
    outside = base / 'outside'
    outside.mkdir()
    (outside / 'README.md').write_text('do-not-disclose-outside')
    (site / 'linked-folder').symlink_to(outside, target_is_directory=True)
    (site / 'linked.md').symlink_to(outside / 'README.md')
    return root, site, outside


@contextmanager
def serve(data_directory):
    with python_http_service(ROOT / 'server.py', cwd=ROOT,
        env={**os.environ, 'HOME': str(data_directory.parent / 'fixture-home'), 'AI_WORKSTATION_PORT': '0', 'AI_WORKSTATION_DATA_DIR': str(data_directory)},
    ) as origin:
        yield origin


def request(origin, path, method='GET', payload=None, source='same-origin', host=None):
    headers = {'Content-Type': 'application/json'}
    if source is not None:
        headers['Origin'] = origin if source == 'same-origin' else source
    if host is not None:
        headers['Host'] = host
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(urllib.request.Request(origin + path, data=data, method=method, headers=headers), timeout=8)
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    with response:
        return response.status, response.read()


with tempfile.TemporaryDirectory(prefix='workstation-local-projects-') as temporary:
    base = Path(temporary).resolve()
    root, site, outside = fixture(base)
    fixture_home = base / 'fixture-home'
    (fixture_home / 'Documents').mkdir(parents=True)
    (fixture_home / 'Code').mkdir()
    (fixture_home / 'Sites').symlink_to(outside, target_is_directory=True)
    preset_store = LocalProjects(base / 'preset-data', home_directory=fixture_home)
    assert {item['name'] for item in preset_store.roots()['suggestedRoots']} == {'文稿', 'Code'}
    assert preset_store.roots()['roots'] == [], 'suggestions never grant access'
    preset = preset_store.connect_preset('common-projects')
    assert len(preset['roots']) == 2 and len(preset['candidates']) == 2
    assert all(item['path'].startswith(str(fixture_home)) for item in preset['roots'])
    reject(lambda: preset_store.connect_preset('entire-disk'))
    for index in range(15):
        (fixture_home / 'Documents' / f'archive-{index}').mkdir()
    (fixture_home / 'Code' / 'portfolio').mkdir()
    (fixture_home / 'Code' / 'portfolio' / 'index.html').write_text('<h1>Homepage</h1>')
    preset_store.MAX_DIRS = 6
    preset_search = preset_store.search('个人主页')
    assert any(item['name'] == 'portfolio' for item in preset_search['candidates']), 'large Documents trees must leave budget for Code/Sites roots'
    assert preset_search['truncated'] and preset_search['scannedDirectories'] <= 6
    (fixture_home / 'Code' / 'resume').mkdir()
    (fixture_home / 'Code' / 'resume' / 'package.json').write_text('{}')
    (fixture_home / 'Code' / '简历').mkdir()
    (fixture_home / 'Code' / '简历' / 'package.json').write_text('{}')
    preset_store.MAX_DIRS = 100
    for query in ('帮我在本机搜索 resume 代码项目', 'find my resume project on my computer', '帮我找名叫「resume」的代码', 'find the "resume" project on my computer'):
        assert {item['name'] for item in preset_store.search(query)['candidates']} == {'resume'}, query
    for query in ('帮我在电脑找我的简历代码', '帮我找名叫“简历”的代码项目'):
        assert {item['name'] for item in preset_store.search(query)['candidates']} == {'简历'}, query
    preset_store.connect(str(fixture_home / 'Code' / 'portfolio'))
    overlap = preset_store.search('portfolio')['candidates']
    assert len([item for item in overlap if item['name'] == 'portfolio']) == 1 and len({item['path'] for item in overlap}) == len(overlap), 'overlapping roots must not repeat the same directory in search results'
    store = LocalProjects(base / 'data', home_directory=fixture_home)
    assert store.roots()['roots'] == []
    assert store.search('个人主页')['candidates'] == []
    reject(lambda: store.connect('../outside'))
    reject(lambda: store.connect(str(site / 'README.md')))
    reject(lambda: store.connect(str(site / 'linked-folder')), 403)
    (outside / 'nested').mkdir()
    reject(lambda: store.connect(str(site / 'linked-folder' / 'nested')), 403)
    reject(lambda: store.connect(str(site / '.git')), 403)
    reject(lambda: store.connect('/'), 403)
    connection = store.connect(str(root))
    assert store.connect(str(root))['root']['id'] == connection['root']['id'], 'reconnecting must be idempotent'
    assert connection['candidate']['relativePath'] == ''
    assert store.snapshot(connection['candidate']['id'])['folder']['path'] == str(root)
    candidates = store.search('个人主页')['candidates']
    candidate = next(item for item in candidates if item['path'] == str(site))
    assert 'node_modules' not in json.dumps(candidates)
    assert 'linked-folder' not in json.dumps(candidates)
    snapshot = store.snapshot(candidate['id'])
    combined = json.dumps(snapshot)
    for excluded in ('do-not-disclose', '.env', '.git', 'node_modules', 'credentials', 'access_token', 'private-key', 'linked-folder', 'linked.md'):
        assert excluded not in combined, excluded
    assert {item['path'] for item in snapshot['files']} >= {'README.md', 'package.json', 'index.html', 'src/App.tsx'}
    assert snapshot['totalFiles'] == 4
    assert snapshot['files'][0]['path'] == 'README.md'
    (site / 'README.md').write_text('# Changed on disk\n')
    restarted = LocalProjects(base / 'data')
    assert restarted.snapshot(candidate['id'])['files'][0]['content'] == '# Changed on disk\n', 'snapshots must reread current disk content after restart'
    assert restarted.search('portfolio')['candidates'][0]['id'] == candidate['id'], 'candidate IDs must be stable'
    reject(lambda: store.snapshot('../outside'))
    reject(lambda: store.snapshot('%2e%2e%2foutside'))
    reject(lambda: store.search('x', 500))
    reject(lambda: store.search('x', True))
    # A directory replaced with a symlink after discovery must not escape.
    moved = root / 'moved-site'
    site.rename(moved)
    site.symlink_to(outside, target_is_directory=True)
    reject(lambda: store.snapshot(candidate['id']), 404)
    site.unlink()
    moved.rename(site)
    # Even a corrupted candidate entry cannot inject traversal or encoding.
    persisted = json.loads(store.path.read_text())
    original_relative = persisted['candidates'][candidate['id']]['relativePath']
    for invalid in ('../outside', '%2e%2e/outside', '/outside', 'my-portfolio/../outside', 'my-portfolio/secrets', 'my-portfolio\\secrets'):
        persisted['candidates'][candidate['id']]['relativePath'] = invalid
        store.path.write_text(json.dumps(persisted))
        reject(lambda: store.snapshot(candidate['id']))
    persisted['candidates'][candidate['id']]['relativePath'] = original_relative
    store.path.write_text(json.dumps(persisted))
    # Enforce both per-file and total prompt budgets.
    (site / 'README.md').write_text('界' * 20000)
    for index in range(15):
        (site / 'src' / f'component-{index}.tsx').write_text('x' * 14000)
    limited = store.snapshot(candidate['id'])
    assert limited['truncated']
    assert sum(len(item['content']) for item in limited['files']) <= 60000
    assert all(len(item['content']) <= 12000 for item in limited['files'])
    assert len(limited['files']) <= 12
    for index in range(350):
        (site / f'asset-{index}.txt').write_text('asset')
    tree_limited = store.snapshot(candidate['id'])
    assert len(tree_limited['tree']) <= 300 and tree_limited['truncated']
    assert tree_limited['files'][0]['path'] == 'README.md', 'entry points must survive large asset directories'
    assert 'src/App.tsx' in {item['path'] for item in tree_limited['files']}, 'large root directories must leave room for source previews'
    store.disconnect(connection['root']['id'])
    assert store.roots()['roots'] == []
    reject(lambda: restarted.snapshot(candidate['id']), 403)
    assert site.is_dir() and (site / 'README.md').is_file(), 'disconnect must preserve original code'
    reconnected = store.connect(str(root))
    assert reconnected['root']['id'] != connection['root']['id']
    reject(lambda: store.snapshot(candidate['id']), 403)
    # Revocation of a replaced root itself also fails closed.
    root_moved = base / 'moved-root'
    root.rename(root_moved)
    root.symlink_to(outside, target_is_directory=True)
    reject(lambda: store.snapshot(reconnected['candidate']['id']), 404)
    root.unlink()
    root_moved.rename(root)
    # HTTP only exposes the constrained JSON API, never arbitrary raw files.
    with serve(base / 'http-data') as origin:
        assert json.loads(request(origin, '/__local/roots')[1])['roots'] == []
        for source in (None, 'null', 'https://attacker.invalid'):
            assert request(origin, '/__local/roots', 'POST', {'path': str(root)}, source)[0] == 403
        host_result = request(origin, '/__local/roots', host='attacker.invalid')
        assert host_result[0] == 403, host_result
        assert request(origin, '/__local/roots', source='https://attacker.invalid')[0] == 403
        status, body = request(origin, '/__local/roots', 'POST', {'path': str(root)})
        assert status == 200, body
        http_root = json.loads(body)
        status, body = request(origin, '/__local/search', 'POST', {'query': '个人主页'})
        assert status == 200, body
        http_candidate = next(item for item in json.loads(body)['candidates'] if item['path'] == str(site))
        status, body = request(origin, '/__local/snapshot', 'POST', {'candidateId': http_candidate['id']})
        assert status == 200 and 'do-not-disclose' not in body.decode(), body[:200]
        for path in ('/local_projects.py', '/local-roots.json', '/__local/files/README.md', '/__local/roots/%2e%2e', '/__local/roots.json'):
            assert request(origin, path)[0] == 404, path
        assert request(origin, '/__local/snapshot', 'POST', {'candidateId': '../outside'})[0] == 400
        assert request(origin, '/__local/roots', 'POST', [str(root)])[0] == 400
        assert request(origin, '/__local/roots/' + http_root['root']['id'], 'DELETE', source=None)[0] == 403
        assert request(origin, '/__local/roots/' + http_root['root']['id'], 'DELETE')[0] == 200
        assert request(origin, '/__local/snapshot', 'POST', {'candidateId': http_candidate['id']})[0] == 403
        assert (site / 'README.md').exists()
        status, body = request(origin, '/__local/roots', 'POST', {'preset': 'common-projects'})
        assert status == 200 and len(json.loads(body)['roots']) == 2, body
        assert request(origin, '/__local/roots', 'POST', {'preset': 'entire-disk'})[0] == 400

print('local project connection, discovery, durable snapshots, limits, revocation and HTTP boundary tests passed')
