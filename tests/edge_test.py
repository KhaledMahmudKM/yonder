import json, subprocess, os, urllib.request, time
B = "http://127.0.0.1:8022/api"
def call(m, p, body=None):
    req = urllib.request.Request(B + p, method=m, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
fails=[]
def ok(c, m): print(("PASS " if c else "FAIL ")+m); c or fails.append(m)
# encrypted key for bob
subprocess.run("rm -f /tmp/sshtest/enc /tmp/sshtest/enc.pub; ssh-keygen -q -t ed25519 -N secretpp -f /tmp/sshtest/enc; mkdir -p /home/bob/.ssh; cat /tmp/sshtest/enc.pub >> /home/bob/.ssh/authorized_keys; chown -R bob /home/bob/.ssh; chmod 700 /home/bob/.ssh; chmod 600 /home/bob/.ssh/authorized_keys", shell=True)
T = {"host": "127.0.0.1", "port": 2223, "user": "bob", "key_file": "/tmp/sshtest/enc"}
call("POST", "/servers/disconnect", {"key": "bob@127.0.0.1:2223"})
s, r = call("POST", "/connect", T); ok(r.get("need") == "passphrase" and not r.get("wrong"), f"passphrase needed {r}")
s, r = call("POST", "/connect", {**T, "passphrase": "nope"}); ok(r.get("need") == "passphrase" and r.get("wrong"), f"wrong passphrase {r}")
s, r = call("POST", "/connect", {**T, "passphrase": "secretpp"}); ok(r.get("ok") and r["server"]["login"] == "key", f"key with passphrase {r.get('server',r)}")
# dropped connection -> reconnect with remembered passphrase: kill transports
s, t = call("POST", "/terms", {"server": "bob@127.0.0.1:2223"}); ok(s == 200, "term with passphrase key")
subprocess.run("pkill -f 'sshd: bob'", shell=True); time.sleep(1)
s, t = call("POST", "/terms", {"server": "bob@127.0.0.1:2223"}); ok(s == 200, f"reconnects by itself after the connection dropped {t}")
# changed host key on A
subprocess.run("kill $(cat /tmp/sshtest/a.pid); rm -f /tmp/sshtest/host_a*; ssh-keygen -q -t ed25519 -N '' -f /tmp/sshtest/host_a; sleep 0.5; /usr/sbin/sshd -f /tmp/sshtest/sshd_a -E /tmp/sshtest/a.log", shell=True); time.sleep(1)
call("POST", "/servers/disconnect", {"key": "alice@127.0.0.1:2222"})
A = {"host": "127.0.0.1", "port": 2222, "user": "alice"}
s, r = call("POST", "/connect", A); ok(r.get("need") == "hostkey_changed" and r.get("old_fingerprints"), f"changed key flagged {r}")
s, r2 = call("POST", "/connect", {**A, "trust": "SHA256:bogus"}); ok(r2.get("need") == "hostkey_changed", "a wrong fingerprint isn't trust")
s, r3 = call("POST", "/connect", {**A, "trust": r["fingerprint"]}); ok(r3.get("ok"), f"replaced {r3.get('need', 'ok')}")
kh = open("/tmp/sshtest/client_ssh/known_hosts").read().splitlines()
ok(sum(1 for l in kh if l.startswith("[127.0.0.1]:2222")) == 1 and sum(1 for l in kh if l.startswith("[127.0.0.1]:2223")) == 1, f"known_hosts tidy: {kh}")
print("FAILURES:", fails)
