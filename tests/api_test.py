import json, time, sys, urllib.request
from websockets.sync.client import connect as wsconnect
B = "http://127.0.0.1:8022/api"
def call(m, p, body=None):
    req = urllib.request.Request(B + p, method=m, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")
def ok(c, msg): print(("PASS " if c else "FAIL ") + msg); globals().setdefault("fails", []); (None if c else fails.append(msg))

A = {"host": "127.0.0.1", "port": 2222, "user": "alice"}
Bsrv = {"host": "bob@127.0.0.1:2223"}  # quick-connect syntax
# 1. unknown host key
s, r = call("POST", "/connect", A); ok(r.get("need") == "hostkey", f"A unknown host key -> {r}")
fp = r["fingerprint"]
s, r = call("POST", "/connect", {**A, "trust": fp}); ok(r.get("need") == "password", f"A after trust needs password -> {r.get('need')}")
s, r = call("POST", "/connect", {**A, "password": "wrong"}); ok(r.get("need") == "password" and r.get("wrong"), f"wrong pw -> {r}")
s, r = call("POST", "/connect", {**A, "password": "alicepw", "install_key": True}); ok(r.get("ok"), f"A connect pw+install -> {r}")
# reconnect check uses existing
s, r = call("POST", "/connect", A); ok(r.get("ok"), "A already connected")
# 2. B via keyboard-interactive
s, r = call("POST", "/connect", Bsrv); ok(r.get("need") == "hostkey", "B unknown key")
s, r = call("POST", "/connect", {**Bsrv, "trust": r["fingerprint"]}); ok(r.get("need") == "password", f"B needs pw {r}")
s, r = call("POST", "/connect", {**Bsrv, "password": "bobpw"}); ok(r.get("ok") and r["server"]["login"] == "password", f"B kbd-int login {r}")
bkey = r["server"]["key"]
s, r = call("GET", "/servers"); ok(len(r) == 2, f"two servers {[x['key'] for x in r]}")
akey = "alice@127.0.0.1:2222"
# 3. key login to A now works without password: disconnect then reconnect
call("POST", "/servers/disconnect", {"key": akey})
s, r = call("POST", "/connect", A); ok(r.get("ok") and r["server"]["login"] == "key", f"A key login after install {r}")

# 4. terminal
s, t = call("POST", "/terms", {"server": akey, "cols": 100, "rows": 30}); ok(s == 200, f"open term {t}")
tid = t["id"]
ws = wsconnect(f"ws://127.0.0.1:8022/api/terms/{tid}/ws", origin="http://127.0.0.1:8022")
ws.send(json.dumps({"resize": [120, 40]}))
ws.send(b"echo HELLO-$((6*7)); stty size\n")
buf = b""; end = time.time() + 5
while time.time() < end and b"HELLO-42" not in buf or b"40 120" not in buf:
    try: m = ws.recv(timeout=1)
    except TimeoutError: continue
    if isinstance(m, bytes): buf += m
    if time.time() > end: break
ok(b"HELLO-42" in buf and b"40 120" in buf, "shell runs commands, resize works")
ws.close(); time.sleep(0.5)
# 5. reattach: replay contains earlier output
ws = wsconnect(f"ws://127.0.0.1:8022/api/terms/{tid}/ws", origin="http://127.0.0.1:8022")
hello = ws.recv(timeout=3); m = ws.recv(timeout=3); ok('"attached"' in hello and isinstance(m, bytes) and b"HELLO-42" in m, "reattach replays the screen")
# take over by a second socket
ws2 = wsconnect(f"ws://127.0.0.1:8022/api/terms/{tid}/ws", origin="http://127.0.0.1:8022")
got = []
try:
    while True:
        x = ws.recv(timeout=2); got.append(x)
        if isinstance(x, str): break
except Exception as e: pass
ok(any(isinstance(x, str) and "detached" in x for x in got), "first socket told it was taken over")
ws2.send(b"exit\n")
got = []
try:
    while True:
        x = ws2.recv(timeout=3); got.append(x)
except Exception: pass
ok(any(isinstance(x, str) and '"exit": 0' in x for x in got), f"exit status reported {[x for x in got if isinstance(x,str)]}")
s, r = call("GET", "/terms"); ok(not any(x["id"] == tid for x in r), "exited term is gone")
# origin check on ws
try:
    wsconnect(f"ws://127.0.0.1:8022/api/terms/x/ws", origin="http://evil.com").recv(timeout=2); ok(False, "evil ws refused")
except Exception as e: ok(True, f"evil ws refused ({type(e).__name__})")

# 6. many sessions: 12 terms on B (more than MAX_SESSIONS=8) -> 2 connections
ids = []
for i in range(12):
    s, t = call("POST", "/terms", {"server": bkey}); ids.append(t.get("id")); 
ok(all(ids), f"12 terminals on B {ids}")
s, r = call("GET", "/servers"); b = [x for x in r if x["key"] == bkey][0]
ok(b["connections"] == 2 and b["sessions"] == 12, f"B uses 2 connections for 12 sessions: {b}")
for i in ids: call("DELETE", f"/terms/{i}")

# 7. files: list, mkdir, upload, copy A -> B, move, rename, chmod, text, download zip
loc_a, loc_b = f"s:{akey}", f"s:{bkey}"
s, r = call("GET", f"/files/list?loc={urllib.parse.quote(loc_a)}&path="); ok(r.get("path") == "/home/alice", f"A home {r.get('path')}")
call("POST", "/files/mkdir", {"loc": loc_a, "path": "/home/alice/proj/sub"})
for n, data in (("a.txt", b"alpha\n"), ("big.bin", bytes(range(256)) * 8000)):
    req = urllib.request.Request(f"{B}/files/upload?loc={urllib.parse.quote(loc_a)}&dir=/home/alice/proj&rel={n}", method="PUT", data=data)
    urllib.request.urlopen(req)
s, r = call("GET", f"/files/list?loc={urllib.parse.quote(loc_a)}&path=/home/alice/proj")
ok(sorted(e["name"] for e in r["entries"]) == ["a.txt", "big.bin", "sub"], f"uploaded {[e['name'] for e in r['entries']]}")
s, j = call("POST", "/files/copy", {"src": loc_a, "src_dir": "/home/alice", "names": ["proj"], "dst": loc_b, "dst_dir": "/home/bob"})
for _ in range(50):
    s, jj = call("GET", "/files/jobs"); jj = [x for x in jj if x["id"] == j["id"]][0]
    if jj["state"] != "running": break
    time.sleep(0.2)
ok(jj["state"] == "done" and jj["done_bytes"] == 6 + 256*8000, f"copy A->B server to server {jj['state']} {jj['done_bytes']} {jj['errors']}")
import subprocess
ok(subprocess.run(["cmp", "/home/alice/proj/big.bin", "/home/bob/proj/big.bin"]).returncode == 0, "B's copy is identical")
# copy again -> skipped
s, j = call("POST", "/files/exists", {"loc": loc_b, "dir": "/home/bob", "names": ["proj"]}); ok(j["exists"] == ["proj"], "exists check")
# move within B = rename
s, j = call("POST", "/files/copy", {"src": loc_b, "src_dir": "/home/bob/proj", "names": ["a.txt"], "dst": loc_b, "dst_dir": "/home/bob/proj/sub", "move": True})
time.sleep(0.5); s, jj = call("GET", "/files/jobs"); jj = [x for x in jj if x["id"] == j["id"]][0]
import os
ok(jj["state"] == "done" and os.path.exists("/home/bob/proj/sub/a.txt") and not os.path.exists("/home/bob/proj/a.txt"), f"move within a server {jj}")
s, j = call("POST", "/files/copy", {"src": loc_b, "src_dir": "/home/bob", "names": ["proj"], "dst": loc_b, "dst_dir": "/home/bob/proj/sub"})
ok(s == 400, f"no copying a folder into itself {j}")
call("POST", "/files/chmod", {"loc": loc_b, "dir": "/home/bob/proj/sub", "names": ["a.txt"], "perm": 0o640})
ok(oct(os.stat("/home/bob/proj/sub/a.txt").st_mode & 0o777) == "0o640", "chmod")
s, r = call("GET", f"/files/text?loc={urllib.parse.quote(loc_b)}&path=/home/bob/proj/sub/a.txt"); ok(r.get("text") == "alpha\n", f"read text {r}")
s, w = call("PUT", "/files/text", {"loc": loc_b, "path": "/home/bob/proj/sub/a.txt", "text": "beta\n", "mtime": r["mtime"]})
ok(open("/home/bob/proj/sub/a.txt").read() == "beta\n" and oct(os.stat("/home/bob/proj/sub/a.txt").st_mode & 0o777) == "0o640", f"save text keeps mode {w}")
s, w = call("PUT", "/files/text", {"loc": loc_b, "path": "/home/bob/proj/sub/a.txt", "text": "gamma\n", "mtime": r["mtime"] - 100})
ok(s == 409, f"stale save refused: {w}")
s, r = call("GET", f"/files/text?loc={urllib.parse.quote(loc_b)}&path=/home/bob/proj/big.bin"); ok(s == 409, f"binary refused {r}")
with urllib.request.urlopen(f"{B}/files/download?loc={urllib.parse.quote(loc_b)}&dir=/home/bob&names=proj") as resp:
    data = resp.read()
import zipfile, io
names = sorted(zipfile.ZipFile(io.BytesIO(data)).namelist()); ok("proj/big.bin" in names and "proj/sub/a.txt" in names, f"zip download {names}")
# B -> pc copy
call("POST", "/files/copy", {"src": loc_b, "src_dir": "/home/bob/proj", "names": ["big.bin"], "dst": "pc", "dst_dir": "/tmp"})
time.sleep(1); ok(os.path.getsize("/tmp/big.bin") == 256*8000, "B -> this computer")
# permission error message
s, r = call("GET", f"/files/list?loc={urllib.parse.quote(loc_b)}&path=/root"); ok(s == 409 and "No permission" in r["detail"], f"perm msg: {r}")
# 8. disconnect forgets: term on disconnected server -> need connect
call("POST", "/servers/disconnect", {"key": bkey})
s, r = call("POST", "/terms", {"server": bkey}); ok(s == 409 and r.get("need") == "connect", f"after disconnect {r}")
s, r = call("GET", f"/files/list?loc={urllib.parse.quote(loc_b)}"); ok(s == 409 and r.get("need") == "connect", f"files after disconnect {r}")
# 9. sessions store
s, r = call("POST", "/sessions", {"name": "Web 1", "folder": "Prod / Web", "host": "127.0.0.1", "port": 2222, "user": "alice"})
ok(r.get("folder") == "Prod/Web", f"session saved {r}")
s, r = call("GET", "/sessions"); ok(r["folders"] == ["Prod/Web"] and len(r["recent"]) == 2, f"sessions list {r['folders']} recent={len(r['recent'])}")
print("\nFAILURES:", fails if 'fails' in globals() else [])
