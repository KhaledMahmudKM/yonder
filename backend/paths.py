"""Where Yonder's own files are, and its version.

App files (the built UI, VERSION, the README) come with Yonder: next to this backend in a
source checkout, or inside the bundle of a packaged build (PyInstaller's sys._MEIPASS).
Your own data lives outside the app, in ~/.yonder (see store.py) and ~/.ssh.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def resource(*parts: str) -> Path:
    return ROOT.joinpath(*parts)


try:
    VERSION = resource("VERSION").read_text(encoding="utf-8").strip()
except OSError:
    VERSION = "dev"

STATIC_DIR = resource("backend", "static")
