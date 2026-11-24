"""Today briefs: ``<data>/today/briefs/YYYY-MM-DD.json``, one per local day.

The main window assembles a brief (TodayDigest, and optionally the AI text) and
keeps it here, so the native today page and later windows read the same one.
The brief holds titles and times from the person's own agenda and tasks; it is
device-local (not part of the workspace snapshot) and never holds credentials.
"""
import json, os, re, tempfile, threading, time
from datetime import date
from pathlib import Path

DAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')
MAX_BYTES = 64 * 1024


class TodayStore:
    def __init__(self, directory, clock=time.time):
        self.directory = Path(directory) / 'today' / 'briefs'
        self.clock = clock
        self._lock = threading.Lock()

    @staticmethod
    def _day(value):
        if not isinstance(value, str) or not DAY.match(value): raise ValueError('日期应为 YYYY-MM-DD')
        try: date.fromisoformat(value)
        except ValueError: raise ValueError('日期无效')
        return value

    def _path(self, day):
        path = self.directory / (self._day(day) + '.json')
        if path.is_symlink(): raise ValueError('简报文件不能是符号链接')
        return path

    def read(self, day):
        path = self._path(day)
        if not path.exists(): return None
        try: return json.loads(path.read_text())
        except (OSError, ValueError): return None

    def write(self, day, brief):
        if not isinstance(brief, dict): raise ValueError('简报必须是 JSON 对象')
        raw = json.dumps({**brief, 'date': self._day(day), 'savedAt': self.clock()}, ensure_ascii=False).encode()
        if len(raw) > MAX_BYTES: raise ValueError('简报太大')
        path = self._path(day)
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix='.write-', dir=path.parent)
            try:
                with os.fdopen(descriptor, 'wb') as handle: handle.write(raw); handle.flush(); os.fsync(handle.fileno())
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
        return json.loads(raw)

