"""Saved sessions and recent connections, in ~/.yonder/sessions.json.

A session is a server to connect to: name, folder, address, port, user, and optionally a
key file and the folder the file browser opens in. Passwords and passphrases are never
saved; they're asked when needed and kept in memory only while connected (see ssh.py).
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

HOME = Path(os.environ.get("YONDER_HOME", Path.home() / ".yonder"))
_OLD_HOME = Path.home() / ".sshdeck"                  # Yonder was called SSHDeck
if "YONDER_HOME" not in os.environ and not HOME.exists() and _OLD_HOME.is_dir():
    import shutil
    try:                                               # copy, so the old folder stays as a backup
        shutil.copytree(_OLD_HOME, HOME)
    except OSError:
        pass
FILE = HOME / "sessions.json"
FIELDS = ("name", "folder", "host", "port", "user", "key_file", "remote_dir", "color", "vnc_host", "vnc_port", "forwards")
_lock = threading.Lock()


def _load() -> dict:
    try:
        d = json.loads(FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=2), encoding="utf-8")
    os.replace(tmp, FILE)


def _clean(s: dict) -> dict:
    out = {k: s.get(k) for k in FIELDS if s.get(k) not in (None, "")}
    out["folder"] = "/".join(p.strip() for p in str(out.get("folder", "")).replace("\\", "/").split("/") if p.strip())
    try:
        out["port"] = int(out.get("port") or 22)
    except ValueError:
        out["port"] = 22
    for k in ("name", "host", "user"):
        out[k] = str(out.get(k, "")).strip()
    if not out["name"]:
        out["name"] = f"{out['user']}@{out['host']}" if out["user"] else out["host"]
    if out.get("vnc_port"):
        try:
            out["vnc_port"] = int(out["vnc_port"])
        except ValueError:
            out.pop("vnc_port")
    fw = []
    for f in out.get("forwards") or []:              # [{local_port, host, port, label}]
        try:
            port = int(f.get("port") or 0)
            local = int(f.get("local_port") or 0)
        except (ValueError, AttributeError):
            continue
        if 0 < port < 65536 and 0 <= local < 65536:
            fw.append({"local_port": local, "host": str(f.get("host") or "localhost").strip(), "port": port,
                       "label": str(f.get("label") or "").strip()})
    if fw:
        out["forwards"] = fw
    else:
        out.pop("forwards", None)
    return out


def sessions() -> list[dict]:
    return sorted(_load().get("sessions", []), key=lambda s: (s.get("folder", "").lower(), s.get("name", "").lower()))


def session(sid: str) -> dict | None:
    return next((s for s in _load().get("sessions", []) if s.get("id") == sid), None)


def save(s: dict, sid: str | None = None) -> dict:
    with _lock:
        d = _load()
        lst = d.setdefault("sessions", [])
        c = _clean(s)
        if not c["host"]:
            raise ValueError("A session needs the server's address.")
        if sid:
            for i, old in enumerate(lst):
                if old.get("id") == sid:
                    c["id"] = sid
                    lst[i] = c
                    break
            else:
                raise KeyError(sid)
        else:
            c["id"] = uuid.uuid4().hex[:10]
            lst.append(c)
        _save(d)
        return c


def delete(sid: str) -> None:
    with _lock:
        d = _load()
        d["sessions"] = [s for s in d.get("sessions", []) if s.get("id") != sid]
        _save(d)


def rename_folder(old: str, new: str) -> int:
    """Move every session in folder `old` (and its subfolders) to `new`."""
    new = _clean({"folder": new, "host": "x"})["folder"]
    n = 0
    with _lock:
        d = _load()
        for s in d.get("sessions", []):
            f = s.get("folder", "")
            if f == old or f.startswith(old + "/"):
                s["folder"] = (new + f[len(old):]).strip("/")
                n += 1
        _save(d)
    return n


def recent() -> list[dict]:
    return _load().get("recent", [])


def add_recent(t: dict) -> None:
    entry = {k: t.get(k) for k in ("host", "port", "user", "key_file", "name", "session_id") if t.get(k) not in (None, "")}
    entry["t"] = time.time()
    with _lock:
        d = _load()
        same = lambda r: (r.get("host"), r.get("port", 22), r.get("user")) == (entry.get("host"), entry.get("port", 22), entry.get("user"))  # noqa: E731
        d["recent"] = [entry] + [r for r in d.get("recent", []) if not same(r)][:9]
        _save(d)


def clear_recent() -> None:
    with _lock:
        d = _load()
        d["recent"] = []
        _save(d)


def settings() -> dict:
    return _load().get("settings", {})


def save_settings(s: dict) -> dict:
    with _lock:
        d = _load()
        d["settings"] = {**d.get("settings", {}), **s}
        _save(d)
        return d["settings"]
