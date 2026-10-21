#!/usr/bin/env python3
"""原生应用冷启动基线：启动到主窗口出现、后端可用、内存占用（物理占用）。

内存取两个值：启动后前 PEAK_WINDOW 秒内反复取样的峰值，和启动后第 SETTLE 秒的稳定值。
启动后十几秒内原生内存会大幅波动，固定在第 15 秒取一次会落在波动里，数值不可比。

用法：python3 scripts/measure-native-startup.py <AI Bro.app 路径> [次数=3]

隔离数据目录：设置 AIBRO_DATA_DIR=<绝对路径> 时，用 `open --env AIBRO_NATIVE_DATA_DIR=...`
启动，不碰真实数据目录（应用需支持该环境变量）；再设 AIBRO_DATA_TEMPLATE=<目录> 时，
每轮开始前把模板重新复制成数据目录（测首次启动/迁移路径），否则沿用同一份。

每轮先退出同一 bundle id 的实例，再 `open` 启动并计时；结果取中位数，
同时写一份 JSON 到 test-results/perf-startup/。会用到本机真实数据目录
（与平常打开应用一样），不发模型请求。窗口检测依赖 cua-driver（需辅助功能权限）。
"""
import json, os, re, pathlib, shutil, statistics, subprocess, sys, time, urllib.request

BUNDLE_ID = 'app.ai-workstation.studio'
CUA = os.environ.get('CUA_DRIVER', str(pathlib.Path.home() / '.local/bin/cua-driver'))
ROOT = pathlib.Path(__file__).resolve().parent.parent
PEAK_WINDOW = 30  # 秒，从 open 开始计
SETTLE = 60  # 秒，从 open 开始计


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def app_pids(app, part='Contents/MacOS/'):
    return [int(p) for p in sh('pgrep', '-f', str(pathlib.Path(app) / part)).split()]


# Wait for every process of the bundle, the backend included: a backend left
# over from the previous run would otherwise be picked up as this run's.
def quit_app(app):
    for pid in app_pids(app):
        subprocess.run(['kill', '-TERM', str(pid)])
    deadline = time.time() + 15
    while app_pids(app, 'Contents/') and time.time() < deadline:
        time.sleep(0.2)
    if app_pids(app, 'Contents/'):
        raise SystemExit('上一轮实例未能退出，停止测量。')


def main_window(pid):
    try:
        windows = json.loads(sh(CUA, 'call', 'list_windows', json.dumps({'pid': pid})))['windows']
    except (ValueError, KeyError):
        return False
    return any(w.get('title') and w['bounds']['width'] >= 600 for w in windows)


def server_port(app):
    for child in map(str, app_pids(app, 'Contents/Resources/app/server.py')):
        for line in sh('lsof', '-nP', '-a', '-p', child, '-iTCP', '-sTCP:LISTEN').splitlines()[1:]:
            return int(line.rsplit(':', 1)[1].split()[0]), int(child)
    return None, None


def healthy(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/__health', timeout=1) as response:
            return response.status == 200
    except OSError:
        return False


# Physical footprint (what Activity Monitor shows as Memory); RSS undercounts
# compressed pages. WebKit content processes are separate and not included.
def footprint_mb(pid):
    match = re.search(r'Footprint: ([\d.]+) (KB|MB|GB)', sh('footprint', '-p', str(pid)))
    if not match:
        return None
    return round(float(match[1]) * {'KB': 1 / 1024, 'MB': 1, 'GB': 1024}[match[2]], 1)


def one_run(app):
    quit_app(app)
    data_dir, template = os.environ.get('AIBRO_DATA_DIR'), os.environ.get('AIBRO_DATA_TEMPLATE')
    if data_dir and not data_dir.startswith('/'):
        raise SystemExit('AIBRO_DATA_DIR 必须是绝对路径。')
    if data_dir and template:
        if 'noindex' not in data_dir:
            raise SystemExit('AIBRO_DATA_DIR 与模板同用时，路径需含 noindex，防止误删。')
        shutil.rmtree(data_dir, ignore_errors=True)
        shutil.copytree(template, data_dir)
    start = time.time()
    subprocess.run(['open', *(['--env', f'AIBRO_NATIVE_DATA_DIR={data_dir}'] if data_dir else []), app], check=True)
    pid = window_at = health_at = port = server_pid = None
    while time.time() - start < 60 and not (window_at and health_at):
        pids = app_pids(app)
        pid = pid or (pids[0] if pids else None)
        if pid and not window_at and main_window(pid):
            window_at = time.time() - start
        if pid and not port:
            port, server_pid = server_port(app)
        if port and not health_at and healthy(port):
            health_at = time.time() - start
        time.sleep(0.1)
    peak_native = peak_server = None
    while pid and time.time() - start < PEAK_WINDOW:
        native, server = footprint_mb(pid), footprint_mb(server_pid) if server_pid else None
        peak_native = max(filter(None, (peak_native, native)), default=None)
        peak_server = max(filter(None, (peak_server, server)), default=None)
        time.sleep(0.5)
    time.sleep(max(0, SETTLE - (time.time() - start)))
    alive = bool(app_pids(app))
    return {
        'window_s': round(window_at, 2) if window_at else None,
        'server_ready_s': round(health_at, 2) if health_at else None,
        'native_mb': footprint_mb(pid) if pid else None,
        'server_mb': footprint_mb(server_pid) if server_pid else None,
        'native_peak_mb': peak_native,
        'server_peak_mb': peak_server,
        f'alive_after_{SETTLE}s': alive,
    }


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    app = str(pathlib.Path(sys.argv[1]).resolve())
    runs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    results = []
    for index in range(runs):
        result = one_run(app)
        results.append(result)
        print(f'#{index + 1}', json.dumps(result, ensure_ascii=False))
    quit_app(app)
    def median(key):
        values = [r[key] for r in results if r[key] is not None]
        return round(statistics.median(values), 2) if values else None
    summary = {key: median(key) for key in ('window_s', 'server_ready_s', 'native_mb', 'server_mb', 'native_peak_mb', 'server_peak_mb')}
    info = json.loads(sh('plutil', '-convert', 'json', '-o', '-', f'{app}/Contents/Info.plist') or '{}')
    report = {
        'app': app, 'version': info.get('CFBundleShortVersionString'), 'build': info.get('CFBundleVersion'),
        'measured_at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'machine': sh('sysctl', '-n', 'machdep.cpu.brand_string').strip(),
        'peak_window_s': PEAK_WINDOW, 'settle_s': SETTLE, 'median': summary, 'runs': results,
    }
    out = ROOT / 'test-results' / 'perf-startup'
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{time.strftime('%Y%m%d-%H%M%S')}-{report['version']}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print('median', json.dumps(summary, ensure_ascii=False))
    print('saved', path)


if __name__ == '__main__':
    main()
