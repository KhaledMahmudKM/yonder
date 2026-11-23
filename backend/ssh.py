"""SSH connections to many servers at once.

One `Server` per user@host:port. It holds the SSH connections (paramiko Transports) to
that server and the login that opened them, so every tab on that server shares them:
a terminal is one session channel, a file browser one SFTP channel, a copy job another.
OpenSSH allows 10 sessions per connection (MaxSessions), so a Server opens a further
connection, with the same login, when one is full.

Connecting (adapted from DockerLab's connection.py):
- the server's host key is checked against ~/.ssh/known_hosts (shared with OpenSSH). An
  unknown key is shown to the user, and saved once they trust it; a changed key is never
  accepted silently: the user sees the new fingerprint and has to replace it on purpose.
- login tries, in order: the session's own key file, the SSH agent (Pageant or OpenSSH's),
  your keys in ~/.ssh, then a password (or keyboard-interactive). Missing passwords and
  key passphrases come back as {"need": ...} for the browser to ask, never stored on disk;
  they stay in memory while the server is connected, so new tabs and dropped connections
  reconnect without asking again.
- with a password login, the user can have their public key installed on the server, so
  the next login needs no password.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import shlex
import socket
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import paramiko

logging.getLogger("paramiko").setLevel(logging.WARNING)

SSH_DIR = Path(os.environ.get("YONDER_SSH_DIR", Path.home() / ".ssh"))
KNOWN_HOSTS = SSH_DIR / "known_hosts"
MAX_SESSIONS = int(os.environ.get("YONDER_MAX_SESSIONS", "8"))   # per connection; OpenSSH allows 10
CONNECT_TIMEOUT = 10
KEEPALIVE = 30


class SSHError(Exception):
    """A problem the user can act on; the message says what."""


class NeedInput(Exception):
    """Connecting needs something from the user: host-key trust, a password or a passphrase."""

    def __init__(self, info: dict):
        super().__init__(info.get("need"))
        self.info = info


@dataclass
class Target:
    host: str
    port: int = 22
    user: str = ""
    key_file: str = ""            # a private key for this server (optional)
    name: str = ""                # the saved session's name, for display

    @property
    def key(self) -> str:
        return f"{self.user}@{self.host}:{self.port}"

    @property
    def label(self) -> str:
        return self.name or (f"{self.user}@{self.host}" + ("" if self.port == 22 else f":{self.port}"))

    @classmethod
    def parse(cls, d: dict) -> "Target":
        host = (d.get("host") or "").strip()
        user = (d.get("user") or "").strip()
        if "@" in host and not user:                         # quick connect: user@host[:port]
            user, host = host.rsplit("@", 1)
        port = d.get("port") or 22
        if host.count(":") == 1 and not host.startswith("["):
            host, p = host.split(":")
            port = p or port
        host = host.strip("[]")
        if not host:
            raise SSHError("Enter the server's address, e.g. 192.168.56.10 or server.example.com.")
        if not user:
            raise SSHError(f"Enter the user name to log in to {host} as.")
        try:
            port = int(port)
            assert 0 < port < 65536
        except (ValueError, AssertionError):
            raise SSHError(f"{port} isn't a valid port.")
        return cls(host, port, user, (d.get("key_file") or "").strip(), (d.get("name") or "").strip())


# ======================================================================= host keys
def fingerprint(key: paramiko.PKey) -> str:
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


def _host_id(host: str, port: int) -> str:
    return host if int(port) == 22 else f"[{host}]:{port}"


def _known(host: str, port: int) -> list[paramiko.PKey]:
    keys = paramiko.HostKeys()
    for f in (KNOWN_HOSTS, Path("/etc/ssh/ssh_known_hosts")):
        try:
            keys.load(str(f))
        except (OSError, paramiko.SSHException, ValueError):
            pass
    found = keys.lookup(_host_id(host, port)) or {}
    return list(found.values())


def _matches(entry_hosts: str, hid: str) -> bool:
    for h in entry_hosts.split(","):
        if h.startswith("|1|"):                           # hashed: |1|salt|hash
            try:
                _, _, salt, digest = h.split("|")
                mac = hmac.new(base64.b64decode(salt), hid.encode(), hashlib.sha1).digest()
                if base64.b64encode(mac).decode() == digest:
                    return True
            except ValueError:
                continue
        elif h == hid:
            return True
    return False


def trust(host: str, port: int, key: paramiko.PKey, replace: bool) -> None:
    """Add the key to known_hosts; with replace, first remove this host's old entries
    (plain or hashed). Every other line is kept exactly as it was."""
    SSH_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    hid = _host_id(host, port)
    lines = KNOWN_HOSTS.read_text(encoding="utf-8", errors="replace").splitlines() if KNOWN_HOSTS.exists() else []
    if replace:
        lines = [ln for ln in lines if not (ln.strip() and not ln.startswith("#") and _matches(ln.split(" ", 1)[0], hid))]
    lines.append(f"{hid} {key.get_name()} {key.get_base64()}")
    KNOWN_HOSTS.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ======================================================================= your keys
def key_files() -> list[str]:
    """Private keys in ~/.ssh (files with a matching .pub)."""
    try:
        return sorted(str(p.with_suffix("")) for p in SSH_DIR.glob("*.pub") if p.with_suffix("").is_file())
    except OSError:
        return []


def ensure_key() -> str:
    """Your public key (an OpenSSH line), making ~/.ssh/id_ed25519 if you have no key yet."""
    for name in ("id_ed25519", "id_ecdsa", "id_rsa"):
        pub = SSH_DIR / f"{name}.pub"
        if (SSH_DIR / name).exists() and pub.exists():
            return pub.read_text(encoding="utf-8").strip()
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key = Ed25519PrivateKey.generate()
    private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                                serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
    SSH_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = SSH_DIR / "id_ed25519"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(private)
    line = f"{public.decode()} yonder@{socket.gethostname()}"
    (SSH_DIR / "id_ed25519.pub").write_text(line + "\n", encoding="utf-8")
    return line


def _load_key(path: str, passphrase: str | None) -> paramiko.PKey:
    """A private key from a file, any type. Raises PasswordRequiredException when it's
    encrypted and the passphrase is missing or wrong."""
    p = os.path.expanduser(path)
    if not os.path.isfile(p):
        raise SSHError(f"The key file {path} doesn't exist.")

    def bad_passphrase(e) -> bool:
        msgs = []
        while e is not None and len(msgs) < 5:              # the cause may be a few exceptions down
            msgs.append(str(e).lower())
            e = e.__cause__ or e.__context__
        m = " | ".join(msgs)
        return "passphrase" in m or "password" in m or (
            passphrase is not None and any(w in m for w in ("decrypt", "checkint", "checksum", "padding")))
    try:
        if hasattr(paramiko.PKey, "from_path"):            # paramiko 3.2+
            return paramiko.PKey.from_path(p, password=passphrase.encode() if passphrase else None)
        last = None
        for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
            try:
                return cls.from_private_key_file(p, password=passphrase)
            except paramiko.PasswordRequiredException:
                raise
            except paramiko.SSHException as e:
                if bad_passphrase(e):
                    raise paramiko.PasswordRequiredException(str(e))
                last = e
        raise SSHError(f"Couldn't read the key {path}: {last}")
    except paramiko.PasswordRequiredException:
        raise
    except (paramiko.SSHException, ValueError, TypeError) as e:
        if bad_passphrase(e):
            raise paramiko.PasswordRequiredException(str(e))
        raise SSHError(f"Couldn't read the key {path}: {e}")


# ======================================================================= one login
@dataclass
class Creds:
    password: str | None = None
    passphrase: str | None = None      # for the target's key file


def _open_transport(t: Target, creds: Creds, trust_fp: str | None = None) -> tuple[paramiko.Transport, str]:
    """Connect, check the host key, log in. Returns (transport, how it logged in).
    Raises NeedInput or SSHError."""
    try:
        sock = socket.create_connection((t.host, t.port), timeout=CONNECT_TIMEOUT)
    except socket.gaierror:
        raise SSHError(f"Can't find a server called {t.host}. Check the address.")
    except OSError as e:
        raise SSHError(f"Can't reach {t.host} on port {t.port} ({e.strerror or e}). Check that the server is on "
                       "and that this is its address and SSH port.")
    tr = paramiko.Transport(sock)
    ok = False
    try:
        try:
            tr.start_client(timeout=15)
        except (paramiko.SSHException, EOFError, OSError) as e:
            raise SSHError(f"{t.host}:{t.port} answered, but not as an SSH server ({e}).")

        # ---- host key
        key = tr.get_remote_server_key()
        fp = fingerprint(key)
        known = _known(t.host, t.port)
        if not any(k.get_name() == key.get_name() and k.asbytes() == key.asbytes() for k in known):
            # Keys known for this host, but not this one: treated as a changed key (as a warning), even
            # when the known ones are of another type. Accepting it replaces them.
            changed = bool(known)
            if trust_fp != fp:
                info = {"need": "hostkey_changed" if changed else "hostkey", "fingerprint": fp, "key_type": key.get_name(),
                        "host": t.host, "port": t.port}
                if changed:
                    info["old_fingerprints"] = [f"{k.get_name()} {fingerprint(k)}" for k in known]
                raise NeedInput(info)
            trust(t.host, t.port, key, replace=changed)

        # ---- login
        how = _auth(tr, t, creds)
        tr.set_keepalive(KEEPALIVE)
        ok = True
        return tr, how
    finally:
        if not ok:
            tr.close()


def _auth(tr: paramiko.Transport, t: Target, creds: Creds) -> str:
    allowed: list[str] | None = None
    tried_keys = False
    encrypted_key = False

    def try_key(k: paramiko.PKey) -> bool:
        nonlocal allowed, tried_keys
        tried_keys = True
        try:
            tr.auth_publickey(t.user, k)
            return tr.is_authenticated()
        except paramiko.BadAuthenticationType as e:
            allowed = e.allowed_types
            return False
        except paramiko.AuthenticationException:
            return False

    # 1. the session's own key
    if t.key_file:
        try:
            k = _load_key(t.key_file, creds.passphrase)
        except paramiko.PasswordRequiredException:
            raise NeedInput({"need": "passphrase", "key_file": t.key_file,
                             "wrong": creds.passphrase is not None})
        if try_key(k):
            return "key"
    # 2. the SSH agent
    if allowed is None or "publickey" in allowed:
        try:
            for k in paramiko.Agent().get_keys():
                if try_key(k):
                    return "agent"
        except (paramiko.SSHException, OSError):
            pass
    # 3. your keys in ~/.ssh (those without a passphrase)
    if not t.key_file and (allowed is None or "publickey" in allowed):
        for f in key_files():
            try:
                k = _load_key(f, None)
            except paramiko.PasswordRequiredException:
                encrypted_key = True
                continue
            except SSHError:
                continue
            if try_key(k):
                return "key"
    if not tr.is_active():
        raise SSHError(f"{t.host} closed the connection during login (too many keys tried?). "
                       "Pick the right key file in the session's settings.")
    # 4. password, or keyboard-interactive answered with the password
    if creds.password is not None:
        if allowed is None or "password" in allowed:
            try:
                tr.auth_password(t.user, creds.password)
                if tr.is_authenticated():
                    return "password"
            except paramiko.BadAuthenticationType as e:
                allowed = e.allowed_types
            except paramiko.AuthenticationException:
                pass
        if allowed is None or "keyboard-interactive" in allowed:
            try:
                tr.auth_interactive(t.user, lambda _t, _i, prompts: [creds.password for _ in prompts])
                if tr.is_authenticated():
                    return "password"
            except paramiko.BadAuthenticationType as e:
                allowed = e.allowed_types
            except paramiko.AuthenticationException:
                pass
        raise NeedInput({"need": "password", "wrong": True,
                         "message": f"{t.host} didn't accept that password for {t.user}."})
    if allowed is not None and not ({"password", "keyboard-interactive"} & set(allowed)):
        raise SSHError(f"{t.host} accepts only {', '.join(allowed)} logins, and none of your keys was accepted for {t.user}. "
                       "Pick the right key file in the session's settings, or add your key to the server.")
    info = {"need": "password", "wrong": False}
    if tried_keys:
        info["message"] = "None of your SSH keys was accepted, so a password is needed."
    if encrypted_key:
        info["hint"] = "Some of your keys have a passphrase: to use one, pick it as the session's key file."
    raise NeedInput(info)


def install_key(tr: paramiko.Transport) -> None:
    """Add your public key to the server's ~/.ssh/authorized_keys (once)."""
    q = shlex.quote(ensure_key())
    code, out = run(tr, "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && "
                        f"(grep -qxF {q} ~/.ssh/authorized_keys || printf '%s\\n' {q} >> ~/.ssh/authorized_keys)")
    if code:
        raise SSHError(f"Couldn't add your SSH key on the server: {out}")


def run(tr: paramiko.Transport, cmd: str, timeout: float = 30) -> tuple[int, str]:
    ch = tr.open_session(timeout=timeout)
    try:
        ch.settimeout(timeout)
        ch.exec_command(cmd)
        out = b""
        while True:
            b = ch.recv(65536)
            if not b:
                break
            out += b
        err = b""
        while ch.recv_stderr_ready():
            err += ch.recv_stderr(65536)
        return ch.recv_exit_status(), (out + err).decode(errors="replace").strip()
    finally:
        ch.close()


# ======================================================================= a server and its connections
@dataclass
class _Conn:
    tr: paramiko.Transport
    used: int = 0
    last_used: float = field(default_factory=time.time)


class Server:
    def __init__(self, target: Target, creds: Creds, how: str):
        self.target, self.creds, self.how = target, creds, how
        self.conns: list[_Conn] = []
        self.lock = threading.RLock()
        self.since = time.time()

    @property
    def key(self):
        return self.target.key

    def _alive(self):
        self.conns = [c for c in self.conns if c.tr.is_active()]
        return self.conns

    def connected(self) -> bool:
        with self.lock:
            return bool(self._alive())

    def sessions(self) -> int:
        with self.lock:
            return sum(c.used for c in self._alive())

    def describe(self) -> dict:
        t = self.target
        with self.lock:
            conns = self._alive()
            return {"key": t.key, "label": t.label, "name": t.name, "host": t.host, "port": t.port, "user": t.user,
                    "connected": bool(conns), "connections": len(conns), "sessions": sum(c.used for c in conns),
                    "login": self.how, "since": self.since}

    def add(self, tr: paramiko.Transport):
        with self.lock:
            self.conns.append(_Conn(tr))

    def _conn(self) -> _Conn:
        """A connection with room for one more session, opening one (with the remembered login) if needed."""
        with self.lock:
            for c in self._alive():
                if c.used < MAX_SESSIONS:
                    return c
        tr, how = _open_transport(self.target, self.creds)       # may raise NeedInput if the login no longer works
        with self.lock:
            self.how = how
            c = _Conn(tr)
            self.conns.append(c)
            return c

    @contextmanager
    def slot(self):
        """Hold one session on one of the server's connections; yields its transport."""
        c = self._conn()
        with self.lock:
            c.used += 1
        try:
            yield c.tr
        finally:
            with self.lock:
                c.used -= 1
                c.last_used = time.time()

    def acquire(self) -> tuple[paramiko.Transport, callable]:
        """Like slot(), for sessions that outlive a function call: returns (transport, release)."""
        c = self._conn()
        with self.lock:
            c.used += 1
        done = threading.Event()

        def release():
            if done.is_set():
                return
            done.set()
            with self.lock:
                c.used -= 1
                c.last_used = time.time()
        return c.tr, release

    def tunnel(self, host: str, port: int, origin=("127.0.0.1", 0)) -> paramiko.Channel:
        """A TCP connection made by the server to host:port (SSH's direct-tcpip, like ssh -L).
        It doesn't count against MaxSessions, so it goes on any live connection."""
        with self.lock:
            conns = self._alive()
        tr = conns[0].tr if conns else self._conn().tr
        try:
            return tr.open_channel("direct-tcpip", (host, int(port)), origin, timeout=15)
        except paramiko.ChannelException as e:
            reason = {1: "the server doesn't allow forwarding (AllowTcpForwarding no in its sshd_config)",
                      2: f"nothing answered on {host}:{port}, as seen from the server",
                      4: "the server refused (resource shortage)"}.get(e.code, e.text)
            raise SSHError(f"{self.target.label} couldn't connect to {host}:{port}: {reason}.")
        except (paramiko.SSHException, OSError, EOFError) as e:
            raise SSHError(f"{self.target.label} couldn't connect to {host}:{port}: {e or type(e).__name__}.")

    def tidy(self, idle: float = 600):
        """Close extra connections nobody has used for a while; keep one."""
        with self.lock:
            conns = self._alive()
            for c in conns[1:]:
                if not c.used and time.time() - c.last_used > idle:
                    c.tr.close()
            self._alive()

    def close(self):
        with self.lock:
            for c in self.conns:
                try:
                    c.tr.close()
                except Exception:  # noqa: BLE001
                    pass
            self.conns = []


SERVERS: dict[str, Server] = {}
_lock = threading.Lock()


def get(key: str) -> Server:
    s = SERVERS.get(key)
    if s is None:
        raise NeedInput({"need": "connect", "key": key, "message": "Not connected to this server."})
    return s


def connect(t: Target, *, password: str | None = None, passphrase: str | None = None,
            trust_fp: str | None = None, install: bool = False) -> dict:
    """Connect (or check that we are), asking for what's needed. Returns
    {"ok": True, "server": {...}, "notes": [...]} or {"need": ..., ...}."""
    existing = SERVERS.get(t.key)
    if existing and existing.connected() and password is None and passphrase is None and not install:
        if t.name and not existing.target.name:
            existing.target.name = t.name
        return {"ok": True, "server": existing.describe(), "notes": []}
    creds = Creds(password, passphrase)
    if existing and password is None and passphrase is None:     # reconnecting: the login we had
        creds = existing.creds
        if t.key_file != existing.target.key_file:
            creds = Creds(existing.creds.password, None)
    try:
        tr, how = _open_transport(t, creds, trust_fp)
    except NeedInput as n:
        return {**n.info, "key": t.key}
    notes = []
    if install and how == "password":
        try:
            install_key(tr)
            notes.append("Your SSH key was added on the server: next time, no password is needed.")
        except SSHError as e:
            notes.append(str(e))
    with _lock:
        s = SERVERS.get(t.key)
        if s is None:
            s = SERVERS[t.key] = Server(t, creds, how)
        else:
            s.target, s.creds, s.how = t, creds, how
        s.add(tr)
    return {"ok": True, "server": s.describe(), "notes": notes}


def disconnect(key: str) -> None:
    with _lock:
        s = SERVERS.pop(key, None)
    if s:
        s.close()


def tidy_loop():
    while True:
        time.sleep(60)
        for s in list(SERVERS.values()):
            try:
                s.tidy()
            except Exception:  # noqa: BLE001
                pass
