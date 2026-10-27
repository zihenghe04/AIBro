"""Codex CLI as a model connection: install/login detection, availability test and a per-CLI-version model cache.

Only official status commands run (`codex --version`, `codex login status`) and only their exit code is kept.
No credential file is opened here or in the bridge; the official runtime reads its own account.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time

from codex_bridge import BridgeError, child_environment, runtime_command

CACHE_VERSION = 1
CACHE_NAME = 'codex-models-cache.json'
VERSION_PATTERN = re.compile(r'\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?)\b')
MODES = ('shared', 'private')


def parse_version(text):
    match = VERSION_PATTERN.search(text or '')
    return match.group(1) if match else None


class CodexConnection:
    def __init__(self, data_directory, bridges, command=None, timeout=8):
        self.directory = Path(data_directory).resolve()
        self.cache_path = self.directory / CACHE_NAME
        self.bridges, self.command, self.timeout = bridges, command, timeout
        self.lock = threading.Lock()

    def _command(self):
        return self.command if self.command is not None else runtime_command()

    def _run(self, command, arguments, home, capture):
        """Run one official subcommand. Returns (exit_code | None, stdout). Output other than --version is discarded."""
        try:
            result = subprocess.run([*command, *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, env=child_environment(home), cwd=tempfile.gettempdir(), timeout=self.timeout, text=True)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return None, ''
        return result.returncode, (result.stdout or '')[:512] if capture else ''

    def _home(self, mode):
        bridge = self.bridges(mode)
        return bridge.home

    def detect(self, mode):
        if mode not in MODES: raise BridgeError('登录方式无效。', 400, 'invalid_mode')
        command = self._command()
        if not command:
            return {'mode': mode, 'installed': False, 'version': None, 'loggedIn': False, 'loginExitCode': None}
        code, output = self._run(command, ['--version'], self._home(mode), True)
        version = parse_version(output) if code == 0 else None
        home = self._home(mode)
        # A private home that does not exist yet cannot hold a login; skip the process.
        if home is not None and not home.is_dir(): login = None
        elif version is None: login = None
        else: login, _ = self._run(command, ['login', 'status'], home, False)
        return {'mode': mode, 'installed': version is not None, 'path': str(command[0]), 'version': version, 'loggedIn': login == 0, 'loginExitCode': login}

    # ---- model cache, keyed by login mode and CLI version ----
    def _read_cache(self):
        try: value = json.loads(self.cache_path.read_text('utf-8'))
        except (OSError, ValueError): return {}
        return value.get('entries', {}) if isinstance(value, dict) and value.get('version') == CACHE_VERSION and isinstance(value.get('entries'), dict) else {}

    def _write_cache(self, entries):
        self.directory.mkdir(parents=True, exist_ok=True)
        handle, name = tempfile.mkstemp(prefix=CACHE_NAME, dir=self.directory)
        try:
            with os.fdopen(handle, 'w', encoding='utf-8') as file: json.dump({'version': CACHE_VERSION, 'entries': entries}, file, ensure_ascii=False)
            os.replace(name, self.cache_path)
        except OSError:
            try: os.unlink(name)
            except OSError: pass

    def cached_models(self, mode):
        """Model list from the cache only: runs the status commands but never starts the runtime."""
        detected = self.detect(mode)
        entry = self._read_cache().get(mode) if detected['installed'] else None
        if isinstance(entry, dict) and entry.get('cliVersion') == detected['version'] and isinstance(entry.get('models'), list):
            return {'data': entry['models'], 'cached': True, 'cliVersion': detected['version']}
        return {'data': [], 'cached': False, 'cliVersion': detected['version'], 'stale': True}

    def models(self, mode, refresh=False):
        detected = self.detect(mode)
        if not detected['installed']: raise BridgeError('未找到官方 Codex CLI，请安装后重新检测。', 503, 'codex_unavailable')
        version = detected['version']
        with self.lock:
            entry = self._read_cache().get(mode)
            if not refresh and isinstance(entry, dict) and entry.get('cliVersion') == version and isinstance(entry.get('models'), list):
                return {'data': entry['models'], 'cached': True, 'cliVersion': version}
        data = self.bridges(mode).models()['data']
        with self.lock:
            entries = self._read_cache(); entries[mode] = {'cliVersion': version, 'models': data, 'at': int(time.time())}
            self._write_cache(entries)
        return {'data': data, 'cached': False, 'cliVersion': version}

    def test(self, mode):
        """Is this connection usable? Never sends a model request."""
        detected = self.detect(mode)
        if not detected['installed']:
            return {'ok': False, 'stage': 'install', **detected, 'message': '未找到官方 Codex CLI，请安装后重新检测。'}
        if not detected['loggedIn']:
            hint = '请在终端运行 codex login，或选择“在 AI Bro 里单独登录”。' if mode == 'shared' else '请在这里登录 OpenAI 账号。'
            return {'ok': False, 'stage': 'login', **detected, 'message': 'Codex 尚未登录。' + hint}
        status = self.bridges(mode).status()
        if not status.get('available') or status.get('error'):
            return {'ok': False, 'stage': 'runtime', **detected, 'message': status.get('error') or '官方 Codex 运行时未能启动。'}
        if not status.get('authenticated'):
            return {'ok': False, 'stage': 'login', **detected, 'message': '登录状态不是 ChatGPT 账号（例如仅配置了 API Key），本连接需要 ChatGPT 账号登录。'}
        listing = self.models(mode, refresh=True)
        return {'ok': True, 'stage': 'ok', **detected, 'modelCount': len(listing['data']), 'message': f'可用 · Codex {detected["version"]} · {len(listing["data"])} 个模型'}
