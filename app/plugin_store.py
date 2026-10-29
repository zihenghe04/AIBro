"""Device-local plugin settings: ``<data>/plugins/plugins.json``.

Built-in plugins are only switched on or off here; external MCP plugins (see
``mcp_plugins.py``) keep their manifest and tool snapshot here too. Nothing in
this file is part of the workspace snapshot, so it never syncs to other
devices. Changes apply to the next agent run (each run freezes its toolset).
"""
import json, os, re, tempfile, threading, time
from pathlib import Path
from web_search import settings_entry as _websearch_entry

BUILTIN_PLUGINS = ('browser', 'websearch')
VERSION = 1
# A site permission is per origin: scheme, host and an optional port, nothing else.
ORIGIN = re.compile(r'^https?://(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::[0-9]{1,5})?$|^https?://\[[0-9a-f:]+\](?::[0-9]{1,5})?$')
MAX_SITES = 500


def _browser_entry(value):
    entry = {'enabled': value.get('enabled') is not False}
    sites = value.get('sites') if isinstance(value.get('sites'), dict) else {}
    lists = {key: [o for o in sites.get(key, []) if isinstance(o, str) and ORIGIN.match(o)][:MAX_SITES] for key in ('allow', 'deny')}
    if lists['allow'] or lists['deny']: entry['sites'] = lists
    if value.get('unknownSites') == 'ask': entry['unknownSites'] = 'ask'
    return entry


class PluginStoreError(Exception):
    def __init__(self, message, status=400, code='plugin_invalid'):
        super().__init__(message); self.status = status; self.code = code
    @property
    def payload(self): return {'error': str(self), 'code': self.code}


class PluginStore:
    def __init__(self, data_dir):
        self.root = Path(data_dir) / 'plugins'
        self.path = self.root / 'plugins.json'
        self._lock = threading.RLock()

    def lock(self): return self._lock

    def data_dir(self, plugin_id):
        """Each external plugin's own working directory (its cwd and HOME)."""
        path = self.root / 'data' / plugin_id
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        return path

    def _empty(self): return {'version': VERSION, 'builtin': {}, 'mcp': []}

    def read(self):
        with self._lock:
            try: value = json.loads(self.path.read_text(encoding='utf-8'))
            except FileNotFoundError: return self._empty()
            except (OSError, ValueError):
                # Keep an unreadable file for inspection; start from defaults.
                try: self.path.replace(self.path.with_name(f'plugins.unreadable-{int(time.time())}.json'))
                except OSError: pass
                return self._empty()
            if not isinstance(value, dict): return self._empty()
            builtin = value.get('builtin') if isinstance(value.get('builtin'), dict) else {}
            mcp = value.get('mcp') if isinstance(value.get('mcp'), list) else []
            return {'version': VERSION,
                    'builtin': {k: _browser_entry(v) if k == 'browser' else _websearch_entry(v) if k == 'websearch' else {'enabled': v.get('enabled') is not False} for k, v in builtin.items() if k in BUILTIN_PLUGINS and isinstance(v, dict)},
                    'mcp': [entry for entry in mcp if isinstance(entry, dict) and isinstance(entry.get('id'), str)]}

    def write(self, value):
        with self._lock:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix='.plugins-', suffix='.json', dir=self.root)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                    json.dump(value, handle, ensure_ascii=False, indent=1); handle.flush(); os.fsync(handle.fileno())
                os.chmod(tmp, 0o600); os.replace(tmp, self.path)
            except BaseException:
                try: os.unlink(tmp)
                except OSError: pass
                raise

    def set_builtin(self, plugin_id, enabled):
        if plugin_id not in BUILTIN_PLUGINS: raise PluginStoreError('没有这个内置插件。', 404, 'plugin_unknown')
        if not isinstance(enabled, bool): raise PluginStoreError('enabled 必须是 true 或 false。')
        with self._lock:
            value = self.read(); value['builtin'][plugin_id] = {**value['builtin'].get(plugin_id, {}), 'enabled': enabled}; self.write(value)
            return value

    def browser_site(self, origin, decision):
        """Device-local site lists of the browser plugin: allow, deny or remove an origin."""
        if not isinstance(origin, str) or not ORIGIN.match(origin): raise PluginStoreError('网站地址无效（只接受 http/https 的协议加主机名）。')
        if decision not in ('allow', 'deny', 'remove'): raise PluginStoreError('网站许可只能是 allow、deny 或 remove。')
        with self._lock:
            value = self.read(); entry = value['builtin'].setdefault('browser', {'enabled': True})
            sites = entry.setdefault('sites', {'allow': [], 'deny': []})
            for key in ('allow', 'deny'): sites[key] = [o for o in sites.get(key, []) if o != origin]
            if decision != 'remove':
                if len(sites[decision]) >= MAX_SITES: raise PluginStoreError('网站名单已满（最多 500 个）。')
                sites[decision].append(origin)
            self.write(value); return value

    def browser_settings(self, unknown_sites):
        if unknown_sites not in ('auto', 'ask'): raise PluginStoreError('未知网站只能是 auto 或 ask。')
        with self._lock:
            value = self.read(); entry = value['builtin'].setdefault('browser', {'enabled': True})
            if unknown_sites == 'ask': entry['unknownSites'] = 'ask'
            else: entry.pop('unknownSites', None)
            self.write(value); return value
