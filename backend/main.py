"""Yonder backend: a web terminal and file manager for many SSH servers at once.

Run:  python main.py            (serves the UI on http://127.0.0.1:8000)

  ssh.py      connections: one per server, shared by its tabs; host keys; logins
  terms.py    shells, which survive a page reload for a while
  files.py    the file manager: this computer and any connected server, copy jobs
  store.py    saved sessions and recent connections (~/.yonder/sessions.json)
  guard.py    keeps other websites out; webauth.py: an optional password
"""
from __future__ import annotations

import os as _os

# Yonder was called SSHDeck: its SSHDECK_* settings still work (YONDER_* wins when both are set).
for _k, _v in list(_os.environ.items()):
    if _k.startswith("SSHDECK_"):
        _os.environ.setdefault("YONDER_" + _k[len("SSHDECK_"):], _v)

import asyncio
import json
import logging
import os
import sys
import threading
import time
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import files
import forwards
import guard
import paths
import recording
import ssh
import store
import terms
import webauth

app = FastAPI(title="Yonder")
app.add_middleware(webauth.PasswordGate)
app.add_middleware(guard.OriginGuard)            # added last, so it runs first


@app.exception_handler(ssh.NeedInput)
async def _need(_req, e: ssh.NeedInput):
    return JSONResponse(status_code=409, content={"detail": e.info.get("message") or "Log in to the server again.", **e.info})


@app.exception_handler(ssh.SSHError)
async def _ssh_error(_req, e: ssh.SSHError):
    return JSONResponse(status_code=502, content={"detail": str(e)})


@app.exception_handler(files.FilesError)
async def _files_error(_req, e: files.FilesError):
    return JSONResponse(status_code=409, content={"detail": str(e)})


# ---------------------------------------------------------------- about, sign-in
@app.get("/api/about")
def about():
    return {"version": paths.VERSION, "python": sys.version.split()[0], "password": webauth.required(),
            "ssh_dir": str(ssh.SSH_DIR), "data_dir": str(store.HOME), "detached_ttl": terms.DETACHED_TTL,
            "recordings_dir": str(recording.folder()), "platform": sys.platform,
            "local_files": os.environ.get("YONDER_FILES_LOCAL") != "0"}


@app.get("/api/auth")
def auth_status(request: Request):
    return {"required": webauth.required(), "ok": webauth.valid(request.headers.get("cookie"))}


class LoginReq(BaseModel):
    password: str


@app.post("/api/login")
async def login(req: LoginReq):
    if not webauth.required():
        return {"ok": True}
    if not webauth.check_password(req.password):
        await asyncio.sleep(1)                 # slows down guessing
        raise HTTPException(401, "That's not the password.")
    r = JSONResponse({"ok": True})
    r.set_cookie(webauth.COOKIE, webauth.token(), httponly=True, samesite="strict", path="/")
    return r


@app.post("/api/logout")
def logout():
    r = JSONResponse({"ok": True})
    r.delete_cookie(webauth.COOKIE, path="/")
    return r


# ---------------------------------------------------------------- saved sessions
class SessionReq(BaseModel):
    name: str = ""
    folder: str = ""
    host: str
    port: int = 22
    user: str = ""
    key_file: str = ""
    remote_dir: str = ""
    color: str = ""
    vnc_host: str = ""
    vnc_port: int | None = None
    forwards: list[dict] = []


@app.get("/api/sessions")
def list_sessions():
    ss = store.sessions()
    return {"sessions": ss, "recent": store.recent(), "folders": sorted({s.get("folder", "") for s in ss} - {""}, key=str.lower)}


@app.post("/api/sessions")
def add_session(req: SessionReq):
    try:
        return store.save(req.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.put("/api/sessions/{sid}")
def update_session(sid: str, req: SessionReq):
    try:
        return store.save(req.model_dump(), sid)
    except KeyError:
        raise HTTPException(404, "That session no longer exists.")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/sessions/{sid}")
def delete_session(sid: str):
    store.delete(sid)
    return {"ok": True}


class FolderReq(BaseModel):
    old: str
    new: str


@app.post("/api/sessions/rename-folder")
def rename_folder(req: FolderReq):
    return {"moved": store.rename_folder(req.old, req.new)}


@app.delete("/api/recent")
def clear_recent():
    store.clear_recent()
    return {"ok": True}


@app.get("/api/settings")
def get_settings():
    return store.settings()


@app.put("/api/settings")
async def put_settings(request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "Settings are an object.")
    return store.save_settings(body)


@app.get("/api/keys")
def keys():
    """Your private keys in ~/.ssh, to pick one for a session."""
    return {"dir": str(ssh.SSH_DIR), "files": ssh.key_files()}


# ---------------------------------------------------------------- connecting
class ConnectReq(BaseModel):
    host: str
    port: int = 22
    user: str = ""
    key_file: str = ""
    name: str = ""
    session_id: str = ""
    password: str | None = None
    passphrase: str | None = None
    trust: str | None = None              # the host key fingerprint the user accepted
    install_key: bool = False


@app.post("/api/connect")
async def connect(req: ConnectReq):
    """Connect to a server, or check that we are. Returns {"ok": true, "server": {...}} or
    {"need": "hostkey" | "hostkey_changed" | "password" | "passphrase", ...} for the browser to ask."""
    try:
        t = ssh.Target.parse(req.model_dump())
    except ssh.SSHError as e:
        raise HTTPException(400, str(e))
    r = await asyncio.to_thread(ssh.connect, t, password=req.password, passphrase=req.passphrase,
                                trust_fp=req.trust, install=req.install_key)
    if r.get("ok"):
        store.add_recent({"host": t.host, "port": t.port, "user": t.user, "key_file": t.key_file, "name": t.name,
                          "session_id": req.session_id})
        sess = store.session(req.session_id) if req.session_id else None
        if sess and sess.get("forwards"):            # the session's port forwards start with it
            started, problems = [], []
            for f in sess["forwards"]:
                try:
                    fw = forwards.start(ssh.get(t.key), f.get("local_port", 0), f.get("host"), f["port"], f.get("label", ""))
                    started.append(fw.describe())
                except ssh.SSHError as e:
                    problems.append(str(e))
            r["forwards"] = started
            r.setdefault("notes", []).extend(problems)
    return r


@app.get("/api/servers")
def servers():
    return [s.describe() for s in ssh.SERVERS.values()]


class KeyReq(BaseModel):
    key: str


@app.post("/api/servers/disconnect")
def disconnect(req: KeyReq):
    """Close everything on that server (its terminals too) and forget its password."""
    terms.close_server(req.key)
    forwards.stop_server(req.key)
    files.forget(req.key)
    ssh.disconnect(req.key)
    return {"ok": True}


# ---------------------------------------------------------------- port forwarding
class ForwardReq(BaseModel):
    server: str
    local_port: int = 0                   # 0: any free port
    host: str = "localhost"               # as the server sees it
    port: int
    label: str = ""


@app.get("/api/forwards")
def list_forwards():
    return [f.describe() for f in forwards.FORWARDS.values()]


@app.post("/api/forwards")
def add_forward(req: ForwardReq):
    return forwards.start(ssh.get(req.server), req.local_port, req.host.strip(), req.port, req.label).describe()


@app.delete("/api/forwards/{fid}")
def stop_forward(fid: str):
    forwards.stop(fid)
    return {"ok": True}


# ---------------------------------------------------------------- VNC (a desktop in a tab)
@app.websocket("/api/vnc/ws")
async def vnc_ws(ws: WebSocket, server: str, port: int = 5900, host: str = "localhost"):
    """The VNC server's stream for noVNC in the browser, through the server's SSH connection:
    browser <-> WebSocket <-> Yonder <-> SSH direct-tcpip <-> host:port as the server sees it.
    So the VNC server can listen on the server's localhost only, and the traffic is encrypted."""
    proto = "binary" if "binary" in (ws.headers.get("sec-websocket-protocol") or "") else None
    await ws.accept(subprotocol=proto)
    try:
        chan = await asyncio.to_thread(lambda: ssh.get(server).tunnel(host or "localhost", port))
    except ssh.NeedInput:
        await ws.close(code=4409, reason="not connected")
        return
    except ssh.SSHError as e:
        await ws.close(code=4502, reason=str(e)[:120])
        return
    loop = asyncio.get_running_loop()
    done = threading.Event()

    def pump():                                  # VNC server -> browser
        try:
            while not done.is_set():
                data = chan.recv(65536)
                if not data:
                    break
                asyncio.run_coroutine_threadsafe(ws.send_bytes(data), loop).result(timeout=60)
        except Exception:  # noqa: BLE001
            pass
        finally:
            done.set()
            asyncio.run_coroutine_threadsafe(_close_quietly(ws), loop)

    threading.Thread(target=pump, daemon=True, name=f"vnc-{server}").start()
    try:
        while not done.is_set():
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is None and msg.get("text"):
                data = msg["text"].encode("latin-1", errors="ignore")
            if data:
                await asyncio.to_thread(chan.sendall, data)
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        done.set()
        chan.close()


async def _close_quietly(ws: WebSocket):
    try:
        await ws.close()
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- terminals
class TermReq(BaseModel):
    server: str
    cols: int = 80
    rows: int = 24
    cwd: str | None = None


@app.post("/api/terms")
async def open_term(req: TermReq):
    server = ssh.get(req.server)
    t = await asyncio.to_thread(terms.open_term, server, req.cols, req.rows, req.cwd)
    return t.describe()


@app.get("/api/terms")
def list_terms():
    return [t.describe() for t in terms.TERMS.values()]


@app.delete("/api/terms/{tid}")
def close_term(tid: str):
    t = terms.TERMS.get(tid)
    if t:
        t.close()
    return {"ok": True}


class RecordReq(BaseModel):
    format: str | None = None             # "cast", "log" or "both" (the default: Settings' choice)


@app.post("/api/terms/{tid}/record")
def start_record(tid: str, req: RecordReq):
    t = terms.TERMS.get(tid)
    if t is None:
        raise HTTPException(404, "That terminal session has ended.")
    try:
        return t.start_recording(terms._formats(req.format or store.settings().get("recordFormat")))
    except OSError as e:
        raise HTTPException(409, f"Couldn't start recording in {recording.folder()}: {e.strerror or e}")


@app.delete("/api/terms/{tid}/record")
def stop_record(tid: str):
    t = terms.TERMS.get(tid)
    return (t.stop_recording() if t else None) or {"files": []}


@app.get("/api/recordings")
def list_recordings():
    return {"folder": str(recording.folder()), "recordings": recording.listing(),
            "can_open_folder": _local_only()}


def _recording(name: str):
    try:
        p = recording.safe_path(name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not p.is_file():
        raise HTTPException(404, f"{name} no longer exists.")
    return p


@app.get("/api/recordings/{name}")
def get_recording(name: str, download: bool = False):
    from fastapi.responses import FileResponse
    p = _recording(name)
    media = "text/plain; charset=utf-8"
    return FileResponse(p, media_type=media, filename=name if download else None,
                        content_disposition_type="attachment" if download else "inline")


@app.delete("/api/recordings/{name}")
def delete_recording(name: str):
    _recording(name).unlink()
    return {"ok": True}


def _local_only() -> bool:
    return os.environ.get("YONDER_BIND", "127.0.0.1") in ("127.0.0.1", "localhost", "::1")


@app.post("/api/recordings/open-folder")
def open_recordings_folder():
    """Show the recordings folder in Explorer (Finder, the file manager): Yonder runs on this computer."""
    if not _local_only():
        raise HTTPException(400, "Yonder runs on another computer, so it can't open its folder on yours.")
    import subprocess
    d = str(recording.folder())
    try:
        if os.name == "nt":
            os.startfile(d)                    # noqa: S606 — the user's own folder, on their own computer
        elif sys.platform == "darwin":
            subprocess.Popen(["open", d])
        else:
            subprocess.Popen(["xdg-open", d], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as e:
        raise HTTPException(409, f"Couldn't open {d}: {e}")
    return {"ok": True, "folder": d}


@app.get("/api/notices")
def notices():
    """The third-party notices, for the About dialog."""
    try:
        return PlainTextResponse(paths.resource("THIRD-PARTY-NOTICES.md").read_text(encoding="utf-8"))
    except OSError:
        raise HTTPException(404, "The notices file isn't there.")


_DETACHED = object()


@app.websocket("/api/terms/{tid}/ws")
async def term_ws(ws: WebSocket, tid: str):
    """The terminal's screen: replays what it showed lately, then follows it live."""
    await ws.accept()
    t = terms.TERMS.get(tid)
    if t is None:
        await ws.send_text(json.dumps({"gone": True}))
        await ws.close()
        return
    loop = asyncio.get_running_loop()
    replay, q, old = await asyncio.to_thread(t.attach, loop)
    if old is not None:
        try:
            old.put_nowait(_DETACHED)
        except asyncio.QueueFull:
            pass
    if t.closed.is_set():
        q.put_nowait(terms._EXIT)

    async def sender():
        try:
            await ws.send_text(json.dumps({"attached": tid, "server": t.server.key,
                                           "recording": t.recorder.describe() if t.recorder else None}))
            if replay:
                await ws.send_bytes(replay)
            while True:
                item = await q.get()
                if item is terms._EXIT:
                    await ws.send_text(json.dumps({"exit": t.exit_status}))
                    await ws.close()
                    return
                if item is _DETACHED:
                    await ws.send_text(json.dumps({"detached": "elsewhere"}))
                    await ws.close()
                    return
                chunks = [item]                      # gather what's waiting into one frame
                size = len(item)
                while size < 65536 and not q.empty():
                    nxt = q.get_nowait()
                    if not isinstance(nxt, bytes):
                        q.put_nowait(nxt)            # handled on the next round
                        break
                    chunks.append(nxt)
                    size += len(nxt)
                await ws.send_bytes(b"".join(chunks))
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass

    task = asyncio.create_task(sender())
    try:
        while not task.done():
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                await asyncio.to_thread(t.write, msg["bytes"])
            elif msg.get("text"):
                ctl = json.loads(msg["text"])
                if "resize" in ctl:
                    cols, rows = ctl["resize"]
                    await asyncio.to_thread(t.resize, int(cols), int(rows))
    except (WebSocketDisconnect, RuntimeError, OSError, ValueError):
        pass
    finally:
        task.cancel()
        t.detach(q)


# ---------------------------------------------------------------- files (a WinSCP-like file manager)
def _fs(loc: str):
    return files.get(loc)


def _files_call(fn, *a):
    try:
        return fn(*a)
    except PermissionError as e:
        raise HTTPException(403, f"No permission: {e.filename or e}")
    except FileExistsError as e:
        raise HTTPException(409, f"{e.filename or 'It'} already exists.")
    except (files.FilesError, ssh.NeedInput, ssh.SSHError):
        raise
    except OSError as e:
        raise HTTPException(409, str(e))


@app.get("/api/files/places")
def files_places():
    """The locations to browse: this computer, and every connected server."""
    pc = files.LocalFS()
    return {"pc": {"label": pc.label(), "home": pc.home(), "windows": pc.windows,
                   "hidden": os.environ.get("YONDER_FILES_LOCAL") == "0"},
            "servers": [s.describe() for s in ssh.SERVERS.values()]}


@app.get("/api/files/list")
def files_list(loc: str, path: str = ""):
    fs = _fs(loc)

    def go():
        p = path or fs.home()
        real, entries = fs.list(p)
        return {"loc": loc, "path": real, "parent": fs.parent(real), "label": fs.label(),
                "entries": [e.as_dict() for e in sorted(entries, key=lambda e: (e.type != "dir", e.name.lower()))]}
    return _files_call(go)


class FilesPathReq(BaseModel):
    loc: str
    path: str


class FilesRenameReq(FilesPathReq):
    name: str


class FilesDeleteReq(BaseModel):
    loc: str
    dir: str
    names: list[str]


class FilesChmodReq(FilesDeleteReq):
    perm: int


class FilesCopyReq(BaseModel):
    src: str
    src_dir: str
    names: list[str]
    dst: str
    dst_dir: str
    move: bool = False
    overwrite: bool = False


class FilesTextReq(FilesPathReq):
    text: str
    encoding: str = "utf-8"
    mtime: float | None = None


def _safe_name(n: str) -> str:
    if not n or n in (".", "..") or "/" in n or "\\" in n or "\0" in n:
        raise HTTPException(400, f"{n!r} isn't a valid name.")
    return n


@app.post("/api/files/mkdir")
def files_mkdir(req: FilesPathReq):
    fs = _fs(req.loc)
    _files_call(fs.mkdir, req.path)
    return {"ok": True}


@app.post("/api/files/rename")
def files_rename(req: FilesRenameReq):
    fs = _fs(req.loc)
    parent = fs.parent(req.path)
    _files_call(fs.rename, req.path, fs.join(parent, _safe_name(req.name)))
    return {"ok": True}


@app.post("/api/files/delete")
def files_delete(req: FilesDeleteReq):
    fs = _fs(req.loc)
    for n in req.names:
        _files_call(fs.remove, fs.join(req.dir, _safe_name(n)))
    return {"deleted": len(req.names)}


@app.post("/api/files/chmod")
def files_chmod(req: FilesChmodReq):
    fs = _fs(req.loc)
    if not 0 <= req.perm <= 0o7777:
        raise HTTPException(400, "Permissions are 0000 to 7777.")
    for n in req.names:
        _files_call(fs.chmod, fs.join(req.dir, _safe_name(n)), req.perm)
    return {"ok": True}


@app.post("/api/files/exists")
def files_exists(req: FilesDeleteReq):
    """Which of these names already exist in a folder (to ask before overwriting)."""
    fs = _fs(req.loc)
    return {"exists": [n for n in req.names if _files_call(fs.stat, fs.join(req.dir, _safe_name(n)))]}


@app.post("/api/files/copy")
def files_copy(req: FilesCopyReq):
    src, dst = _fs(req.src), _fs(req.dst)
    names = [_safe_name(n) for n in req.names]
    if req.src == req.dst and req.src_dir.rstrip("/\\") == req.dst_dir.rstrip("/\\"):
        raise HTTPException(400, "Source and destination are the same folder.")
    if req.src == req.dst:
        for n in names:                        # a folder into itself would never end
            inside = src.join(req.src_dir, n).rstrip("/\\")
            if (req.dst_dir.rstrip("/\\") + "/").startswith(inside + "/") or \
                    (req.dst_dir.rstrip("/\\") + "\\").startswith(inside + "\\"):
                raise HTTPException(400, f"Can't copy or move {n} into itself.")
    job = files.start_copy(src, req.src_dir, names, dst, req.dst_dir, req.move, req.overwrite)
    return job.as_dict()


@app.get("/api/files/jobs")
def files_jobs():
    return sorted((j.as_dict() for j in files.JOBS.values()), key=lambda j: -j["started"])


@app.post("/api/files/jobs/{jid}/cancel")
def files_job_cancel(jid: str):
    j = files.JOBS.get(jid)
    if j:
        j.cancel = True
    return {"ok": True}


@app.get("/api/files/download")
def files_download(loc: str, dir: str, names: str):
    """One file as itself, or several (or a folder) as a .zip, made while it downloads."""
    fs = _fs(loc)
    ns = [_safe_name(n) for n in names.split("\n") if n]
    if not ns:
        raise HTTPException(400, "Nothing to download.")
    first = _files_call(fs.stat, fs.join(dir, ns[0]))
    if first is None:
        raise HTTPException(404, f"{ns[0]} doesn't exist.")
    if len(ns) == 1 and first.type == "file":
        fname, gen, headers = ns[0], files.file_stream(fs, fs.join(dir, ns[0])), {"Content-Length": str(first.size)}
    else:
        fname = (ns[0] if len(ns) == 1 else "files") + ".zip"
        gen, headers = files.zip_stream(fs, dir, ns), {}
    headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(fname)}"
    return StreamingResponse(gen, media_type="application/octet-stream", headers=headers)


@app.put("/api/files/upload")
async def files_upload(request: Request, loc: str, dir: str, rel: str):
    """One file from the browser (dropped from Explorer); `rel` may hold folders, made as needed."""
    fs = _fs(loc)
    parts = [_safe_name(p) for p in rel.replace("\\", "/").split("/") if p]
    if not parts:
        raise HTTPException(400, "No file name.")
    target_dir = fs.join(dir, *parts[:-1]) if len(parts) > 1 else dir
    if len(parts) > 1:
        await asyncio.to_thread(_files_call, fs.mkdir, target_dir)
    w = await asyncio.to_thread(_files_call, fs.open_write, fs.join(target_dir, parts[-1]))
    ok = False
    try:
        async for chunk in request.stream():
            await asyncio.to_thread(w.write, chunk)
        ok = True
    finally:
        await asyncio.to_thread(_files_call, w.close, ok)
    return {"ok": True}


@app.get("/api/files/text")
def files_text(loc: str, path: str):
    return _files_call(files.read_text, _fs(loc), path)


@app.put("/api/files/text")
def files_save_text(req: FilesTextReq):
    return _files_call(files.write_text, _fs(req.loc), req.path, req.text, req.encoding, req.mtime)


# ---------------------------------------------------------------- UI
STATIC_DIR = paths.STATIC_DIR
if STATIC_DIR.exists():
    @app.middleware("http")
    async def _fresh_ui(request, call_next):
        """The page itself is always checked again, so an updated Yonder shows at once; the files in
        /assets have their content's hash in their names, so those can be kept."""
        resp = await call_next(request)
        path = request.url.path
        if not path.startswith("/api"):
            resp.headers["Cache-Control"] = ("public, max-age=31536000, immutable" if path.startswith("/assets/")
                                             else "no-cache")
        return resp

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")
else:
    @app.get("/", response_class=PlainTextResponse)
    def no_ui():
        return "Yonder's web interface isn't built yet: cd frontend && npm install && npm run build"


def _debug_hooks():
    """kill -USR1 <pid> prints every thread's stack to the log (Linux/macOS): for a hang that's hard to catch."""
    import faulthandler
    import signal as _signal
    if hasattr(_signal, "SIGUSR1"):
        faulthandler.register(_signal.SIGUSR1, all_threads=True)


_debug_hooks()


def _background():
    threading.Thread(target=terms.reaper, daemon=True, name="term-reaper").start()
    threading.Thread(target=ssh.tidy_loop, daemon=True, name="ssh-tidy").start()


_background()


if __name__ == "__main__":
    import signal
    import uvicorn

    T0 = time.monotonic()
    host = os.environ.get("YONDER_BIND", "127.0.0.1")
    port = int(os.environ.get("YONDER_PORT", "8022"))
    print(f"Yonder {paths.VERSION}: Python {sys.version.split()[0]}; sessions in {store.FILE}", flush=True)
    if host not in ("127.0.0.1", "localhost", "::1") and not webauth.required():
        print(f"Yonder: WARNING: listening on {host} with no password. Anyone who can reach this computer could use "
              "your SSH connections. Set YONDER_PASSWORD.", flush=True)
    open_browser = os.environ.get("YONDER_OPEN_BROWSER", "1" if getattr(sys, "frozen", False) else "0") == "1"
    page = f"http://127.0.0.1:{port}/"
    if open_browser:
        import socket
        import urllib.request
        import webbrowser
        try:                                   # started a second time: just open the running one
            with urllib.request.urlopen(page + "api/auth", timeout=2) as r:
                if r.status in (200, 401):
                    print(f"Yonder is already running: opening {page}", flush=True)
                    webbrowser.open(page)
                    sys.exit(0)
        except OSError:
            pass

        def _open_when_up():
            for _ in range(100):
                try:
                    socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
                    print(f"Yonder: opening {page} in your browser. Keep this window open; Ctrl+C stops Yonder.", flush=True)
                    webbrowser.open(page)
                    return
                except OSError:
                    time.sleep(0.2)
        threading.Thread(target=_open_when_up, daemon=True).start()

    class Server(uvicorn.Server):
        def handle_exit(self, sig, frame):
            print(f"Yonder: received {signal.Signals(sig).name}; stopping.", flush=True)
            super().handle_exit(sig, frame)

    try:
        config = uvicorn.Config(app, host=host, port=port, timeout_graceful_shutdown=3, ws_ping_interval=20)
        logging.getLogger("uvicorn.error").addFilter(
            lambda r: not (r.exc_info and isinstance(r.exc_info[1], asyncio.CancelledError)))
        Server(config).run()
    except KeyboardInterrupt:
        pass
    finally:
        # Worker threads may still wait on a server that's gone; everything is saved, so leave right away.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)
