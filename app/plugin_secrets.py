"""Environment secrets of external plugins, kept in the macOS keychain (never in plugins.json).

plugins.json stores only the variable names. A value is written through
``security -i`` (commands on stdin) so it never appears in a process argument
list, and is read back only when the plugin's server is about to start; the
server gets it as an environment variable and nothing else does.
"""
import subprocess, sys

SERVICE = 'app.ai-workstation.studio.plugin-env'


class SecretError(Exception):
    pass


class MemorySecrets:
    """In-process store for tests and for systems without a keychain."""
    def __init__(self): self.values = {}
    def set(self, plugin_id, name, value): self.values[(plugin_id, name)] = value
    def get(self, plugin_id, name): return self.values.get((plugin_id, name))
    def delete(self, plugin_id, name): self.values.pop((plugin_id, name), None)


class KeychainSecrets:
    def __init__(self, service=SERVICE): self.service = service

    @staticmethod
    def _quote(text):
        if any(ch in text for ch in '\n\r\0'): raise SecretError('密钥里不能有换行。')
        return '"' + text.replace('\\', '\\\\').replace('"', '\\"') + '"'

    def set(self, plugin_id, name, value):
        script = f'add-generic-password -U -s {self._quote(self.service)} -a {self._quote(plugin_id + ":" + name)} -w {self._quote(value)}\n'
        result = subprocess.run(['/usr/bin/security', '-i'], input=script.encode(), capture_output=True, timeout=20)
        if result.returncode != 0 or b'error' in result.stderr.lower(): raise SecretError('无法写入钥匙串。')

    def get(self, plugin_id, name):
        result = subprocess.run(['/usr/bin/security', 'find-generic-password', '-s', self.service, '-a', f'{plugin_id}:{name}', '-w'], capture_output=True, timeout=20)
        return result.stdout.decode('utf-8', 'replace').rstrip('\n') if result.returncode == 0 else None

    def delete(self, plugin_id, name):
        subprocess.run(['/usr/bin/security', 'delete-generic-password', '-s', self.service, '-a', f'{plugin_id}:{name}'], capture_output=True, timeout=20)


def default_secrets():
    return KeychainSecrets() if sys.platform == 'darwin' else MemorySecrets()
