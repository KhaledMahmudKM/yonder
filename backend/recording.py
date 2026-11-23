"""Recording terminal sessions.

A recording is what the terminal showed, from the moment recording starts, in one or both of:

  .cast  asciicast v2 (the format asciinema uses): every piece of output with its time, so Yonder's
         player (or asciinema) replays it exactly as it happened, colours and all.
  .log   plain text, like PuTTY's session log: the lines as they appeared, without colours or
         cursor movements, to read, search or hand in.

Only the output is recorded, not the keys pressed: what you type appears in it anyway (the shell
echoes it), while what the shell doesn't show, such as a password at a sudo prompt, stays out.
Recording happens in Yonder, not the browser, so it goes on when the page is reloaded.
"""
from __future__ import annotations

import codecs
import json
import os
import re
import time
from pathlib import Path

import store

FORMATS = ("cast", "log")
NAME_OK = re.compile(r"^[A-Za-z0-9@._-]+\.(cast|log)$")


def folder() -> Path:
    d = Path(os.path.expanduser(store.settings().get("recordDir") or "")) if store.settings().get("recordDir") \
        else store.HOME / "recordings"
    d.mkdir(parents=True, exist_ok=True)
    return d


def safe_path(name: str) -> Path:
    """A recording's file, refusing anything that isn't a plain file name in the folder."""
    if not NAME_OK.match(name):
        raise ValueError(f"{name!r} isn't a recording's name.")
    d = folder().resolve()
    p = (d / name).resolve()
    if p.parent != d:
        raise ValueError(f"{name!r} isn't a recording's name.")
    return p


# ---------------------------------------------------------------- plain text from terminal output
_ESC = re.compile(r"\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-Za-z]|[@-Z\\-_=>])")


class TextLog:
    """Terminal output to readable lines: escape sequences dropped; carriage returns and backspaces
    applied, so progress bars and line editing leave their final text, not every step."""

    def __init__(self, f):
        self.f = f
        self.pending = ""          # an escape sequence cut off at the end of a chunk
        self.line: list[str] = []
        self.col = 0

    def feed(self, text: str):
        text = self.pending + text
        self.pending = ""
        cut = text.rfind("\x1b")
        if cut != -1 and not _ESC.match(text, cut) and len(text) - cut < 64:
            text, self.pending = text[:cut], text[cut:]
        text = _ESC.sub("", text)
        for ch in text:
            if ch == "\n":
                self.f.write("".join(self.line).rstrip() + "\n")
                self.line, self.col = [], 0
            elif ch == "\r":
                self.col = 0
            elif ch == "\b":
                self.col = max(0, self.col - 1)
            elif ch == "\t" or ch >= " ":
                if self.col < len(self.line):
                    self.line[self.col] = ch
                else:
                    self.line.append(ch)
                self.col += 1
        self.f.flush()

    def close(self):
        if self.line:
            self.f.write("".join(self.line).rstrip() + "\n")


class Recorder:
    def __init__(self, title: str, label: str, cols: int, rows: int, formats=FORMATS):
        formats = [f for f in formats if f in FORMATS] or list(FORMATS)
        stamp = time.strftime("%Y-%m-%d_%H-%M-%S")
        base = f"{stamp}_{re.sub(r'[^A-Za-z0-9@._-]+', '_', label)[:60]}"
        d = folder()
        n = 1
        while any((d / f"{base}{'' if n == 1 else f'-{n}'}.{x}").exists() for x in formats):
            n += 1
        self.base = base if n == 1 else f"{base}-{n}"
        self.started = time.time()
        self.t0 = time.monotonic()
        self.files: list[str] = []
        self.cast = self.text = None
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        if "cast" in formats:
            self.cast = open(d / f"{self.base}.cast", "w", encoding="utf-8", newline="\n")
            self.cast.write(json.dumps({"version": 2, "width": cols, "height": rows, "timestamp": int(self.started),
                                        "title": title, "env": {"TERM": "xterm-256color"}}) + "\n")
            self.files.append(f"{self.base}.cast")
        if "log" in formats:
            f = open(d / f"{self.base}.log", "w", encoding="utf-8", newline="\n")
            f.write(f"# {title}: recorded by Yonder from {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
            self.text = TextLog(f)
            self.files.append(f"{self.base}.log")

    def output(self, data: bytes):
        s = self.decoder.decode(data)
        if not s:
            return
        if self.cast:
            self.cast.write(json.dumps([round(time.monotonic() - self.t0, 6), "o", s]) + "\n")
            self.cast.flush()
        if self.text:
            self.text.feed(s)

    def resize(self, cols: int, rows: int):
        if self.cast:
            self.cast.write(json.dumps([round(time.monotonic() - self.t0, 6), "r", f"{cols}x{rows}"]) + "\n")

    def close(self):
        if self.cast:
            self.cast.close()
            self.cast = None
        if self.text:
            self.text.close()
            self.text.f.write(f"# ended {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
            self.text.f.close()
            self.text = None

    def describe(self):
        return {"files": self.files, "started": self.started, "folder": str(folder())}


# ---------------------------------------------------------------- the recordings folder
def listing() -> list[dict]:
    """Recordings, newest first; a .cast and a .log of the same session are one entry."""
    d = folder()
    groups: dict[str, dict] = {}
    for p in d.iterdir():
        if not p.is_file() or not NAME_OK.match(p.name):
            continue
        st = p.stat()
        base, kind = p.stem, p.suffix[1:]
        g = groups.setdefault(base, {"base": base, "files": {}, "mtime": 0, "title": base, "duration": None, "started": None})
        g["files"][kind] = {"name": p.name, "size": st.st_size}
        g["mtime"] = max(g["mtime"], st.st_mtime)
        if kind == "cast":
            info = _cast_info(p)
            g.update({k: v for k, v in info.items() if v is not None})
    return sorted(groups.values(), key=lambda g: -g["mtime"])


def _cast_info(p: Path) -> dict:
    out = {"title": None, "duration": None, "started": None}
    try:
        with open(p, "rb") as f:
            head = json.loads(f.readline() or b"{}")
            out["title"] = head.get("title")
            out["started"] = head.get("timestamp")
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 8192))
            for line in reversed(f.read().splitlines()):
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if isinstance(ev, list) and ev:
                    out["duration"] = ev[0]
                    break
    except (OSError, ValueError):
        pass
    return out
