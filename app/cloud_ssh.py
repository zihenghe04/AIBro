"""Manage the user's existing cloud SSH tunnel without exposing SSH credentials."""
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import subprocess
import threading
import time
import urllib.parse
from cloud_sync import CloudSyncError

LABEL = 'app.ai-workstation.cloud-tunnel'


def config(value):
    target = str(value.get('target', '')).strip()
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@-]{0,250}', target) or target.count('@') > 1:
        raise CloudSyncError('请填写 SSH 主机别名或 用户名@主机；不填写命令或密码。')
    result = {'target': target}
    for key, fallback in [('sshPort', 0), ('localPort', 18787), ('remotePort', 8787)]:
        try: port = int(value.get(key, fallback))
        except (TypeError, ValueError): raise CloudSyncError('端口必须为整数。') from None
        if not (0 if key == 'sshPort' else 1) <= port <= 65535:
            raise CloudSyncError('端口范围无效。')
        result[key] = port
    return result


def ssh_args(value):
    c = config(value)
    args = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
            '-o', 'ControlPath=none']
    if c['sshPort']: args += ['-p', str(c['sshPort'])]
    return args


def read_tunnel(path):
    if not path.exists(): return None
    if path.is_symlink() or path.stat().st_uid != os.getuid(): raise CloudSyncError('SSH 启动项路径不安全。')
    try:
        value = plistlib.loads(path.read_bytes()); args = value['ProgramArguments']
        if value.get('Label') != LABEL or args[0] != '/usr/bin/ssh' or '-L' not in args: return None
        forward = args[args.index('-L') + 1]
        match = re.fullmatch(r'127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)', forward)
        if not match: return None
        return config({'target': args[-1], 'sshPort': args[args.index('-p') + 1] if '-p' in args else 0,
                       'localPort': match[1], 'remotePort': match[2]})
    except (KeyError, ValueError, IndexError, TypeError):
        raise CloudSyncError('无法识别已有 SSH 启动项，未覆盖。') from None


class CloudSSH:
    def __init__(self, service, *, home=None, runner=subprocess.run):
        self.service = service; self.home = Path(home or Path.home()); self.runner = runner
        self.path = self.home / 'Library/LaunchAgents' / (LABEL + '.plist')
        self.lock = threading.Lock(); self.job = None; self.remote_info = None

    def status(self):
        current = read_tunnel(self.path)
        return {'config': current, 'remote': self.remote_info, 'job': self.job,
                'configPath': str(self.path), 'available': bool(current)}

    def _bound(self, c):
        status = self.service.status(); target = status.get('target') or {}
        parsed = urllib.parse.urlsplit(target.get('serverUrl') or '')
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.port != c['localPort']:
            raise CloudSyncError('SSH 本机端口必须对应此工作区已绑定的同步地址，未改动现有连接。')
        if not target.get('accountId'): raise CloudSyncError('请先连接同步账号。')
        return {'accountId': target['accountId'], 'cursor': status.get('cursor', 0)}

    def _remote(self, c, payload, timeout=40):
        program = Path(__file__).with_name('cloud_ssh_remote.py').read_text()
        args = ssh_args(c) + [c['target'], 'python3 -c ' + shlex.quote(program)]
        try:
            r = self.runner(args, input=json.dumps(payload), capture_output=True, text=True, timeout=timeout)
            if r.returncode: raise CloudSyncError('SSH 未连接。请检查主机、端口、密钥登录及已确认的主机指纹。')
            value = json.loads(r.stdout)
        except (subprocess.TimeoutExpired, OSError, ValueError):
            raise CloudSyncError('SSH 操作未得到明确结果，请重新读取服务器状态后再操作。') from None
        if not isinstance(value, dict) or value.get('ok') is not True:
            raise CloudSyncError(value.get('error', 'SSH 云服务检查失败。') if isinstance(value, dict) else 'SSH 返回格式无效。')
        if value.get('remotePort') != c['remotePort']:
            raise CloudSyncError('SSH 转发端口与服务器实际监听端口不同，请修正远程端口。')
        return value

    def inspect(self, payload):
        c = config(payload.get('config') or read_tunnel(self.path) or {})
        result = self._remote(c, {**self._bound(c), 'action': 'inspect'})
        if c == read_tunnel(self.path): self.remote_info = result
        return {'config': c, 'remote': result}

    def _launch(self, action):
        return self.runner(['/bin/launchctl', action, f'gui/{os.getuid()}', str(self.path)],
                           capture_output=True, text=True, timeout=20)

    def save(self, payload):
        c = config(payload.get('config') or {})
        if not self.lock.acquire(blocking=False): raise CloudSyncError('SSH 操作正在进行。')
        if not self.service._sync_lock.acquire(blocking=False):
            self.lock.release(); raise CloudSyncError('正在同步，请稍后再修改 SSH 连接。')
        try:
            remote = self._remote(c, {**self._bound(c), 'action': 'inspect'})
            if not self.path.exists(): raise CloudSyncError('未找到已有 SSH 启动项，请先配置初次部署。')
            read_tunnel(self.path)  # ownership/symlink validation before overwrite
            original = self.path.read_bytes(); value = plistlib.loads(original)
            value['ProgramArguments'] = ssh_args(c) + ['-N', '-o', 'ExitOnForwardFailure=yes', '-L',
                f'127.0.0.1:{c["localPort"]}:127.0.0.1:{c["remotePort"]}', c['target']]
            backup = self.path.with_name(self.path.name + f'.backup-{time.time_ns()}')
            with backup.open('xb') as stream: stream.write(original)
            os.chmod(backup, 0o600)
            from cloud_ssh_remote import atomic
            try:
                atomic(self.path, plistlib.dumps(value))
                self._launch('bootout')
                if self._launch('bootstrap').returncode: raise CloudSyncError('新隧道启动失败。')
                # Do not declare success just because launchd accepted a job.
                from cloud_sync import CloudClient
                for attempt in range(12):
                    try:
                        CloudClient(f'http://127.0.0.1:{c["localPort"]}', timeout=2).health(); break
                    except CloudSyncError:
                        if attempt == 11: raise
                        time.sleep(0.5)
            except Exception:
                self._launch('bootout'); atomic(self.path, original)
                restored = self._launch('bootstrap').returncode == 0
                raise CloudSyncError('新连接未通过检查，已还原旧配置。' + ('' if restored else '旧隧道需要手动重新启动。')) from None
            self.remote_info = remote
            return self.status()
        finally:
            self.service._sync_lock.release(); self.lock.release()

    def move(self, payload):
        if payload.get('confirmed') is not True: raise CloudSyncError('请先确认复制校验后切换目录。')
        c = read_tunnel(self.path)
        if not c: raise CloudSyncError('未找到 SSH 隧道。')
        if not self.lock.acquire(blocking=False): raise CloudSyncError('SSH 操作正在进行。')
        if not self.service._sync_lock.acquire(blocking=False):
            self.lock.release(); raise CloudSyncError('正在同步，请稍后再迁移。')
        try:
            identity = self._bound(c)
            raw = payload.get('dataPath')
            if not isinstance(raw, str) or len(raw) > 2048 or not raw.startswith('/'):
                raise CloudSyncError('请输入服务器上的绝对目录路径。')
            expected = payload.get('expectedPath')
            if not self.remote_info or expected != self.remote_info.get('dataPath'):
                raise CloudSyncError('请先读取当前服务器目录。')
            restore_auto = self.service.status().get('autoSync', False)
            self.service.settings({'autoSync': False})
            self.job = {'state': 'running', 'source': expected, 'destination': raw,
                        'message': '正在停止服务、复制校验并切换目录；旧目录将保留。'}
        except Exception:
            self.service._sync_lock.release(); self.lock.release(); raise
        def work():
            try:
                result = self._remote(c, {**identity, 'action': 'move', 'expectedPath': expected, 'dataPath': raw}, timeout=600)
                self.remote_info = result
                self.job = {**self.job, 'state': 'completed', 'message': '已复制并校验，服务已切换。旧目录保留在原位置。'}
                self.service.settings({'autoSync': restore_auto})
            except Exception as error:
                self.job = {**self.job, 'state': 'error', 'message': str(error) if isinstance(error, CloudSyncError) else '迁移结果未确认；自动同步已暂停，请检查服务器。'}
            finally:
                self.service._sync_lock.release(); self.lock.release()
        threading.Thread(target=work, daemon=True, name='cloud-storage-move').start()
        return self.status()
