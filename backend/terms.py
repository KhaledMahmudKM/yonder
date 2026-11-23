"""Terminal sessions: an interactive shell on a server, which outlives the browser tab's WebSocket.

A shell keeps running when its WebSocket closes (the page was reloaded, the laptop slept,
the network dropped), for DETACHED_TTL seconds. Its recent output is kept (the last
BUFFER bytes), so the tab that reattaches gets the screen back as it was.

The WebSocket protocol is DockerLab's: binary frames are terminal bytes both ways; text
frames are JSON. Browser to server: {"resize": [cols, rows]}. Server to browser:
{"error": "..."}, {"exit": status}, {"detached": "elsewhere"} (another tab took it over).
"""
from __future__ import annotations

import asyncio
import os
import shlex
import threading
import time
import uuid

import paramiko

import recording
import ssh
import store

BUFFER = 256 * 1024
DETACHED_TTL = int(os.environ.get("YONDER_DETACHED_TTL", "600"))
_EXIT = object()


class Term:
    def __init__(self, server: ssh.Server, cols: int, rows: int, cwd: str | None = None):
        self.id = uuid.uuid4().hex[:12]
        self.server = server
        self.created = time.time()
        self.detached_at: float | None = time.time()
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.queue: asyncio.Queue | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.exit_status: int | None = None
        self.closed = threading.Event()
        self.cols, self.rows = cols, rows
        self.recorder: recording.Recorder | None = None
        self.rec_lock = threading.Lock()
        tr, self._release = server.acquire()
        try:
            self.chan = tr.open_session(timeout=15)
            self.chan.get_pty(term="xterm-256color", width=cols, height=rows)
            if cwd:          # "Open a terminal here" from the file browser: the login shell, started in that folder
                self.chan.exec_command(f'cd {shlex.quote(cwd)} ; exec "$SHELL" -l')
            else:
                self.chan.invoke_shell()
        except (paramiko.SSHException, OSError, EOFError) as e:
            self._release()
            msg = str(e) or type(e).__name__
            if "Connect failed" in msg or "ChannelException" in type(e).__name__:
                msg = "the server refused another session on this connection"
            raise ssh.SSHError(f"Couldn't open a shell on {server.target.label}: {msg}.")
        threading.Thread(target=self._pump, daemon=True, name=f"term-{self.id}").start()

    # ---- server -> browser
    def _pump(self):
        try:
            while True:
                data = self.chan.recv(32768)
                if not data:
                    break
                if self.recorder is not None:
                    with self.rec_lock:
                        if self.recorder is not None:
                            try:
                                self.recorder.output(data)
                            except OSError:           # disk full, folder gone: stop recording, keep the shell
                                self.recorder.close()
                                self.recorder = None
                with self.lock:
                    self.buf += data
                    if len(self.buf) > BUFFER:
                        del self.buf[:len(self.buf) - BUFFER]
                    q, loop = self.queue, self.loop
                if q is not None:
                    try:      # waits while the browser is behind: backpressure on the SSH channel
                        asyncio.run_coroutine_threadsafe(q.put(data), loop).result(timeout=30)
                    except Exception:  # noqa: BLE001 — the browser went away; keep buffering
                        self._drop(q)
        except (OSError, EOFError, paramiko.SSHException):
            pass
        finally:
            try:
                self.exit_status = self.chan.recv_exit_status() if self.chan.exit_status_ready() else None
            except Exception:  # noqa: BLE001
                pass
            self.close()

    def _drop(self, q):
        with self.lock:
            if self.queue is q:
                self.queue = self.loop = None
                self.detached_at = time.time()

    def attach(self, loop) -> tuple[bytes, asyncio.Queue, asyncio.Queue | None]:
        """Take the terminal over: returns (what it showed lately, the new queue, the queue of the
        WebSocket it was attached to before, if any, to tell that one it lost it)."""
        q = asyncio.Queue(maxsize=64)
        with self.lock:
            old = self.queue
            self.queue, self.loop, self.detached_at = q, loop, None
            return bytes(self.buf), q, old

    def detach(self, q):
        self._drop(q)

    # ---- browser -> server
    def write(self, data: bytes):
        self.chan.sendall(data)

    def resize(self, cols: int, rows: int):
        if 0 < cols < 1000 and 0 < rows < 1000 and (cols, rows) != (self.cols, self.rows):
            self.cols, self.rows = cols, rows
            self.chan.resize_pty(width=cols, height=rows)
            with self.rec_lock:
                if self.recorder is not None:
                    self.recorder.resize(cols, rows)

    # ---- recording
    def start_recording(self, formats=recording.FORMATS) -> dict:
        with self.rec_lock:
            if self.recorder is None:
                t = self.server.target
                title = f"{t.name} ({t.user}@{t.host})" if t.name else t.label
                self.recorder = recording.Recorder(title, t.label, self.cols, self.rows, formats)
            return self.recorder.describe()

    def stop_recording(self) -> dict | None:
        with self.rec_lock:
            r, self.recorder = self.recorder, None
        if r is None:
            return None
        r.close()
        return r.describe()

    def close(self):
        if self.closed.is_set():
            return
        self.closed.set()
        self.stop_recording()
        try:
            self.chan.close()
        except Exception:  # noqa: BLE001
            pass
        self._release()
        with self.lock:
            q, loop = self.queue, self.loop
        if q is not None:
            try:
                asyncio.run_coroutine_threadsafe(q.put(_EXIT), loop)
            except Exception:  # noqa: BLE001
                pass
        TERMS.pop(self.id, None)

    def describe(self):
        r = self.recorder
        return {"id": self.id, "server": self.server.key, "label": self.server.target.label, "created": self.created,
                "attached": self.queue is not None, "recording": r.describe() if r else None}


TERMS: dict[str, Term] = {}


def open_term(server: ssh.Server, cols=80, rows=24, cwd=None) -> Term:
    t = Term(server, cols, rows, cwd)
    TERMS[t.id] = t
    s = store.settings()
    if s.get("autoRecord"):                          # Settings: record every terminal
        try:
            t.start_recording(_formats(s.get("recordFormat")))
        except OSError:
            pass
    return t


def close_server(key: str):
    for t in [t for t in TERMS.values() if t.server.key == key]:
        t.close()


def reaper():
    """Close shells left detached for longer than DETACHED_TTL."""
    while True:
        time.sleep(15)
        now = time.time()
        for t in list(TERMS.values()):
            if t.detached_at and now - t.detached_at > DETACHED_TTL:
                t.close()


def _formats(choice) -> tuple:
    return {"cast": ("cast",), "log": ("log",)}.get(choice or "both", recording.FORMATS)
