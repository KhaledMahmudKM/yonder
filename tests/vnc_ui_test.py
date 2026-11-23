"""The desktop (VNC) tab and port forwards, in the browser. Needs the VNC server and web server of
forward_test.py (see README). Run after reset.sh."""
import json, os, time, urllib.request
from playwright.sync_api import sync_playwright
U = "http://127.0.0.1:8022/"
S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots") + "/"
os.makedirs(S, exist_ok=True)
errors = []
req = urllib.request.Request(U + "api/sessions", method="POST", headers={"Content-Type": "application/json"},
    data=json.dumps({"name": "Lab desktop", "folder": "Course", "host": "127.0.0.1", "port": 2222, "user": "alice", "vnc_port": 5901,
                     "forwards": [{"local_port": 18080, "host": "127.0.0.1", "port": 9090, "label": "web site"}]}).encode())
urllib.request.urlopen(req)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get("CHROME") or None, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1440, "height": 860})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=U.rstrip("/"))
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    pg.goto(U); pg.wait_for_timeout(800)
    pg.locator(".sidebar .s-item").first.hover()
    pg.locator(".sidebar .s-item").first.get_by_title("Desktop (VNC)").click()
    pg.get_by_role("button", name="Trust and connect").click()
    pg.fill(".connect-dlg input[type=password]", "alicepw"); pg.get_by_role("button", name="Log in").click()
    pg.wait_for_selector(".vnc-auth input[type=password]", timeout=15000)
    pg.fill(".vnc-auth input[type=password]", "wrong"); pg.locator(".vnc-auth").get_by_role("button", name="Connect").click()
    pg.wait_for_selector(".vnc-auth >> text=wasn't accepted", timeout=15000)
    pg.screenshot(path=S + "20-vnc-wrong-password.png")
    note = pg.locator(".vncview:not(.is-hidden) .term-note").inner_text()
    if "Couldn't reach" in note: errors.append("wrong password reported as unreachable: " + note)
    pg.fill(".vnc-auth input[type=password]", "vncpw"); pg.locator(".vnc-auth").get_by_role("button", name="Connect").click()
    pg.wait_for_selector(".vnc-box canvas", timeout=15000); pg.wait_for_timeout(2000)
    st = pg.locator(".tab.is-active .dot").get_attribute("class")
    if "is-ok" not in st: errors.append("desktop not connected: " + st)
    pg.screenshot(path=S + "21-vnc-desktop.png")
    title = pg.locator(".tab.is-active .tab-title").inner_text()
    if title.startswith("Desktop ·"): errors.append("desktop name not shown in the tab: " + title)
    # type into the desktop's xterm and see it change: compare canvas before/after
    before = pg.locator(".vnc-box canvas").screenshot()
    pg.locator(".vnc-box canvas").click(position={"x": 300, "y": 200})
    pg.keyboard.type("echo typed-through-vnc\n"); pg.wait_for_timeout(1200)
    after = pg.locator(".vnc-box canvas").screenshot()
    if before == after: errors.append("typing didn't change the desktop")
    pg.screenshot(path=S + "22-vnc-typed.png")
    x = pg.locator(".sidebar").bounding_box()["x"]
    if x != 0: errors.append(f"the page shifted sideways: sidebar at x={x}")
    # the session's forward started on connect: the web page is there
    try:
        body = urllib.request.urlopen("http://127.0.0.1:18080/index.html", timeout=5).read()
        if b"hello" not in body: errors.append("forward 18080 wrong content")
    except Exception as e: errors.append(f"forward 18080: {e}")
    # forwards dialog from the tab menu; add one
    pg.locator(".tab").first.click(button="right"); pg.get_by_role("menuitem", name="Port forwards on this server…").click()
    pg.wait_for_selector(".forwards-dlg")
    pg.locator(".fwd-add").get_by_label("Port", exact=True).fill("22")
    pg.locator(".fwd-add").get_by_label("Address, as the server sees it").fill("127.0.0.1")
    pg.locator(".fwd-add").get_by_label("Name").fill("ssh")
    pg.get_by_role("button", name="Start forward").click(); pg.wait_for_timeout(800)
    rows = pg.locator(".fwd-table tbody tr").count()
    if rows != 2: errors.append(f"expected 2 forwards, got {rows}")
    pg.screenshot(path=S + "23-forwards.png")
    pg.get_by_role("button", name="Close", exact=True).click()
    # session editor shows the VNC and forward fields
    pg.locator(".sidebar .s-item").first.click(button="right"); pg.get_by_role("menuitem", name="Edit…").click()
    pg.wait_for_selector(".session-dlg details.more[open]"); pg.screenshot(path=S + "24-session-vnc-forwards.png")
    pg.keyboard.press("Escape")
    # reload: the desktop tab comes back (the password is asked again: it's kept in the page's memory only)
    pg.on("dialog", lambda d: d.accept()); pg.reload(); pg.wait_for_timeout(2500)
    if not pg.locator(".vnc-auth input[type=password]").count(): errors.append("after reload: no VNC password prompt")
    b.close()
print("ERRORS:", errors)
