"""One protected cloud-session file and directory-inode lock shared with Swift.

No credential encryption or second session store lives here. Lock order is the
CloudSync instance lock (if held), this directory flock, then native vault locks.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import secrets
import stat
import threading


class SessionFile:
    LIMIT = 65536

    def __init__(self, directory, error):
        self.directory = Path(directory)
        self.error = error
        self._thread = threading.local()
        self._lock = threading.RLock()
        if self.directory.is_symlink(): self._fail()
        fd = None
        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            if os.fstat(fd).st_uid != os.getuid(): self._fail()
            os.fchmod(fd, 0o700)
        except OSError: self._fail()
        finally:
            if fd is not None: os.close(fd)

    def _fail(self):
        raise self.error('云端会话存储不可安全访问。', 'UNSAFE_SESSION_PATH', 503) from None

    @contextmanager
    def locked(self):
        with self._lock:
            existing = getattr(self._thread, 'fd', None)
            if existing is not None:
                yield existing
                return
            fd = None
            try:
                fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                info = os.fstat(fd)
                if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700: self._fail()
                fcntl.flock(fd, fcntl.LOCK_EX)
            except OSError:
                if fd is not None: os.close(fd)
                self._fail()
            except BaseException:
                if fd is not None: os.close(fd)
                raise
            try:
                self._thread.fd = fd
                # Caller errors keep their type (e.g. SSH adoption rollback).
                # Only this helper's filesystem checks classify unsafe paths.
                yield fd
            finally:
                self._thread.fd = None
                if fd is not None:
                    try: fcntl.flock(fd, fcntl.LOCK_UN)
                    finally: os.close(fd)

    def read(self):
        with self.locked() as directory:
            try: fd = os.open('cloud-session.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
            except FileNotFoundError: return None
            except OSError: self._fail()
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > self.LIMIT): self._fail()
                with os.fdopen(fd, 'rb', closefd=False) as stream: raw = stream.read(self.LIMIT + 1)
                if len(raw) > self.LIMIT: self._fail()
                value = json.loads(raw)
                if type(value) is not dict: self._fail()
                return value
            except (ValueError, UnicodeError, RecursionError):
                raise self.error('云端会话无法读取，请重新登录。', 'INVALID_SESSION') from None
            finally: os.close(fd)

    def write(self, value):
        try: raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
        except (ValueError, TypeError, UnicodeError, RecursionError): self._fail()
        if len(raw) > self.LIMIT: self._fail()
        with self.locked() as directory:
            self.read()  # Reject insecure or linked destinations before mutation.
            name = '.session-' + secrets.token_hex(16)
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as out:
                    out.write(raw); out.flush(); os.fsync(fd)
                os.rename(name, 'cloud-session.json', src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            finally:
                os.close(fd)
                try: os.unlink(name, dir_fd=directory)
                except FileNotFoundError: pass

    def clear(self):
        with self.locked() as directory:
            self.read()
            try: os.unlink('cloud-session.json', dir_fd=directory)
            except FileNotFoundError: return
            os.fsync(directory)
