"""Plugin import: turn text, a plugin folder's files or another app's config into candidate MCP servers.

Pure parsing, nothing runs and nothing is installed. A candidate is
``{name, transport, env, status, ...}``; ``status`` says what is needed before
it can be tested:

- ``ready``         an absolute, executable local file or a loopback address
- ``needs_install`` a package runner (npx, uvx, ...): AI Bro never downloads
                    code, so the candidate carries an install command to copy
- ``needs_path``    a bare or relative command (``node``, ``./server``): the
                    user must give the full path of the installed program
- ``unsupported``   remote servers and anything else AI Bro does not run

Environment values stay on the server side (``env`` holds name → value for the
later add step); ``public`` strips them to names for the interface.
"""
import json, os, re, shlex, sqlite3, tempfile, urllib.parse
from pathlib import Path

from mcp_plugins import LOOPBACK, REFUSED_COMMANDS, McpError, validate_transport

MAX_SERVERS = 50
MAX_TEXT = 512 * 1024
ENV_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,63}$')
PLUGIN_ROOT = re.compile(r'\$\{?CLAUDE_PLUGIN_ROOT\}?')
RUNNERS = {'npx': 'npm', 'bunx': 'bun', 'pnpx': 'pnpm', 'uvx': 'uv', 'pipx': 'pipx'}
FOLDER_KINDS = ('skills', 'commands', 'agents', 'hooks')


def _runner(command):
    return os.path.basename(str(command)).lower()


def install_command(command, args):
    """The command a user would run in their own terminal to install the package a runner would fetch."""
    runner = _runner(command)
    words = [a for a in args if isinstance(a, str)]
    package = next((a for a in words if not a.startswith('-')), None)
    if runner in ('npx', 'bunx', 'pnpx') and package: return 'npm install -g ' + shlex.quote(package)
    if runner == 'uvx' and package: return 'uv tool install ' + shlex.quote(package)
    if runner == 'pipx' and words[:1] == ['run'] and len(words) > 1: return 'pipx install ' + shlex.quote(words[1])
    return ' '.join(shlex.quote(w) for w in [str(command), *words])


WRAPPERS = frozenset({'env', 'sudo'})


def unwrap(command, args):
    """Look through ``env npx pkg`` style wrappers to the program that is really being run."""
    command, args = str(command or ''), list(args or [])
    while _runner(command) in WRAPPERS and args:
        skip = 0
        while skip < len(args) and (args[skip].startswith('-') or '=' in args[skip]): skip += 1
        if skip >= len(args): break
        command, args = args[skip], args[skip + 1:]
    return command, args


def classify(name, command=None, args=None, url=None, env=None):
    """One candidate from raw fields; never raises."""
    args = [a for a in (args or []) if isinstance(a, str)][:32]
    env = {k: v for k, v in (env or {}).items() if isinstance(k, str) and ENV_NAME.match(k) and isinstance(v, (str, int, float))} if isinstance(env, dict) else {}
    env = {k: str(v) for k, v in list(env.items())[:32]}
    clean = re.sub(r'\s+', ' ', str(name or '')).strip()[:40] or '外部插件'
    out = {'name': clean, 'env': env, 'warnings': []}
    if url is not None and not command:
        try: out['transport'] = validate_transport({'kind': 'http', 'url': url})
        except McpError:
            out.update(transport={'kind': 'http', 'url': str(url)[:300]}, status='unsupported',
                       reason='只支持本机回环地址（127.0.0.1 / localhost）上的服务器，不连接远程服务。')
            return out
        out['status'] = 'ready'; return out
    if not isinstance(command, str) or not command.strip():
        out.update(transport={'kind': 'stdio', 'command': '', 'args': []}, status='unsupported', reason='没有找到启动命令。'); return out
    command = command.strip()
    out['transport'] = {'kind': 'stdio', 'command': command[:1024], 'args': args}
    if PLUGIN_ROOT.search(' '.join([command, *args])):
        out.update(status='needs_path', reason='命令引用了插件文件夹的位置，请填写这个程序在本机的完整路径。'); return out
    if _runner(command) in REFUSED_COMMANDS or any(_runner(a) in RUNNERS for a in args[:2]):
        out.update(status='needs_install', installCommand=install_command(*unwrap(command, args)),
                   reason=f'“{_runner(unwrap(command, args)[0])}”会在运行时下载并执行软件包，AI Bro 不这样做。请先在终端里装好，再填写它的可执行文件路径。')
        return out
    if not command.startswith('/'):
        out.update(status='needs_path', reason='请填写这个程序的完整路径（以 / 开头）。'); return out
    try: out['transport'] = validate_transport(out['transport'])
    except McpError as error:
        status = 'needs_install' if error.code == 'mcp_installer_refused' else 'needs_path'
        out.update(status=status, reason=str(error))
        if status == 'needs_install': out['installCommand'] = install_command(*unwrap(command, args))
        return out
    out['status'] = 'ready'; return out


def _from_server_config(name, config):
    if not isinstance(config, dict): return None
    kind = str(config.get('type') or config.get('transport') or '').lower()
    url = config.get('url') or config.get('httpUrl')
    if isinstance(url, str) and not config.get('command'):
        item = classify(name, url=url, env=config.get('env'))
        if kind in ('sse', 'ws', 'websocket') and item['status'] == 'ready':
            item.update(status='unsupported', reason='只支持 HTTP 形式的本机服务器（不支持 SSE / WebSocket）。')
        return item
    args = config.get('args')
    return classify(name, command=config.get('command'), args=args if isinstance(args, list) else [], env=config.get('env'))


def _servers_from_object(value):
    """{"mcpServers": {...}} / {"servers": {...}} / a single server object / a map of servers."""
    if not isinstance(value, dict): return []
    for key in ('mcpServers', 'servers', 'mcp_servers'):
        if isinstance(value.get(key), dict): return [s for s in (_from_server_config(n, c) for n, c in list(value[key].items())[:MAX_SERVERS]) if s]
    if 'command' in value or 'url' in value:
        item = _from_server_config(value.get('name') or _guess_name(value.get('command') or value.get('url')), value)
        return [item] if item else []
    if value and all(isinstance(v, dict) and ('command' in v or 'url' in v) for v in value.values()):
        return [s for s in (_from_server_config(n, c) for n, c in list(value.items())[:MAX_SERVERS]) if s]
    return []


def _guess_name(target):
    text = str(target or '')
    if text.startswith(('http://', 'https://')):
        return urllib.parse.urlsplit(text).hostname or 'mcp'
    return re.sub(r'(\.py|\.js|\.sh)$', '', os.path.basename(text.rstrip('/'))) or 'mcp'


def _parse_claude_mcp_add(words):
    """claude mcp add [-s scope] [-t transport] [-e K=V ...] [-H header] <name> (-- <command> [args...] | <url>)"""
    rest, env, transport = words[3:], {}, None
    positional, command = [], None
    i = 0
    while i < len(rest):
        word = rest[i]
        if word == '--': command = rest[i + 1:]; break
        if word in ('-e', '--env') and i + 1 < len(rest):
            i += 1
            while i < len(rest) and '=' in rest[i] and not rest[i].startswith('-'):
                key, _, val = rest[i].partition('='); env[key] = val; i += 1
            continue
        if word in ('-s', '--scope', '-t', '--transport', '-H', '--header') and i + 1 < len(rest):
            if word in ('-t', '--transport'): transport = rest[i + 1].lower()
            i += 2; continue
        if word.startswith('--transport='): transport = word.split('=', 1)[1].lower()
        elif not word.startswith('-'): positional.append(word)
        i += 1
    if not positional: return []
    name = positional[0]
    if command: return [classify(name, command=command[0], args=command[1:], env=env)]
    if len(positional) > 1 and positional[1].startswith(('http://', 'https://')):
        item = classify(name, url=positional[1], env=env)
        if transport == 'sse' and item['status'] == 'ready': item.update(status='unsupported', reason='只支持 HTTP 形式的本机服务器（不支持 SSE）。')
        return [item]
    if len(positional) > 1: return [classify(name, command=positional[1], args=positional[2:], env=env)]
    return []


def parse_text(text):
    """Pasted text: JSON of any common shape, a ``claude mcp add`` line, a URL or a command line."""
    text = str(text or '').strip()
    if not text: return []
    if len(text) > MAX_TEXT: raise McpError('粘贴的内容太长。')
    if text[0] in '{[':
        try: value = json.loads(text)
        except ValueError:
            # A fragment such as `"zotero": {...}` copied out of a larger file.
            try: value = json.loads('{' + text.strip().rstrip(',') + '}')
            except ValueError: raise McpError('这段 JSON 无法解析，请检查括号和引号。')
        found = _servers_from_object(value) if isinstance(value, dict) else [s for v in value if isinstance(v, dict) for s in _servers_from_object(v)]
        return found[:MAX_SERVERS]
    if re.match(r'^\s*"[^"]+"\s*:\s*\{', text):
        try: return _servers_from_object(json.loads('{' + text.strip().rstrip(',') + '}'))[:MAX_SERVERS]
        except ValueError: raise McpError('这段 JSON 无法解析，请检查括号和引号。')
    try: words = shlex.split(text)
    except ValueError: raise McpError('命令里的引号没有配对。')
    if not words: return []
    if words[:3] == ['claude', 'mcp', 'add']: return _parse_claude_mcp_add(words)
    if words[0].startswith(('http://', 'https://')): return [classify(_guess_name(words[0]), url=words[0])]
    real, rest = unwrap(words[0], words[1:])
    package = next((a for a in rest if not a.startswith('-')), None) if _runner(real) in RUNNERS else None
    return [classify(_guess_name(package or real), command=words[0], args=words[1:])]


def parse_app_config(text):
    """Another app's config file (Claude Desktop, ``~/.claude.json``, Cursor, …): only its ``mcpServers`` are read."""
    text = str(text or '')
    if len(text) > 8 * 1024 * 1024: raise McpError('这个配置文件太大。')
    try: value = json.loads(text)
    except ValueError: raise McpError('这个文件不是有效的 JSON 配置。')
    if not isinstance(value, dict): return []
    found = _servers_from_object(value)
    seen = {s['name'] for s in found}
    # ~/.claude.json keeps per-project servers under projects.<path>.mcpServers.
    projects = value.get('projects') if isinstance(value.get('projects'), dict) else {}
    for project in list(projects.values())[:200]:
        if isinstance(project, dict) and isinstance(project.get('mcpServers'), dict):
            for item in _servers_from_object({'mcpServers': project['mcpServers']}):
                if item['name'] not in seen: seen.add(item['name']); found.append(item)
    return found[:MAX_SERVERS]


def _ccswitch_servers(path, immutable=True):
    try:
        connection = sqlite3.connect(f'file:{path}?mode=ro' + ('&immutable=1' if immutable else ''), uri=True)
        try:
            connection.execute('PRAGMA query_only = ON')
            rows = connection.execute('SELECT id, name, server_config FROM mcp_servers ORDER BY name LIMIT ?', (MAX_SERVERS,)).fetchall()
        finally: connection.close()
    except sqlite3.Error: raise McpError('这个数据库里没有找到 MCP 服务器列表。')
    found = []
    for row_id, name, config in rows:
        try: value = json.loads(config)
        except (TypeError, ValueError): continue
        item = _from_server_config(name or row_id, value)
        if item: found.append(item)
    return found


def parse_ccswitch_db(data):
    """CC Switch's database (``mcp_servers`` table). Opened read-only from a private copy of the bytes the user picked."""
    if not isinstance(data, (bytes, bytearray)) or not data.startswith(b'SQLite format 3\0'): raise McpError('这不是 SQLite 数据库文件。')
    with tempfile.TemporaryDirectory(prefix='aibro-import-') as directory:
        path = Path(directory) / 'import.db'
        path.write_bytes(bytes(data)); path.chmod(0o600)
        return _ccswitch_servers(path)


def parse_ccswitch_default():
    """The MCP table of the default CC Switch database (~/.cc-switch/cc-switch.db). Called only when the user asks; read from a private copy."""
    import ccswitch_import
    with tempfile.TemporaryDirectory(prefix='aibro-import-') as directory:
        os.chmod(directory, 0o700)
        try: copy = ccswitch_import.snapshot_default(directory)
        except ccswitch_import.ImportError_ as error: raise McpError(str(error))
        if copy is None: raise McpError('没有在默认位置找到 CC Switch 的数据库（' + str(ccswitch_import.default_db_path()) + '）。可以用“选择文件”指定它的位置。')
        return _ccswitch_servers(copy, immutable=False)


def _folder_json(files, path):
    text = files.get(path)
    if not isinstance(text, str): return None
    try: value = json.loads(text)
    except ValueError: return None
    return value if isinstance(value, dict) else None


def parse_folder(files):
    """A plugin folder (``.claude-plugin/plugin.json`` layout) given as {relative path: text or None}.

    Reads the manifest and ``.mcp.json``; skills, commands, agents and hooks are
    only counted. Nothing in the folder is executed or copied.
    """
    if not isinstance(files, dict) or len(files) > 5000: raise McpError('文件夹内容无效。')
    names = [str(p).replace('\\', '/') for p in files if isinstance(p, str)]
    # webkitdirectory paths start with the picked folder's own name; strip it.
    root = ''
    manifests = sorted((n for n in names if n == '.claude-plugin/plugin.json' or n.endswith('/.claude-plugin/plugin.json')), key=len)
    if not manifests: raise McpError(f'这个文件夹里没有 .claude-plugin/plugin.json，不像是一个插件（读到 {len(names)} 个文件）。')
    root = manifests[0][:-len('.claude-plugin/plugin.json')]
    rel = {n[len(root):]: files.get(n) for n in names if n.startswith(root)}
    manifest = _folder_json(rel, '.claude-plugin/plugin.json')
    if manifest is None: raise McpError('plugin.json 无法解析。')
    counts = {kind: 0 for kind in FOLDER_KINDS}
    skill_names = []
    for name in rel:
        top = name.split('/', 1)[0]
        if top == 'skills' and name.endswith('/SKILL.md'): counts['skills'] += 1; skill_names.append(name.split('/')[1][:60])
        elif top in ('commands', 'agents') and name.endswith('.md') and name.count('/') >= 1: counts[top] += 1
        elif top == 'hooks' and name.endswith('.json'): counts['hooks'] += 1
    if _folder_json(rel, 'hooks/hooks.json') is not None and not counts['hooks']: counts['hooks'] = 1
    servers = []
    mcp = _folder_json(rel, '.mcp.json')
    if mcp is not None: servers = _servers_from_object(mcp if any(k in mcp for k in ('mcpServers', 'servers')) else {'mcpServers': mcp})
    inline = manifest.get('mcpServers')
    if isinstance(inline, dict): servers += _servers_from_object({'mcpServers': inline})
    name = re.sub(r'\s+', ' ', str(manifest.get('name') or 'plugin')).strip()[:40] or 'plugin'
    return {'plugin': {'name': name, 'version': str(manifest.get('version') or '')[:40], 'description': str(manifest.get('description') or '')[:300],
                       'counts': counts, 'skills': skill_names[:20]}, 'servers': servers[:MAX_SERVERS]}


FORBIDDEN_SEGMENTS = frozenset({'.ssh', '.aws', '.gnupg', 'Keychains', '.kube', '.docker'})


def read_folder_path(path):
    """A plugin folder the user typed or pasted by path: only names are listed and only the manifest, ``.mcp.json`` and
    ``hooks/hooks.json`` are read. ``${CLAUDE_PLUGIN_ROOT}`` becomes the folder's real path."""
    if not isinstance(path, str) or not path.startswith('/') or len(path) > 1024 or '\0' in path: raise McpError('请填写文件夹的完整路径（以 / 开头）。')
    try: root = Path(path).resolve(strict=True)
    except (OSError, RuntimeError): raise McpError('找不到这个文件夹。')
    if not root.is_dir(): raise McpError('这不是一个文件夹。')
    if FORBIDDEN_SEGMENTS & set(root.parts): raise McpError('这个位置存放凭据，AI Bro 不读取。')
    files, escaped = {}, json.dumps(str(root))[1:-1]
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in ('node_modules', '.git') and not Path(directory, d).is_symlink())[:200]
        if Path(directory).relative_to(root).parts.__len__() >= 4: dirs[:] = []
        for name in sorted(names):
            full = Path(directory, name); rel = full.relative_to(root).as_posix()
            if len(files) >= 3000: break
            wanted = rel in ('.claude-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json')
            text = None
            if wanted and full.is_file() and not full.is_symlink() and full.stat().st_size < 262144:
                try: text = full.read_text(encoding='utf-8').replace('${CLAUDE_PLUGIN_ROOT}', escaped).replace('$CLAUDE_PLUGIN_ROOT', escaped)
                except (OSError, UnicodeDecodeError): text = None
            files[root.name + '/' + rel] = text
    return files


def public(candidate, index):
    """What the interface may see: no environment values."""
    out = {k: v for k, v in candidate.items() if k != 'env'}
    out['index'] = index; out['env'] = sorted(candidate.get('env', {}))
    return out
