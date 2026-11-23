"""Port forwarding and the VNC relay. Needs: a web server on the test machine at 127.0.0.1:9090, and a
VNC server at 127.0.0.1:5901 (see README). Run after reset.sh."""
import json, urllib.request, time
from websockets.sync.client import connect as wsconnect
B = "http://127.0.0.1:8022/api"
def call(m, p, body=None):
    req = urllib.request.Request(B + p, method=m, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
fails = []
def ok(c, m): print(("PASS " if c else "FAIL ") + m); c or fails.append(m)
A = {"host": "127.0.0.1", "port": 2222, "user": "alice"}
s, r = call("POST", "/connect", A); s, r = call("POST", "/connect", {**A, "trust": r["fingerprint"]})
s, r = call("POST", "/connect", {**A, "password": "alicepw"}); ok(r.get("ok"), "connected")
key = r["server"]["key"]
s, f = call("POST", "/forwards", {"server": key, "host": "127.0.0.1", "port": 9090}); ok(s == 200 and f["local_port"] > 0, f"forward started {f}")
body = urllib.request.urlopen(f"http://127.0.0.1:{f['local_port']}/index.html", timeout=5).read()
ok(b"hello" in body, "web page through the forward")
for _ in range(3): urllib.request.urlopen(f"http://127.0.0.1:{f['local_port']}/", timeout=5).read()
time.sleep(0.3)
s, lst = call("GET", "/forwards"); ok(lst[0]["total"] == 4, f"counts connections {lst[0]['total']}")
s, f2 = call("POST", "/forwards", {"server": key, "host": "127.0.0.1", "port": 9090}); ok(f2["id"] == f["id"], "same forward twice is one")
s, e = call("POST", "/forwards", {"server": key, "local_port": f["local_port"], "host": "127.0.0.1", "port": 22}); ok(s == 502 and "in use" in e["detail"], f"busy local port {e}")
s, f3 = call("POST", "/forwards", {"server": key, "host": "127.0.0.1", "port": 9})
try: urllib.request.urlopen(f"http://127.0.0.1:{f3['local_port']}/", timeout=5); ok(False, "dead target")
except Exception: pass
time.sleep(0.3); s, lst = call("GET", "/forwards"); e3 = [x for x in lst if x["id"] == f3["id"]][0]
ok("nothing answered" in e3["error"], f"dead target reported: {e3['error']}")
call("DELETE", f"/forwards/{f3['id']}")
# saved session with a forward starts it on connect
s, sess = call("POST", "/sessions", {"name": "Web", "host": "127.0.0.1", "port": 2222, "user": "alice", "vnc_port": 5901,
                                    "forwards": [{"local_port": 18080, "host": "127.0.0.1", "port": 9090, "label": "site"}, {"port": "x"}]})
ok(sess.get("forwards") == [{"local_port": 18080, "host": "127.0.0.1", "port": 9090, "label": "site"}] and sess["vnc_port"] == 5901, f"session cleaned {sess}")
call("POST", "/servers/disconnect", {"key": key})
s, lst = call("GET", "/forwards"); ok(lst == [], "disconnect stops forwards")
s, r = call("POST", "/connect", {**A, "session_id": sess["id"], "password": "alicepw"})
ok(any(x["local_port"] == 18080 for x in r.get("forwards", [])), f"session forward started on connect {r.get('forwards')}")
ok(b"hello" in urllib.request.urlopen("http://127.0.0.1:18080/index.html", timeout=5).read(), "fixed local port works")
# VNC relay: the RFB greeting comes through
ws = wsconnect(f"ws://127.0.0.1:8022/api/vnc/ws?server={urllib.parse.quote(key)}&port=5901", origin="http://127.0.0.1:8022", subprotocols=["binary"])
m = ws.recv(timeout=5); ok(isinstance(m, bytes) and m.startswith(b"RFB 003."), f"VNC greeting through SSH: {m!r}")
ws.close()
try:
    w = wsconnect(f"ws://127.0.0.1:8022/api/vnc/ws?server={urllib.parse.quote(key)}&port=5999", origin="http://127.0.0.1:8022"); w.recv(timeout=5); ok(False, "no vnc there")
except Exception as e: ok("nothing answered" in str(e) or "4502" in str(e), f"no VNC server: closed with reason ({e})")
print("FAILURES:", fails)
