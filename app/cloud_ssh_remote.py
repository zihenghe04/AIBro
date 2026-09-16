"""Fixed remote helper for the AI Bro systemd user service; JSON on stdin/stdout.

No credentials, SSH keys, arbitrary commands or account contents are returned.
Path changes copy and verify while the service is stopped, retaining the source.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request

UNIT = 'ai-workstation-cloud.service'


def control(*args):
    return subprocess.run(['systemctl', '--user', *args], check=True, capture_output=True, text=True, timeout=45).stdout.strip()


def plain_path(raw):
    path = Path(raw)
    if not path.is_absolute() or '..' in path.parts or any(ord(c) < 32 for c in str(path)):
        raise ValueError('请使用不含 .. 的绝对目录路径。')
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError('数据路径不能经过符号链接。')
    return path


def account_check(root, account_id, cursor=0):
    if not account_id:
        raise ValueError('请先连接云同步账号，再检查 SSH 部署。')
    dbpath = plain_path(str(root / 'cloud.sqlite3'))
    with contextlib.closing(sqlite3.connect(dbpath.as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT change_seq FROM accounts WHERE id=?', (account_id,)).fetchone()
        if not row or row[0] < int(cursor):
            raise ValueError('SSH 目标不是当前账号的数据，或比本机同步进度更旧；未切换连接。')


def deployment(account_id, cursor=0):
    if control('is-active', UNIT) != 'active':
        raise ValueError('云同步用户服务未运行，请先恢复服务。')
    pid = int(control('show', UNIT, '--property=MainPID', '--value'))
    argv = Path(f'/proc/{pid}/cmdline').read_bytes().decode().rstrip('\0').split('\0')
    if len(argv) < 5 or Path(argv[1]).name != 'cloud_server.py' or 'serve' not in argv:
        raise ValueError('无法识别当前云服务启动配置，未执行修改。')
    def arg(name):
        if argv.count(name) != 1:
            raise ValueError('云服务缺少明确的启动参数。')
        return argv[argv.index(name) + 1]
    root = plain_path(arg('--data-dir'))
    if not root.is_dir() or root.stat().st_uid != os.getuid():
        raise ValueError('当前账号不拥有云数据目录。')
    if arg('--host') != '127.0.0.1':
        raise ValueError('SSH 管理仅用于监听 127.0.0.1 的个人云服务。')
    port = int(arg('--port'))
    if not 1 <= port <= 65535:
        raise ValueError('云服务端口无效。')
    account_check(root, account_id, cursor)
    return {'dataPath': str(root), 'databasePath': str(root / 'cloud.sqlite3'),
            'service': UNIT, 'remotePort': port, 'active': True, 'argv': argv}


def manifest(root):
    rows = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError('数据目录含符号链接或特殊文件，未迁移。')
        if path.is_file():
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else None
                if digest is None:
                    h = hashlib.sha256()
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
                    digest = h.hexdigest()
            rows[str(path.relative_to(root))] = (path.stat().st_size, digest)
    return rows


def systemd_arg(value):
    # systemd ExecStart syntax is not shell syntax. Escape its own expansions.
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def atomic(path, content):
    fd, name = tempfile.mkstemp(prefix='.aibro-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def destination(source, raw):
    target = plain_path(raw)
    if target == source or target in source.parents or source in target.parents:
        raise ValueError('新目录不能与旧目录相同，也不能互相包含。')
    if target.exists():
        raise ValueError('目标目录已存在，请选择一个尚不存在的新目录，避免覆盖数据。')
    if not target.parent.is_dir() or target.parent.stat().st_uid != os.getuid() or not os.access(target.parent, os.W_OK):
        raise ValueError('目标上级目录须已存在，且由当前 SSH 用户拥有并可写。')
    return target


def relocate(payload):
    info = deployment(payload['accountId'], payload.get('cursor', 0))
    source = Path(info['dataPath'])
    if info['dataPath'] != payload.get('expectedPath'):
        raise ValueError('服务器路径已发生变化，请重新读取后再修改。')
    target = destination(source, payload.get('dataPath', ''))
    override_dir = plain_path(str(Path.home() / '.config/systemd/user' / (UNIT + '.d')))
    override_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    override = plain_path(str(override_dir / '90-aibro-storage.conf'))
    old = override.read_bytes() if override.exists() else None
    argv = list(info['argv']); argv[argv.index('--data-dir') + 1] = str(target)
    # Later overrides could silently cancel our setting. Verify the resulting
    # process and path before reporting success; roll back if that happens.
    content = ('[Service]\nExecStart=\nExecStart=' + ' '.join(map(systemd_arg, argv)) + '\n').encode()
    stopped = False
    try:
        control('stop', UNIT); stopped = True
        if control('show', UNIT, '--property=MainPID', '--value') != '0':
            raise ValueError('服务未完全停止，未复制数据。')
        before = manifest(source)
        shutil.copytree(source, target, symlinks=True)
        os.chmod(target, 0o700)
        if before != manifest(target) or before != manifest(source):
            raise ValueError('复制校验失败或源目录仍在变化，未切换。')
        account_check(target, payload['accountId'], payload.get('cursor', 0))
        with contextlib.closing(sqlite3.connect((target / 'cloud.sqlite3').as_uri() + '?mode=ro', uri=True)) as db:
            if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('目标数据库校验失败。')
        atomic(override, content)
        control('daemon-reload'); control('start', UNIT)
        current = deployment(payload['accountId'], payload.get('cursor', 0))
        if current['dataPath'] != str(target):
            raise ValueError('服务没有采用新目录。')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{current["remotePort"]}/v1/health', timeout=10) as response:
            if json.load(response).get('protocol') != 1: raise ValueError('新目录健康检查失败。')
        current.pop('argv', None)
        return {**current, 'previousPath': str(source), 'verifiedFiles': len(before)}
    except Exception as error:
        if stopped:
            try:
                control('stop', UNIT)
                if old is None: override.unlink(missing_ok=True)
                else: atomic(override, old)
                control('daemon-reload'); control('start', UNIT)
                restored = deployment(payload['accountId'], payload.get('cursor', 0))
                if restored['dataPath'] != str(source): raise ValueError()
            except Exception:
                raise ValueError('迁移未完成，自动恢复未确认。旧目录仍保留，请检查用户服务后再同步。') from None
        if isinstance(error, ValueError): raise
        raise ValueError('迁移未完成，已恢复旧服务；旧目录与已复制的目标文件均保留。') from None


def main():
    try:
        payload = json.load(sys.stdin)
        # Serialize with a server-wide per-user lock, never stored in the data
        # directory that is being copied. Inspection stays read-only.
        if payload.get('action') == 'move':
            lock = plain_path(str(Path.home() / '.config/systemd/user/.aibro-storage.lock'))
            with lock.open('a') as stream:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = relocate(payload)
        else:
            result = deployment(payload['accountId'], payload.get('cursor', 0)); result.pop('argv', None)
        print(json.dumps({'ok': True, **result}, ensure_ascii=False))
    except ValueError as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'ok': False, 'error': '无法读取或修改云服务，请检查 SSH 权限和用户服务状态。'}, ensure_ascii=False))


if __name__ == '__main__': main()
