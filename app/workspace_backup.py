"""Automatic workspace.sqlite3 backups, startup integrity check and recovery.

Backups are consistent copies made with VACUUM INTO under the SQLite
coordination lock, verified with PRAGMA integrity_check before they count.
Nothing here ever overwrites or deletes the live database: a database that
fails its check is moved aside into recovery/ before a verified backup is
copied into its place.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import time
import urllib.parse

BACKUP_DIRECTORY = 'backups'
DAILY_KEEP = 7                       # newest automatic backup of each of the last 7 days that have one
WEEKLY_KEEP = 4                      # plus the newest of each of the 4 most recent weeks before those
BACKUP_INTERVAL_SECONDS = 24 * 3600  # automatic backup when the newest one is older than this
SIZE_WARNING_BYTES = 500 * 1024 * 1024
FREE_SPACE_FACTOR = 2                # need this multiple of the database size free before VACUUM INTO
AUTOMATIC, PERMANENT = 'daily', 'pre-migration'
NAME = re.compile(r'^workspace-(\d{8})-(\d{6})-r(-?\d+)-(daily|pre-migration)\.sqlite3$')
SIDE_FILES = ('-wal', '-shm', '-journal')


LOG_LIMIT_BYTES = 256 * 1024
LOG_PATH = None                      # set by the server: <data>/backups/backup.log (native discards stderr)


def log(message):
    line = time.strftime('%Y-%m-%d %H:%M:%S') + f' {message}'
    print(f'[workspace-backup] {line}', file=sys.stderr, flush=True)
    if LOG_PATH is None: return
    try:
        path = Path(LOG_PATH)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > LOG_LIMIT_BYTES: os.replace(path, path.with_name(path.name + '.1'))
        with path.open('a', encoding='utf-8') as handle: handle.write(line + '\n')
    except OSError: pass


def backups(directory):
    """(path, created_at_seconds, kind) newest first; foreign files are ignored."""
    found = []
    folder = Path(directory)
    if not folder.is_dir(): return found
    for path in folder.iterdir():
        match = NAME.match(path.name)
        if not match or path.is_symlink() or not path.is_file(): continue
        created = time.mktime(time.strptime(match[1] + match[2], '%Y%m%d%H%M%S'))
        found.append((path, created, match[4]))
    return sorted(found, key=lambda item: (item[1], item[0].name), reverse=True)


def verify(path):
    try:
        connection = sqlite3.connect('file:' + urllib.parse.quote(str(path)) + '?mode=ro&immutable=1', uri=True)
        try: return connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        finally: connection.close()
    except sqlite3.DatabaseError: return False


@contextmanager
def coordination_lock(directory):
    """The SyncStore lock, without opening the database."""
    descriptor = os.open(Path(directory) / '.sqlite.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally: os.close(descriptor)


def create(store, kind=AUTOMATIC, now=None):
    """VACUUM INTO a new verified backup. Returns its path; raises on failure
    and leaves no partial file behind."""
    if kind not in (AUTOMATIC, PERMANENT): raise ValueError('unknown backup kind')
    source = store.sync.path
    if not source.exists(): raise FileNotFoundError('workspace database does not exist')
    folder = store.directory / BACKUP_DIRECTORY
    if folder.is_symlink(): raise ValueError('backup directory must not be a symbolic link')
    folder.mkdir(mode=0o700, exist_ok=True)
    needed = sum(source.with_name(source.name + suffix).stat().st_size for suffix in ('', '-wal') if source.with_name(source.name + suffix).exists())
    if shutil.disk_usage(folder).free < needed * FREE_SPACE_FACTOR:
        raise OSError('not enough free disk space for a workspace backup')
    now = time.time() if now is None else now
    partial = folder / f'.partial-{os.getpid()}-{time.time_ns()}.sqlite3'
    try:
        with store.sync.maintenance() as db:
            row = db.execute("SELECT json_extract(value,'$._revision') FROM meta WHERE key='snapshot'").fetchone()
            revision = row[0] if row and isinstance(row[0], int) else 0
            db.execute('VACUUM INTO ?', (str(partial),))
        if not verify(partial): raise sqlite3.DatabaseError('backup failed integrity_check')
        os.chmod(partial, 0o600)
        stamp = time.strftime('%Y%m%d-%H%M%S', time.localtime(now))
        destination = folder / f'workspace-{stamp}-r{revision}-{kind}.sqlite3'
        if destination.exists(): raise FileExistsError(destination.name)
        os.replace(partial, destination)
        return destination
    finally:
        if partial.exists(): partial.unlink()


def retained(entries, daily=DAILY_KEEP, weekly=WEEKLY_KEEP):
    """entries from backups(). Permanent backups are always kept."""
    keep, days, weeks = set(), [], []
    for path, created, kind in entries:
        if kind == PERMANENT: keep.add(path); continue
        day = time.strftime('%Y-%m-%d', time.localtime(created))
        if day in days: continue
        if len(days) < daily: days.append(day); keep.add(path); continue
        week = time.strftime('%G-W%V', time.localtime(created))
        if week in weeks or any(time.strftime('%G-W%V', time.strptime(d, '%Y-%m-%d')) == week for d in days): continue
        if len(weeks) < weekly: weeks.append(week); keep.add(path)
    return keep


def rotate(directory):
    """Remove automatic backups outside the retention rule; warn above the size limit."""
    entries = backups(directory)
    keep = retained(entries)
    removed = []
    for path, _, _ in entries:
        if path not in keep:
            path.unlink(); removed.append(path.name)
    total = sum(path.stat().st_size for path, _, _ in entries if path in keep)
    if total > SIZE_WARNING_BYTES:
        log(f'backups use {total / 1048576:.0f} MB, above the {SIZE_WARNING_BYTES / 1048576:.0f} MB guideline ({directory})')
    return removed, total


def automatic(store, now=None):
    """Create a daily backup when the newest backup of any kind is old enough
    (a fresh pre-migration copy already covers today)."""
    now = time.time() if now is None else now
    latest = next((created for _, created, _ in backups(store.directory / BACKUP_DIRECTORY)), None)
    if latest is not None and now - latest < BACKUP_INTERVAL_SECONDS: return None
    path = create(store, AUTOMATIC, now)
    rotate(store.directory / BACKUP_DIRECTORY)
    return path


def quick_check(path):
    try:
        connection = sqlite3.connect(path)
        try: rows = connection.execute('PRAGMA quick_check').fetchall()
        finally: connection.close()
        return [row[0] for row in rows] == ['ok'], '; '.join(str(row[0]) for row in rows[:5])
    except sqlite3.DatabaseError as error:
        return False, str(error)


def check_and_recover(store, now=None):
    """Startup self-check. On failure, keep the damaged files in recovery/ and
    restore the newest backup that passes integrity_check. Without one, the
    damaged database stays in place untouched and the failure is reported."""
    source = store.sync.path
    if not source.exists(): return {'status': 'missing'}
    with coordination_lock(store.directory):
        healthy, detail = quick_check(source)
        if healthy: return {'status': 'ok'}
        log(f'quick_check failed for {source}: {detail}')
        candidate = next((path for path, _, _ in backups(store.directory / BACKUP_DIRECTORY) if verify(path)), None)
        if candidate is None:
            log('no verified backup is available; the database was left in place')
            return {'status': 'corrupt', 'detail': detail}
        now = time.time() if now is None else now
        quarantine = store.directory / 'recovery' / ('corrupt-' + time.strftime('%Y%m%d-%H%M%S', time.localtime(now)) + f'-{time.time_ns()}')
        quarantine.mkdir(parents=True, mode=0o700)
        staged = source.with_name('.restore-' + candidate.name)
        shutil.copyfile(candidate, staged)
        for suffix in ('',) + SIDE_FILES:
            damaged = source.with_name(source.name + suffix)
            if damaged.exists(): os.replace(damaged, quarantine / damaged.name)
        os.replace(staged, source)
        os.chmod(source, 0o600)
        (quarantine / 'restore.json').write_text(json.dumps({'restoredFrom': candidate.name, 'detail': detail, 'at': int(now * 1000)}, ensure_ascii=False))
        log(f'restored {source.name} from {candidate.name}; damaged files kept in {quarantine}')
        return {'status': 'restored', 'backup': candidate.name, 'quarantine': str(quarantine), 'detail': detail}
