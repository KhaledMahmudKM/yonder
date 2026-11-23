"""Keeps other websites out of Yonder.

Yonder listens on 127.0.0.1, but any web page open in your browser can still send
requests there, and a WebSocket isn't bound by the same-origin rules: without a check, a
malicious page could open a shell on a server you're connected to. So:

- the Host header must be one Yonder answers to (127.0.0.1, localhost, [::1], this
  computer's own names, or those in YONDER_ALLOWED_HOSTS): this stops DNS rebinding;
- a request that carries an Origin header (every WebSocket, and every cross-site POST)
  must come from Yonder's own page: Origin's host:port equal to the Host header.

Requests without an Origin (a plain GET typed in the address bar, curl) pass; a GET reads
nothing another site could see, as there are no CORS headers.
"""
from __future__ import annotations

import os
import socket
from urllib.parse import urlparse


def _allowed() -> set[str]:
    names = {"127.0.0.1", "localhost", "::1"}
    try:
        names.add(socket.gethostname().lower())
        names.add(socket.getfqdn().lower())
    except OSError:
        pass
    bind = os.environ.get("YONDER_BIND", "127.0.0.1")
    if bind not in ("0.0.0.0", "::"):
        names.add(bind)
    names |= {h.strip().lower() for h in os.environ.get("YONDER_ALLOWED_HOSTS", "").split(",") if h.strip()}
    return names


ALLOWED = _allowed()
ANY = "*" in ALLOWED


def _hostname(hostport: str) -> str:
    if hostport.startswith("["):
        return hostport[1:].split("]")[0].lower()
    return hostport.rsplit(":", 1)[0].lower() if hostport.count(":") == 1 else hostport.lower()


class OriginGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        host = headers.get("host", "")
        origin = headers.get("origin")
        problem = None
        if not ANY and _hostname(host) not in ALLOWED:
            problem = (f"Yonder doesn't answer to the name {host!r}. To reach it by that name, start it with "
                       f"YONDER_ALLOWED_HOSTS={_hostname(host)}.")
        elif origin is not None and (origin == "null" or urlparse(origin).netloc.lower() != host.lower()):
            problem = "Requests from other websites aren't allowed."
        if problem is None:
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            await receive()                          # websocket.connect
            await send({"type": "websocket.close", "code": 4403})
            return
        body = ('{"detail": %s}' % __import__("json").dumps(problem)).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
