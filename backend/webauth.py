"""Optional password for Yonder's web interface.

Off unless YONDER_PASSWORD is set. Then every /api request and WebSocket needs the
session cookie that POST /api/login sets; the page itself and its assets still load (they
hold nothing private), so the browser can show the login screen.

The cookie is an HMAC of the password with a key made at start-up: restarting Yonder,
or changing the password, signs everyone out.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from http.cookies import SimpleCookie

COOKIE = "yonder_session"
_KEY = secrets.token_bytes(32)
OPEN_API = ("/api/auth", "/api/login", "/api/logout")


def password() -> str:
    return os.environ.get("YONDER_PASSWORD", "")


def required() -> bool:
    return bool(password())


def token() -> str:
    return hmac.new(_KEY, password().encode(), hashlib.sha256).hexdigest()


def check_password(given: str) -> bool:
    return required() and hmac.compare_digest(given.encode(), password().encode())


def valid(cookie_header: str | None) -> bool:
    if not required():
        return True
    if not cookie_header:
        return False
    c = SimpleCookie()
    try:
        c.load(cookie_header)
    except Exception:  # noqa: BLE001 — a malformed cookie is simply not a session
        return False
    m = c.get(COOKIE)
    return bool(m) and hmac.compare_digest(m.value, token())


class PasswordGate:
    """ASGI middleware: covers HTTP and WebSockets alike (FastAPI's http middleware
    doesn't see WebSockets, and the consoles are WebSockets)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not required():
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if not path.startswith("/api") or path.startswith(OPEN_API):
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or [])
        if valid(headers.get(b"cookie", b"").decode("latin-1")):
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return
        body = b'{"detail":"Sign in to Yonder first."}'
        await send({"type": "http.response.start", "status": 401,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
