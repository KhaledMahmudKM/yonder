"""Port forwarding, like ssh -L: a port on this computer that leads to host:port as the server sees it.

  127.0.0.1:<local port>  --(this computer)-->  Yonder  --(the server's SSH connection)-->  host:port

Typical uses: a web admin page or a database that listens only on the server's localhost, or a
machine behind the server. Each connection to the local port is one direct-tcpip channel on the
server's connection. Forwards end when the server is disconnected or Yonder stops.
"""
from __future__ import annotations

import os
import select
import socket
import threading
import uuid

import ssh

BIND = os.environ.get("YONDER_FORWARD_BIND", "127.0.0.1")


class Forward:
    def __init__(self, server: ssh.Server, local_port: int, host: str, port: int, label: str = ""):
        self.id = uuid.uuid4().hex[:8]
        self.server, self.host, self.port, self.label = server, host or "localhost", int(port), label
        self.active = 0
        self.total = 0
        self.last_error = ""
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if os.name != "nt":                      # on Windows this would let two programs share the port
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.sock.bind((BIND, int(local_port)))
        except OSError as e:
            self.sock.close()
            raise ssh.SSHError(f"Port {local_port} on this computer is already in use ({e.strerror or e}). "
                               "Pick another, or leave it empty for any free port.")
        self.sock.listen(16)
        self.local_port = self.sock.getsockname()[1]
        self.stopped = threading.Event()
        threading.Thread(target=self._accept, daemon=True, name=f"fwd-{self.local_port}").start()

    def _accept(self):
        while not self.stopped.is_set():
            try:
                client, addr = self.sock.accept()
            except OSError:
                break
            threading.Thread(target=self._serve, args=(client, addr), daemon=True).start()

    def _serve(self, client: socket.socket, addr):
        try:
            chan = self.server.tunnel(self.host, self.port, addr)
        except (ssh.SSHError, ssh.NeedInput) as e:
            self.last_error = str(e) if isinstance(e, ssh.SSHError) else "the server needs you to log in again"
            client.close()
            return
        self.active += 1
        self.total += 1
        self.last_error = ""
        try:
            pump(client, chan, self.stopped)
        finally:
            self.active -= 1

    def stop(self):
        self.stopped.set()
        try:
            self.sock.close()
        except OSError:
            pass

    def describe(self):
        return {"id": self.id, "server": self.server.key, "server_label": self.server.target.label,
                "local": f"{BIND}:{self.local_port}", "local_port": self.local_port, "host": self.host, "port": self.port,
                "label": self.label, "active": self.active, "total": self.total, "error": self.last_error}


def pump(sock: socket.socket, chan, stopped: threading.Event | None = None):
    """Copy bytes both ways between a socket and an SSH channel until either side closes."""
    try:
        while not (stopped and stopped.is_set()):
            r, _, _ = select.select([sock, chan], [], [], 1.0)
            if sock in r:
                data = sock.recv(65536)
                if not data:
                    break
                chan.sendall(data)
            if chan in r:
                data = chan.recv(65536)
                if not data:
                    break
                sock.sendall(data)
    except (OSError, EOFError):
        pass
    finally:
        for x in (chan, sock):
            try:
                x.close()
            except Exception:  # noqa: BLE001
                pass


FORWARDS: dict[str, Forward] = {}
_lock = threading.Lock()


def start(server: ssh.Server, local_port: int, host: str, port: int, label: str = "") -> Forward:
    if not 0 < int(port) < 65536:
        raise ssh.SSHError(f"{port} isn't a valid port.")
    if local_port and not 0 < int(local_port) < 65536:
        raise ssh.SSHError(f"{local_port} isn't a valid port.")
    with _lock:
        for f in FORWARDS.values():              # the same forward twice: keep the one we have
            if f.server is server and f.host == (host or "localhost") and f.port == int(port) \
                    and (not local_port or f.local_port == int(local_port)):
                return f
        f = Forward(server, int(local_port or 0), host, port, label)
        FORWARDS[f.id] = f
        return f


def stop(fid: str):
    with _lock:
        f = FORWARDS.pop(fid, None)
    if f:
        f.stop()


def stop_server(key: str):
    for f in [f for f in FORWARDS.values() if f.server.key == key]:
        stop(f.id)
