"""Files: browse and copy files between this computer and any connected server (from DockerLab).

Two kinds of location, one interface:
  pc          the computer Yonder runs on (normally your own PC): the local file system
  s:<key>     a connected server (user@host:port), over SFTP on that server's SSH connection

Copies run as jobs in a thread, with progress, so the browser can show it and cancel them.
Any two locations work, including two different servers (the data passes through Yonder).
"""
from __future__ import annotations

import io
import os
import posixpath
import queue
import shutil
import socket
import stat as st
import string
import threading
import time
import uuid
import zipfile
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field

import paramiko

import ssh

CHUNK = 256 * 1024


class FilesError(Exception):
    pass


@dataclass
class Entry:
    name: str
    type: str            # dir | file (links to folders are "dir" with link=True)
    size: int = 0
    mtime: float = 0
    mode: str = ""       # e.g. "rwxr-xr-x"
    link: bool = False
    perm: int = 0        # the permission bits, e.g. 0o755
    owner: str = ""

    def as_dict(self):
        return {"name": self.name, "type": self.type, "size": self.size, "mtime": self.mtime, "mode": self.mode,
                "link": self.link, "perm": self.perm, "owner": self.owner}


def _perm(mode: int) -> str:
    return st.filemode(mode)[1:] if mode else ""


# ======================================================================= this computer
class LocalFS:
    kind = "pc"
    windows = os.name == "nt"

    def label(self):
        return f"This computer ({socket.gethostname()})"

    def home(self):
        return os.path.expanduser("~")

    def norm(self, path: str) -> str:
        if not path:
            return "" if self.windows else "/"
        return os.path.abspath(os.path.expanduser(path))

    def join(self, d, *names):
        return os.path.join(d, *names) if d else os.path.join(*names)

    def parent(self, path):
        if not path or (self.windows and len(path) <= 3 and path[1:2] == ":"):
            return "" if self.windows and path else None
        p = os.path.dirname(path.rstrip("\\/")) or "/"
        return p if p != path else None

    def list(self, path):
        path = self.norm(path)
        if self.windows and path == "":       # "This computer": its drives
            drives = [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
            return path, [Entry(d, "dir") for d in drives]
        out = []
        try:
            with os.scandir(path) as it:
                for e in it:
                    try:
                        s = e.stat(follow_symlinks=True)
                        isdir = st.S_ISDIR(s.st_mode)
                        out.append(Entry(e.name, "dir" if isdir else "file", 0 if isdir else s.st_size, s.st_mtime,
                                         _perm(s.st_mode), e.is_symlink(), st.S_IMODE(s.st_mode)))
                    except OSError:
                        out.append(Entry(e.name, "file", link=e.is_symlink()))
        except FileNotFoundError:
            raise FilesError(f"{path} doesn't exist.")
        except NotADirectoryError:
            raise FilesError(f"{path} isn't a folder.")
        except PermissionError:
            raise FilesError(f"No permission to open {path}.")
        return path, out

    def stat(self, path):
        try:
            s = os.stat(path)
        except (FileNotFoundError, NotADirectoryError):
            return None
        return Entry(os.path.basename(path.rstrip("\\/")), "dir" if st.S_ISDIR(s.st_mode) else "file", s.st_size, s.st_mtime,
                     _perm(s.st_mode), perm=st.S_IMODE(s.st_mode))

    def session(self):
        return nullcontext(None)

    def open_read(self, path, sess=None):
        return open(path, "rb")

    def open_write(self, path, size=None, mtime=None, sess=None):
        return _LocalWriter(path, mtime)

    def mkdir(self, path):
        os.makedirs(path, exist_ok=True)

    def remove(self, path):
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        else:
            os.remove(path)

    def rename(self, path, new_path):
        if os.path.exists(new_path):
            raise FilesError(f"{os.path.basename(new_path)} already exists.")
        os.rename(path, new_path)

    def chmod(self, path, perm: int):
        os.chmod(path, perm)


class _LocalWriter:
    def __init__(self, path, mtime):
        self.path, self.mtime = path, mtime
        try:
            self.f = open(path, "wb")
        except PermissionError:
            raise FilesError(f"No permission to write {path}.")
        except IsADirectoryError:
            raise FilesError(f"{path} is a folder.")

    def write(self, b):
        self.f.write(b)

    def close(self, ok=True):
        self.f.close()
        if ok and self.mtime:
            os.utime(self.path, (self.mtime, self.mtime))


# ======================================================================= a server (SFTP)
class _Browse:
    """One SFTP session per server for browsing, kept open between requests."""
    lock = threading.RLock()                     # guards the dicts
    locks: dict[str, threading.RLock] = {}       # one per server: its browsing requests go one at a time
    sessions: dict[str, tuple[paramiko.SFTPClient, callable, paramiko.Transport]] = {}

    @classmethod
    def lock_for(cls, key: str) -> threading.RLock:
        with cls.lock:
            return cls.locks.setdefault(key, threading.RLock())

    @classmethod
    def get(cls, server: ssh.Server) -> paramiko.SFTPClient:
        with cls.lock_for(server.key):
            cur = cls.sessions.get(server.key)
            if cur and cur[2].is_active() and not cur[0].sock.closed:
                return cur[0]
            cls.drop(server.key)
            tr, release = server.acquire()
            try:
                sftp = paramiko.SFTPClient.from_transport(tr)
            except (paramiko.SSHException, OSError, EOFError) as e:
                release()
                raise FilesError(f"Couldn't start SFTP on {server.target.label}: {e or type(e).__name__}. "
                                 "Is the SFTP subsystem enabled on the server?")
            cls.sessions[server.key] = (sftp, release, tr)
            return sftp

    @classmethod
    def drop(cls, key: str):
        with cls.lock:
            cur = cls.sessions.pop(key, None)
        if cur:
            try:
                cur[0].close()
            except Exception:  # noqa: BLE001
                pass
            cur[1]()


class SftpFS:
    kind = "server"

    def __init__(self, server: ssh.Server):
        self.server = server
        self.where = server.target.label

    def label(self):
        return self.where

    def _call(self, fn, *a):
        lock = _Browse.lock_for(self.server.key)
        try:
            with lock:
                return fn(_Browse.get(self.server), *a)
        except (EOFError, paramiko.SSHException, OSError) as e:
            if isinstance(e, (FileNotFoundError, PermissionError)) or getattr(e, "errno", None) in (2, 13, 17, 20, 21, 39):
                raise
            _Browse.drop(self.server.key)       # dropped connection: one retry on a new one
            with lock:
                return fn(_Browse.get(self.server), *a)

    def home(self):
        return self._call(lambda s: s.normalize("."))

    def norm(self, path):
        try:
            return self._call(lambda s, p: s.normalize(p), path or ".")
        except FileNotFoundError:
            raise FilesError(f"{path} doesn't exist on {self.where}.")

    def join(self, d, *names):
        return posixpath.join(d, *names)

    def parent(self, path):
        return None if path == "/" else (posixpath.dirname(path.rstrip("/")) or "/")

    def list(self, path):
        path = self.norm(path)
        try:
            attrs = self._call(lambda s, p: s.listdir_attr(p), path)
        except FileNotFoundError:
            raise FilesError(f"{path} doesn't exist on {self.where}.")
        except PermissionError:
            raise FilesError(f"No permission to open {path} on {self.where}.")
        out = []
        for a in attrs:
            mode = a.st_mode or 0
            link = st.S_ISLNK(mode)
            if link:
                try:
                    mode = self._call(lambda s, p: s.stat(p), posixpath.join(path, a.filename)).st_mode
                except OSError:
                    pass
            isdir = st.S_ISDIR(mode)
            owner = ""
            ln = getattr(a, "longname", "") or ""
            parts = ln.split()
            if len(parts) >= 4:
                owner = f"{parts[2]}:{parts[3]}"
            out.append(Entry(a.filename, "dir" if isdir else "file", 0 if isdir else (a.st_size or 0), a.st_mtime or 0,
                             _perm(mode), link, st.S_IMODE(mode), owner))
        return path, out

    def stat(self, path):
        try:
            a = self._call(lambda s, p: s.stat(p), path)
        except FileNotFoundError:
            return None
        return Entry(posixpath.basename(path), "dir" if st.S_ISDIR(a.st_mode) else "file", a.st_size or 0, a.st_mtime or 0,
                     _perm(a.st_mode or 0), perm=st.S_IMODE(a.st_mode or 0))

    @contextmanager
    def session(self):
        """An SFTP session of its own, for one copy job, so a long transfer doesn't hold up browsing."""
        with self.server.slot() as tr:
            s = paramiko.SFTPClient.from_transport(tr)
            try:
                yield s
            finally:
                s.close()

    def open_read(self, path, sess=None):
        try:
            f = (sess or _Browse.get(self.server)).open(path, "rb")
        except PermissionError:
            raise FilesError(f"No permission to read {path} on {self.where}.")
        f.prefetch()
        return f

    def open_write(self, path, size=None, mtime=None, sess=None):
        return _SftpWriter(sess or _Browse.get(self.server), path, mtime, self.where)

    def mkdir(self, path):
        def mk(s, p):
            parts, cur = p.strip("/").split("/"), ""
            for part in parts:
                cur += "/" + part
                try:
                    s.stat(cur)
                except FileNotFoundError:
                    s.mkdir(cur)
        try:
            self._call(mk, path)
        except PermissionError:
            raise FilesError(f"No permission to make {path} on {self.where}.")

    def remove(self, path):
        def rm(s, p):
            a = s.lstat(p)
            if st.S_ISDIR(a.st_mode):
                for c in s.listdir(p):
                    rm(s, posixpath.join(p, c))
                s.rmdir(p)
            else:
                s.remove(p)
        if path in ("/", ""):
            raise FilesError("Refusing to delete /.")
        try:
            self._call(rm, path)
        except PermissionError:
            raise FilesError(f"No permission to delete {path} on {self.where}.")

    def rename(self, path, new_path):
        if self.stat(new_path):
            raise FilesError(f"{posixpath.basename(new_path)} already exists.")
        try:
            self._call(lambda s, a, b: s.posix_rename(a, b), path, new_path)
        except (IOError, paramiko.SSHException):
            self._call(lambda s, a, b: s.rename(a, b), path, new_path)      # servers without posix-rename

    def chmod(self, path, perm: int):
        try:
            self._call(lambda s, p, m: s.chmod(p, m), path, perm)
        except PermissionError:
            raise FilesError(f"No permission to change {path} on {self.where} (only its owner can).")


class _SftpWriter:
    def __init__(self, sftp, path, mtime, where):
        self.sftp, self.path, self.mtime = sftp, path, mtime
        try:
            self.f = sftp.open(path, "wb")
        except PermissionError:
            raise FilesError(f"No permission to write {path} on {where}.")
        self.f.set_pipelined(True)

    def write(self, b):
        self.f.write(b)

    def close(self, ok=True):
        self.f.close()
        if ok and self.mtime:
            try:
                self.sftp.utime(self.path, (self.mtime, self.mtime))
            except OSError:
                pass


# ======================================================================= locations
def get(loc: str) -> LocalFS | SftpFS:
    if loc == "pc":
        if os.environ.get("YONDER_FILES_LOCAL") == "0":
            raise FilesError("Browsing this computer's files is turned off (YONDER_FILES_LOCAL=0).")
        return LocalFS()
    if loc.startswith("s:"):
        return SftpFS(ssh.get(loc[2:]))
    raise FilesError(f"Unknown location {loc}.")


def forget(key: str):
    _Browse.drop(key)


# ======================================================================= copy jobs
@dataclass
class Job:
    id: str
    label: str
    total_bytes: int = 0
    done_bytes: int = 0
    files_total: int = 0
    files_done: int = 0
    current: str = ""
    state: str = "running"          # running | done | failed | cancelled
    errors: list = field(default_factory=list)
    started: float = field(default_factory=time.time)
    finished: float = 0
    cancel: bool = False

    def as_dict(self):
        d = {k: v for k, v in self.__dict__.items() if k != "cancel"}
        d["errors"] = self.errors[:20]
        return d


JOBS: dict[str, Job] = {}


def _walk(fs, path, rel):
    """(relative path, Entry) for path and everything under it."""
    e = fs.stat(path)
    if e is None:
        raise FilesError(f"{path} no longer exists.")
    yield rel, e
    if e.type == "dir":
        _, entries = fs.list(path)
        for c in sorted(entries, key=lambda x: x.name):
            yield from _walk(fs, fs.join(path, c.name), rel + "/" + c.name)


def start_copy(src, src_dir, names, dst, dst_dir, move=False, overwrite=False):
    job = Job(uuid.uuid4().hex[:10], f"{'Moving' if move else 'Copying'} {len(names)} item{'s' if len(names) != 1 else ''} to {dst.label()}")
    JOBS[job.id] = job
    for old in [j for j in JOBS.values() if j.state != "running" and time.time() - j.finished > 3600]:
        JOBS.pop(old.id, None)
    threading.Thread(target=_run_copy, args=(job, src, src_dir, names, dst, dst_dir, move, overwrite), daemon=True).start()
    return job


def _same_place(src, dst):
    return (isinstance(src, LocalFS) and isinstance(dst, LocalFS)) or \
        (isinstance(src, SftpFS) and isinstance(dst, SftpFS) and src.server is dst.server)


def _run_copy(job, src, src_dir, names, dst, dst_dir, move, overwrite):
    try:
        # A move within one place is a rename: instant, and nothing to copy
        if move and _same_place(src, dst):
            for n in names:
                if job.cancel:
                    job.state = "cancelled"
                    return
                job.current = n
                target = dst.join(dst_dir, n)
                try:
                    if dst.stat(target):
                        if not overwrite:
                            job.errors.append(f"{n}: already there, skipped")
                            continue
                        dst.remove(target)
                    src.rename(src.join(src_dir, n), target)
                    job.files_done += 1
                except (FilesError, OSError) as ex:
                    job.errors.append(f"{n}: {ex}")
            job.files_total = len(names)
            job.state = "done" if all("skipped" in x for x in job.errors) else "failed"
            return
        # Unix permissions go along (like WinSCP's "preserve rights"), except to or from Windows
        keep_mode = not (isinstance(src, LocalFS) and src.windows) and not (isinstance(dst, LocalFS) and dst.windows)

        def set_mode(path, perm):
            if keep_mode and perm:
                try:
                    dst.chmod(path, perm)
                except (FilesError, OSError):
                    pass

        with src.session() as s_sess, dst.session() as d_sess:
            plan = []
            for n in names:
                for rel, e in _walk(src, src.join(src_dir, n), n):
                    plan.append((rel, e))
            job.files_total = sum(1 for _, e in plan if e.type == "file")
            job.total_bytes = sum(e.size for _, e in plan if e.type == "file")
            for rel, e in plan:
                if job.cancel:
                    job.state = "cancelled"
                    return
                target = dst.join(dst_dir, *rel.split("/"))
                source = src.join(src_dir, *rel.split("/"))
                job.current = rel
                try:
                    if e.type == "dir":
                        if dst.stat(target) is None:          # a new folder gets the source's rights; an existing one keeps its own
                            dst.mkdir(target)
                            set_mode(target, e.perm)
                        continue
                    if not overwrite and dst.stat(target):
                        job.errors.append(f"{rel}: already there, skipped")
                        job.done_bytes += e.size
                        job.files_done += 1
                        continue
                    r = src.open_read(source, sess=s_sess)
                    w = dst.open_write(target, e.size, e.mtime, sess=d_sess)
                    ok = False
                    try:
                        while True:
                            if job.cancel:
                                break
                            b = r.read(CHUNK)
                            if not b:
                                ok = True
                                break
                            w.write(b)
                            job.done_bytes += len(b)
                    finally:
                        r.close()
                        w.close(ok)
                    if not ok:
                        job.state = "cancelled"
                        return
                    set_mode(target, e.perm)
                    job.files_done += 1
                except (FilesError, OSError, IOError) as ex:
                    job.errors.append(f"{rel}: {ex}")
        if move and not [x for x in job.errors if "skipped" not in x]:
            for n in names:
                src.remove(src.join(src_dir, n))
        job.state = "done" if all("skipped" in x for x in job.errors) else "failed"
    except ssh.NeedInput as ex:
        job.errors.append(ex.info.get("message") or "The server needs you to log in again.")
        job.state = "failed"
    except Exception as ex:  # noqa: BLE001
        job.errors.append(str(ex) or type(ex).__name__)
        job.state = "failed"
    finally:
        job.current = ""
        job.finished = time.time()


# ======================================================================= downloads (to the browser)
def zip_stream(fs, base_dir, names):
    """A .zip of files and folders, produced while it's sent."""
    q: queue.Queue = queue.Queue(maxsize=16)

    class W(io.RawIOBase):
        def writable(self):
            return True

        def write(self, b):
            q.put(bytes(b))
            return len(b)

    def produce():
        try:
            with fs.session() as sess, zipfile.ZipFile(W(), "w", zipfile.ZIP_DEFLATED) as z:
                for n in names:
                    for rel, e in _walk(fs, fs.join(base_dir, n), n):
                        src = fs.join(base_dir, *rel.split("/"))
                        if e.type == "dir":
                            z.writestr(rel + "/", b"")
                            continue
                        zi = zipfile.ZipInfo(rel, time.localtime(e.mtime or time.time())[:6])
                        zi.compress_type = zipfile.ZIP_DEFLATED
                        r = fs.open_read(src, sess=sess)
                        try:
                            with z.open(zi, "w", force_zip64=True) as out:
                                while b := r.read(CHUNK):
                                    out.write(b)
                        finally:
                            r.close()
        except Exception as e:  # noqa: BLE001
            q.put(e)
        q.put(None)

    threading.Thread(target=produce, daemon=True).start()
    while True:
        b = q.get()
        if b is None:
            return
        if isinstance(b, Exception):
            raise b
        yield b


def file_stream(fs, path):
    with fs.session() as sess:
        r = fs.open_read(path, sess=sess)
        try:
            while b := r.read(CHUNK):
                yield b
        finally:
            r.close()


# ======================================================================= small text files (the editor)
MAX_EDIT = 2 * 1024 * 1024


def read_text(fs, path) -> dict:
    e = fs.stat(path)
    if e is None:
        raise FilesError(f"{path} doesn't exist.")
    if e.type != "file":
        raise FilesError(f"{path} isn't a file.")
    if e.size > MAX_EDIT:
        raise FilesError(f"{path} is {e.size // 1048576} MB: too big to edit here (the limit is 2 MB). Download it instead.")
    r = fs.open_read(path)
    try:
        data = r.read()
    finally:
        r.close()
    if b"\0" in data[:8192]:
        raise FilesError(f"{path} looks like a binary file, not text.")
    try:
        text, enc = data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        text, enc = data.decode("latin-1"), "latin-1"
    return {"text": text, "encoding": enc, "mtime": e.mtime, "size": e.size, "crlf": b"\r\n" in data}


def write_text(fs, path, text: str, encoding: str = "utf-8", expect_mtime: float | None = None) -> dict:
    e = fs.stat(path)
    if expect_mtime and e and abs(e.mtime - expect_mtime) > 1:
        raise FilesError(f"{posixpath.basename(path)} changed on the server since you opened it. "
                         "Reopen it to see the new version (your text is still in the editor: copy it first).")
    w = fs.open_write(path)
    ok = False
    try:
        w.write(text.encode(encoding, errors="replace"))
        ok = True
    finally:
        w.close(ok)
    if e and e.perm and isinstance(fs, SftpFS):
        try:                                   # sftp open("wb") keeps the mode of an existing file; be sure
            fs.chmod(path, e.perm)
        except FilesError:
            pass
    n = fs.stat(path)
    return {"mtime": n.mtime if n else 0}
