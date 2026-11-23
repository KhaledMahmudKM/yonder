"""Session recording: .cast and .log files, listing, download, delete, auto-record. Run after reset.sh."""
import json, time, urllib.request, urllib.parse
from websockets.sync.client import connect as wsconnect
B = "http://127.0.0.1:8022/api"
def call(m, p, body=None, raw=False):
    req = urllib.request.Request(B + p, method=m, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            d = r.read(); return r.status, (d.decode() if raw else json.loads(d or b"null"))
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
fails = []
def ok(c, m): print(("PASS " if c else "FAIL ") + m); c or fails.append(m)
A = {"host": "127.0.0.1", "port": 2222, "user": "alice"}
s, r = call("POST", "/connect", A); s, r = call("POST", "/connect", {**A, "trust": r["fingerprint"]})
s, r = call("POST", "/connect", {**A, "password": "alicepw"}); key = r["server"]["key"]
s, t = call("POST", "/terms", {"server": key, "cols": 100, "rows": 30}); tid = t["id"]
ws = wsconnect(f"ws://127.0.0.1:8022/api/terms/{tid}/ws", origin="http://127.0.0.1:8022")
def drain(sec):
    end = time.time() + sec
    while time.time() < end:
        try: ws.recv(timeout=0.2)
        except TimeoutError: pass
drain(1.0)
s, rec = call("POST", f"/terms/{tid}/record", {}); ok(s == 200 and len(rec["files"]) == 2, f"recording started {rec}")
ws.send(b"printf '\\033[31mRED\\033[0m plain\\n'; for i in 1 2 3; do printf '\\rprogress %d%%' $((i*33)); sleep 0.2; done; echo; echo done-$((40+2))\n")
drain(2.0)
ws.send(json.dumps({"resize": [120, 40]})); drain(0.3)
s, st = call("GET", "/terms"); ok([x for x in st if x["id"] == tid][0]["recording"] is not None, "terminal shows it's recording")
s, stop = call("DELETE", f"/terms/{tid}/record"); ok(len(stop["files"]) == 2, f"stopped {stop['files']}")
cast_name = [f for f in stop["files"] if f.endswith(".cast")][0]; log_name = cast_name[:-5] + ".log"
s, cast = call("GET", f"/recordings/{urllib.parse.quote(cast_name)}", raw=True)
lines = cast.splitlines(); head = json.loads(lines[0]); evs = [json.loads(l) for l in lines[1:]]
ok(head["version"] == 2 and head["width"] == 100 and head["height"] == 30 and "alice" in head["title"], f"cast header {head}")
outs = "".join(e[2] for e in evs if e[1] == "o")
ok("\x1b[31mRED" in outs and "done-42" in outs, "cast keeps colours and output")
ok(any(e[1] == "r" and e[2] == "120x40" for e in evs), "cast records the resize")
ok(all(evs[i][0] <= evs[i+1][0] for i in range(len(evs)-1)) and evs[-1][0] > 0.5, f"times rise, last {evs[-1][0]}")
s, log = call("GET", f"/recordings/{urllib.parse.quote(log_name)}", raw=True)
ok("RED plain" in log and "\x1b" not in log, "log is plain text without escapes")
ok("progress 99%" in log and "progress 33%" not in log, f"log keeps the final progress line only: {[l for l in log.splitlines() if 'progress' in l]}")
ok("done-42" in log and log.startswith("# ") and "# ended" in log, "log header, content, footer")
s, lst = call("GET", "/recordings"); g = lst["recordings"][0]
ok(set(g["files"]) == {"cast", "log"} and g["duration"] and g["duration"] > 0.5, f"listed as one entry with duration {g.get('duration')}")
s, e = call("GET", "/recordings/..%2F..%2Fsessions.json"); ok(s in (400, 404), f"no path tricks ({s})")
s, e = call("GET", "/recordings/evil.txt"); ok(s == 400, "only recordings' names")
with urllib.request.urlopen(f"{B}/recordings/{urllib.parse.quote(cast_name)}?download=true") as r:
    ok("attachment" in r.headers.get("Content-Disposition", ""), "download as a file")
# auto-record: every new terminal
call("PUT", "/settings", {"autoRecord": True, "recordFormat": "cast"})
s, t2 = call("POST", "/terms", {"server": key}); ok(t2["recording"] and len(t2["recording"]["files"]) == 1 and t2["recording"]["files"][0].endswith(".cast"), f"auto-record {t2['recording']}")
call("DELETE", f"/terms/{t2['id']}")            # closing the terminal ends its recording
time.sleep(0.5)
s, lst2 = call("GET", "/recordings"); ok(len(lst2["recordings"]) == 2, "auto recording saved when the terminal closed")
call("PUT", "/settings", {"autoRecord": False})
s, d = call("DELETE", f"/recordings/{urllib.parse.quote(log_name)}"); s, lst3 = call("GET", "/recordings")
ok(set(lst3["recordings"][-1]["files"]) == {"cast"} or set(lst3["recordings"][0]["files"]) == {"cast"}, "delete one file")
print("FAILURES:", fails)
