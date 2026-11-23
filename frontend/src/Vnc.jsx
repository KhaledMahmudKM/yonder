import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { api, serverKey, targetLabel } from "./api.js";
import { useConnect } from "./connect.jsx";
import { useUI } from "./ui.jsx";

/** A desktop tab: noVNC in the browser, connected through the server's SSH connection to a VNC
 *  server as the server sees it (usually localhost:5901). The VNC password is asked for when the
 *  VNC server wants one, and kept in this page's memory only, for reconnecting. */
const passwords = new Map();                       // "server|host:port" -> password, this page only

export default function VncView({ tab, active, patch }) {
  const box = useRef(null);
  const rfb = useRef(null);
  const tabRef = useRef(tab); tabRef.current = tab;
  const [state, setStateRaw] = useState("idle");  // connecting | ok | closed | auth
  const [note, setNote] = useState("");
  const [askPw, setAskPw] = useState(null);       // null, or { wrong }
  const [pw, setPw] = useState("");
  const [scale, setScale] = useState(tab.vncScale || "fit");   // fit | real | remote
  const [viewOnly, setViewOnly] = useState(false);
  const connect = useConnect();
  const { say } = useUI();
  const v = tab.vnc || { host: "localhost", port: 5900 };
  const pwKey = `${serverKey(tab.target)}|${v.host}:${v.port}`;

  const setState = (s, n = "") => { stateRef.current = s; setStateRaw(s); setNote(n); patch({ state: s }); };

  const apply = (r, sc = scale, vo = viewOnly) => {
    r.scaleViewport = sc === "fit";
    r.resizeSession = sc === "remote";
    r.clipViewport = sc !== "real";
    r.viewOnly = vo;
  };

  async function start(mode) {
    stop();
    askedOnce.current = false;
    setState("connecting", `Connecting to the desktop at ${v.host}:${v.port} on ${targetLabel(tab.target)}…`);
    const t = tabRef.current.target;
    try {
      const r = await api.connect({ ...t, session_id: t.sessionId || "" });
      if (!r.ok) {
        if (mode === "auto") { setState("closed", `Not connected to ${targetLabel(t)}.`); return; }
        if (!(await connect(t))) { setState("closed", "Not connected."); return; }
      }
    } catch (e) { setState("closed", e.message); return; }
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/vnc/ws?` +
      new URLSearchParams({ server: serverKey(t), host: v.host || "localhost", port: String(v.port || 5900) });
    let r;
    try {
      r = new RFB(box.current, url, { shared: true, credentials: passwords.has(pwKey) ? { password: passwords.get(pwKey) } : undefined });
    } catch (e) { setState("closed", e.message); return; }
    rfb.current = r;
    apply(r);
    r.background = "#142029";
    r.focusOnClick = true;
    let connected = false;
    r.addEventListener("connect", () => { connected = true; setState("ok"); setAskPw(null); if (active) r.focus({ preventScroll: true }); });
    r.addEventListener("disconnect", (e) => {
      if (rfb.current !== r) return;
      rfb.current = null;
      if (stateRef.current === "auth") return;           // the password was wrong: the dialog stays
      setState("closed", connected ? (e.detail.clean ? "The desktop session ended." : "The connection to the desktop was lost.")
        : `Couldn't reach a VNC server at ${v.host}:${v.port} on ${targetLabel(t)}. Is it running, and is that its port (5900 + display number)?`);
    });
    r.addEventListener("credentialsrequired", () => {
      if (passwords.has(pwKey) && !askedOnce.current) { askedOnce.current = true; r.sendCredentials({ password: passwords.get(pwKey) }); return; }
      setState("auth", "The desktop needs its VNC password.");
      setAskPw({ wrong: false });
    });
    r.addEventListener("securityfailure", (e) => {
      passwords.delete(pwKey);
      setState("auth", e.detail.reason || "The VNC password wasn't accepted.");
      setAskPw({ wrong: true });
    });
    r.addEventListener("desktopname", (e) => patch({ osTitle: e.detail.name }));
    r.addEventListener("clipboard", (e) => {     // copied on the desktop: put it on this computer's clipboard
      navigator.clipboard?.writeText(e.detail.text).then(() => say("info", "Copied from the desktop to your clipboard."), () => {});
    });
  }
  const askedOnce = useRef(false);
  const stateRef = useRef("idle");                  // set at once, not at the next render: noVNC's events come in a burst

  function stop() {
    const r = rfb.current;
    rfb.current = null;
    if (r) try { r.disconnect(); } catch { /* already closed */ }
  }

  useEffect(() => { start("auto"); return stop; }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active && rfb.current && state === "ok") rfb.current.focus({ preventScroll: true }); }, [active, state]);

  const sendPassword = (e) => {
    e.preventDefault();
    passwords.set(pwKey, pw);
    askedOnce.current = true;
    setAskPw(null); setPw("");
    if (rfb.current && askPw && !askPw.wrong) {        // still connected, waiting for the password
      setState("connecting", "Logging in…");
      rfb.current.sendCredentials({ password: passwords.get(pwKey) });
    } else start("user");                            // the server hung up after a wrong password: start again
  };

  const setMode = (sc) => { setScale(sc); patch({ vncScale: sc }); if (rfb.current) apply(rfb.current, sc, viewOnly); };
  const toggleView = () => { const vo = !viewOnly; setViewOnly(vo); if (rfb.current) apply(rfb.current, scale, vo); };
  const sendClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      rfb.current?.clipboardPasteFrom(text);
      say("ok", "Sent your clipboard to the desktop: paste it there as usual.");
    } catch { say("err", "The browser didn't allow reading the clipboard."); }
    rfb.current?.focus({ preventScroll: true });
  };
  const fullscreen = () => box.current?.parentElement?.requestFullscreen?.();

  return (
    <div className={`vncview${active ? "" : " is-hidden"}`}>
      <div className="term-bar">
        <span className={`dot is-${state === "auth" ? "connecting" : state}`} aria-hidden />
        <span className="term-where">{targetLabel(tab.target)}</span>
        <span className="term-note">{note || (state === "ok" ? `Desktop ${v.host}:${v.port}` : "")}</span>
        <span className="spacer" />
        {state === "ok" && (<>
          <select className="mini-select" value={scale} onChange={(e) => setMode(e.target.value)} aria-label="Size">
            <option value="fit">Fit to the tab</option>
            <option value="real">Actual size</option>
            <option value="remote">Resize the desktop</option>
          </select>
          <button className={`mini ghost${viewOnly ? " is-on" : ""}`} aria-pressed={viewOnly} onClick={toggleView}
            title="Watch only: your mouse and keyboard don't reach the desktop">View only</button>
          <button className="mini ghost" onClick={sendClipboard} title="Put your clipboard's text on the desktop's clipboard">Send clipboard</button>
          <button className="mini ghost" onClick={() => { rfb.current?.sendCtrlAltDel(); rfb.current?.focus({ preventScroll: true }); }}>Ctrl+Alt+Del</button>
          <button className="mini ghost" onClick={fullscreen} title="Full screen (Esc to leave)">Full screen</button>
        </>)}
        {state === "closed" && <button className="mini primary" onClick={() => start("user")}>Reconnect</button>}
      </div>
      <div className="vnc-wrap">
        <div className="vnc-box" ref={box} />
        {askPw && (
          <form className="vnc-auth dialog" onSubmit={sendPassword}>
            <h2>VNC password</h2>
            <p>{askPw.wrong ? "That password wasn't accepted. " : ""}The desktop at {v.host}:{v.port} on {targetLabel(tab.target)} asks for its VNC password
              (the one set with <code>vncpasswd</code>, not your login password).</p>
            <label className="field">Password<input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></label>
            <p className="hint">Kept in this page's memory for reconnecting, never saved.</p>
            <div className="dialog-actions">
              <button type="button" onClick={() => { setAskPw(null); stop(); setState("closed", "Not logged in to the desktop."); }}>Cancel</button>
              <button className="primary" disabled={!pw}>Connect</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
