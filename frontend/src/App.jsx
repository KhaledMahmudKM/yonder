import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, serverKey, store, targetLabel } from "./api.js";
import { ConnectProvider, useConnect } from "./connect.jsx";
import FilesView from "./Files.jsx";
import { ForwardsDialog, parseVnc } from "./Forwards.jsx";
import { AboutDialog, ThemesDialog } from "./Dialogs.jsx";
import { RecordingsDialog } from "./Recordings.jsx";
import { Launcher, SessionEditor, Sidebar, sessionTarget } from "./Sessions.jsx";
import { DEFAULTS, FONTS, THEMES } from "./settings.js";
import TermView from "./Terminal.jsx";
import { Dialog, UIProvider, plural, refocus, useUI } from "./ui.jsx";

const VncView = lazy(() => import("./Vnc.jsx"));      // noVNC loads only when a desktop tab opens
const TABS = "yonder.tabs";
const newId = () => Math.random().toString(36).slice(2, 10);
// what's kept of a tab across reloads
const keep = ({ id, kind, title, target, termId, panes, vnc, vncScale }) => ({ id, kind, title, target, termId, panes, vnc, vncScale });

export default function Root() {
  return (
    <UIProvider>
      <SignInGate>
        <Shell />
      </SignInGate>
    </UIProvider>
  );
}

function Shell() {
  const [servers, setServers] = useState([]);
  const [forwards, setForwards] = useState([]);
  const refreshServers = useCallback(() => {
    api.servers().then(setServers).catch(() => {});
    api.forwards().then(setForwards).catch(() => {});
  }, []);
  const onConnected = useCallback((r) => {
    refreshServers();
    for (const n of r?.notes || []) window.dispatchEvent(new CustomEvent("yonder-note", { detail: n }));
  }, [refreshServers]);
  return (
    <ConnectProvider onConnected={onConnected}>
      <App servers={servers} forwards={forwards} refreshServers={refreshServers} />
    </ConnectProvider>
  );
}

function App({ servers, forwards, refreshServers }) {
  const { say, ask, askText, openMenu } = useUI();
  const connect = useConnect();
  const [tabs, setTabs] = useState(() => store.get(TABS, []).map((t) => ({ ...t, state: "idle" })));
  const [activeId, setActiveId] = useState(() => store.get("yonder.active", null));
  const [data, setData] = useState({ sessions: [], recent: [], folders: [] });
  const [settings, setSettings] = useState(() => ({ ...DEFAULTS, ...store.get("yonder.settings", {}) }));
  const [sidebar, setSidebar] = useState(() => store.get("yonder.sidebar", true));
  const [editing, setEditing] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showThemes, setShowThemes] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showRecordings, setShowRecordings] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [about, setAbout] = useState(null);
  const [ports, setPorts] = useState(null);          // the server whose forwards dialog is open
  const tabsRef = useRef(tabs); tabsRef.current = tabs;

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;

  // ---- loading and keeping things
  const loadSessions = useCallback(() => api.sessions().then(setData).catch((e) => say("err", e.message)), [say]);
  useEffect(() => {
    loadSessions();
    refreshServers();
    api.about().then(setAbout).catch(() => {});
    api.settings().then((s) => setSettings((cur) => ({ ...cur, ...s }))).catch(() => {});
    const t = setInterval(refreshServers, 4000);
    return () => clearInterval(t);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => store.set(TABS, tabs.map(keep)), [tabs]);
  useEffect(() => {
    const on = () => setShowRecordings(true);
    window.addEventListener("yonder-recordings", on);
    return () => window.removeEventListener("yonder-recordings", on);
  }, []);
  useEffect(() => {                                  // notes from connecting (key installed, forward problems)
    const on = (e) => say("info", e.detail);
    window.addEventListener("yonder-note", on);
    return () => window.removeEventListener("yonder-note", on);
  }, [say]);
  useEffect(() => store.set("yonder.active", active?.id ?? null), [active?.id]);
  useEffect(() => store.set("yonder.sidebar", sidebar), [sidebar]);
  const saveSettings = (s) => {
    setSettings(s); store.set("yonder.settings", s);
    api.saveSettings(s).catch(() => {});
  };
  useEffect(() => {
    document.title = active ? `${tabTitle(active)} · Yonder` : "Yonder";
  }, [active?.id, active?.title, active?.osTitle]);   // eslint-disable-line react-hooks/exhaustive-deps

  // leaving with terminals open: shells keep running for a while, but ask anyway
  useEffect(() => {
    const warn = (e) => { if (tabsRef.current.some((t) => t.kind === "term" && t.termId)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // ---- tabs
  const patchTab = useCallback((id, p) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t))), []);
  const addTab = (tab, replaceLauncher = true) => {
    const id = newId();
    setTabs((ts) => {
      const cur = ts.findIndex((t) => t.id === (active?.id));
      const full = { id, state: "idle", ...tab };
      if (replaceLauncher && cur >= 0 && ts[cur].kind === "launch") return ts.map((t, i) => (i === cur ? full : t));
      const at = cur >= 0 ? cur + 1 : ts.length;
      return [...ts.slice(0, at), full, ...ts.slice(at)];
    });
    setActiveId(id);
    return id;
  };
  const newLauncher = () => addTab({ kind: "launch" }, false);

  const closeTab = (id) => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    if (t.kind === "term" && t.termId) api.closeTerm(t.termId).catch(() => {});
    setTabs((ts) => {
      const i = ts.findIndex((x) => x.id === id);
      const rest = ts.filter((x) => x.id !== id);
      if (id === active?.id) setActiveId(rest[Math.min(i, rest.length - 1)]?.id ?? null);
      return rest;
    });
  };

  const openTerminal = async (target, cwd = null, replace = true) => {
    const s = await connect(target);
    if (!s) return;
    addTab({ kind: "term", target: { ...target, name: target.name || "" }, cwd }, replace);
    refreshServers();
  };
  const openFiles = async (target, replace = true) => {
    const s = await connect(target);
    if (!s) return;
    addTab({ kind: "files", target, fresh: true,
      panes: { left: { loc: "pc", path: "" }, right: { loc: `s:${s.key}`, path: target.remote_dir || "" }, focus: "right" } }, replace);
    refreshServers();
  };

  const openDesktop = async (target, replace = true) => {
    let vnc = target.vnc_port ? { host: target.vnc_host || "localhost", port: Number(target.vnc_port) } : null;
    if (!vnc) {
      const text = await askText("Open a desktop (VNC)", `The VNC server's port on ${targetLabel(target)}: 5900 + its display number (:1 is 5901). `
        + "Add an address if it isn't on the server itself, e.g. 10.0.0.5:5900.", "5901", "Open");
      if (text == null) return;
      vnc = parseVnc(text);
      if (!vnc) { say("err", `“${text}” isn't a VNC port or display, e.g. 5901 or :1.`); return; }
    }
    const s = await connect(target);
    if (!s) return;
    addTab({ kind: "vnc", target, vnc }, replace);
    refreshServers();
  };

  const duplicate = (t) => {
    if (t.kind === "term") openTerminal(t.target, null, false);
    else if (t.kind === "vnc") addTab({ kind: "vnc", target: t.target, vnc: t.vnc }, false);
    else if (t.kind === "files") addTab({ kind: "files", target: t.target, panes: t.panes, title: t.title }, false);
    else newLauncher();
  };

  const move = (from, to) => setTabs((ts) => {
    const a = [...ts];
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x);
    return a;
  });

  const closeMany = (keepId, rightOnly = false) => {
    const ts = tabsRef.current;
    const i = ts.findIndex((t) => t.id === keepId);
    ts.forEach((t, j) => { if (t.id !== keepId && (!rightOnly || j > i)) closeTab(t.id); });
    setActiveId(keepId);
  };

  const tabMenu = (ev, t) => openMenu(ev, [
    { label: "Rename…", onClick: () => setRenaming(t.id) },
    { label: "Duplicate", onClick: () => duplicate(t) },
    t.target && t.kind === "term" && { label: "Files on this server", onClick: () => openFiles(t.target, false) },
    t.target && t.kind !== "term" && { label: "Terminal on this server", onClick: () => openTerminal(t.target, null, false) },
    t.target && t.kind === "vnc" && { label: "Files on this server", onClick: () => openFiles(t.target, false) },
    t.target && t.kind !== "vnc" && { label: "Desktop on this server (VNC)…", onClick: () => openDesktop(t.target, false) },
    t.target && { label: "Port forwards on this server…", onClick: () => setPorts(serverKey(t.target)) },
    "-",
    { label: "Close", hint: "Alt+Shift+W", onClick: () => closeTab(t.id) },
    { label: "Close other tabs", disabled: tabs.length < 2, onClick: () => closeMany(t.id) },
    { label: "Close tabs to the right", disabled: tabs.at(-1)?.id === t.id, onClick: () => closeMany(t.id, true) },
  ]);

  // ---- keyboard: Alt+Shift+T new tab, Alt+Shift+W close, Alt+1..9, Alt+PgUp/PgDn (the browser keeps Ctrl+T/W/Tab)
  useEffect(() => {
    const key = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const ts = tabsRef.current, i = ts.findIndex((t) => t.id === (active?.id));
      let hit = true;
      if (e.shiftKey && e.code === "KeyT") newLauncher();
      else if (e.shiftKey && e.code === "KeyW") { if (active) closeTab(active.id); }
      else if (/^Digit[1-9]$/.test(e.code) && !e.shiftKey) { const n = Number(e.code.slice(5)); const t = n === 9 ? ts.at(-1) : ts[n - 1]; if (t) setActiveId(t.id); }
      else if (e.code === "PageDown") { if (ts.length) setActiveId(ts[(i + 1) % ts.length].id); }
      else if (e.code === "PageUp") { if (ts.length) setActiveId(ts[(i - 1 + ts.length) % ts.length].id); }
      else hit = false;
      if (hit) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });

  // ---- sessions
  const disconnect = async (key) => {
    const n = tabsRef.current.filter((t) => t.kind === "term" && t.termId && serverKey(t.target) === key).length;
    if (n) {
      const v = await ask({ title: `Disconnect from ${servers.find((s) => s.key === key)?.label ?? key}?`,
        body: `Its ${plural(n, "terminal")} will close, and Yonder forgets its password.`,
        options: [{ label: "Cancel", value: "no" }, { label: "Disconnect", value: "yes", kind: "danger" }] });
      if (v !== "yes") return;
    }
    await api.disconnect(key).catch((e) => say("err", e.message));
    refreshServers();
  };
  const act = {
    terminal: (t) => openTerminal(t),
    files: (t) => openFiles(t),
    desktop: (t) => openDesktop(t),
    ports: (key) => setPorts(key),
    edit: (s) => setEditing(s),
    disconnect,
    remove: async (s) => {
      const v = await ask({ title: `Delete the session ${s.name}?`, body: `Only the saved session (${s.user}@${s.host}); nothing on the server.`,
        options: [{ label: "Cancel", value: "no" }, { label: "Delete", value: "yes", kind: "danger" }] });
      if (v === "yes") { await api.deleteSession(s.id).catch((e) => say("err", e.message)); loadSessions(); }
    },
    renameFolder: async (path) => {
      const nw = (await askText("Rename folder", `New name (or path) for ${path}`, path, "Rename"))?.trim();
      if (nw && nw !== path) { await api.renameFolder(path, nw).catch((e) => say("err", e.message)); loadSessions(); }
    },
    clearRecent: async () => { await api.clearRecent(); loadSessions(); },
  };

  const showLauncher = !tabs.length;

  return (
    <div className={`app${sidebar ? " has-side" : ""}`} data-term-dark={(THEMES[settings.theme] ?? THEMES.slate).dark ? "1" : "0"}
      style={{ "--term-active": (THEMES[settings.theme] ?? THEMES.slate).colors.background }}>
      {sidebar && <Sidebar data={data} servers={servers} forwards={forwards} act={act}
        top={<div className="side-brand">
          <button className="tb-btn side-toggle" onClick={() => setSidebar(false)} aria-pressed title="Hide the sessions"><Logo /></button>
          <span className="brand-name">Yonder</span>
          <button className="tb-btn side-hide" onClick={() => setSidebar(false)} aria-label="Hide the sessions" title="Hide the sessions">«</button>
        </div>} />}
      <div className="workspace">
        <header className="tabbar" role="tablist" aria-label="Tabs">
          {!sidebar && <button className="tb-btn side-toggle" onClick={() => setSidebar(true)} aria-pressed={false} title="Show the sessions">
            <Logo />
          </button>}
          <div className="tabs-scroll">
            {tabs.map((t, i) => (
              <Tab key={t.id} t={t} i={i} active={t.id === active?.id} renaming={renaming === t.id}
                onClick={() => { setActiveId(t.id); refocus(); }} onClose={() => closeTab(t.id)} onMenu={(ev) => tabMenu(ev, t)}
                onRename={(title) => { patchTab(t.id, { title }); setRenaming(null); }} startRename={() => setRenaming(t.id)}
                onMove={move} />
            ))}
            <button className="tb-btn new-tab" onClick={newLauncher} title="New tab (Alt+Shift+T)" aria-label="New tab">+</button>
          </div>
          <button className="tb-btn" title="Settings, themes, recordings, about" aria-label="Menu" aria-haspopup="menu"
            onClick={(ev) => { const r = ev.currentTarget.getBoundingClientRect(); openMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.right, clientY: r.bottom + 4 }, [
              { label: "Settings…", onClick: () => setShowSettings(true) },
              { label: "Themes…", onClick: () => setShowThemes(true) },
              { label: "Recordings…", onClick: () => setShowRecordings(true) },
              "-",
              { label: "About Yonder", onClick: () => setShowAbout(true) },
              about?.password && { label: "Sign out", onClick: async () => { await api.logout(); location.reload(); } },
            ]); }}>⚙</button>
        </header>
        <div className="content">
          {showLauncher && <Launcher data={data} servers={servers} forwards={forwards} act={act} active />}
          {tabs.map((t) => t.kind === "launch" ? <Launcher key={t.id} data={data} servers={servers} forwards={forwards} act={act} active={t.id === active?.id} />
            : t.kind === "vnc" ? <Suspense key={t.id} fallback={null}><VncView tab={t} active={t.id === active?.id} patch={(p) => patchTab(t.id, p)} /></Suspense>
            : t.kind === "term" ? <TermView key={t.id} tab={t} active={t.id === active?.id} settings={settings}
                patch={(p) => patchTab(t.id, p)} onFiles={(tab) => openFiles(tab.target, false)} />
            : t.kind === "files" ? <FilesView key={t.id} tab={t} active={t.id === active?.id} patch={(p) => patchTab(t.id, p)}
                servers={servers} sessions={data.sessions} onTerminalHere={(target, cwd) => openTerminal(target, cwd, false)} />
            : null)}
        </div>
      </div>
      {editing && <SessionEditor session={editing} folders={data.folders} close={() => setEditing(null)}
        onSaved={(s, then) => { loadSessions(); if (then === "terminal") openTerminal(sessionTarget(s)); }} />}
      {ports && <ForwardsDialog server={servers.find((x) => x.key === ports) ?? { key: ports, label: ports }} forwards={forwards}
        refresh={refreshServers} close={() => setPorts(null)} />}
      {showSettings && <SettingsDialog settings={settings} save={saveSettings} close={() => setShowSettings(false)} about={about}
        openThemes={() => { setShowSettings(false); setShowThemes(true); }} />}
      {showThemes && <ThemesDialog settings={settings} save={saveSettings} close={() => setShowThemes(false)} />}
      {showAbout && <AboutDialog about={about} close={() => setShowAbout(false)} Logo={Logo} />}
      {showRecordings && <RecordingsDialog settings={settings} close={() => setShowRecordings(false)} />}
    </div>
  );
}

export const tabTitle = (t) => t.title || (t.kind === "term" ? (t.osTitle || targetLabel(t.target))
  : t.kind === "files" ? `Files · ${targetLabel(t.target)}`
  : t.kind === "vnc" ? (t.osTitle ? `${t.osTitle}` : `Desktop · ${targetLabel(t.target)}`) : "New tab");

function Tab({ t, i, active, renaming, onClick, onClose, onMenu, onRename, startRename, onMove }) {
  const [over, setOver] = useState(false);
  const title = tabTitle(t);
  const color = useMemo(() => t.target?.color, [t.target]);
  return (
    <div role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
      className={`tab is-${t.kind}${active ? " is-active" : ""}${over ? " is-over" : ""}${t.activity ? " has-activity" : ""}${t.bell ? " has-bell" : ""}`}
      onClick={onClick} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
      onDoubleClick={startRename} onContextMenu={onMenu}
      onKeyDown={(e) => { if (e.key === "F2") startRename(); if (e.key === "Delete") onClose(); }}
      draggable={!renaming} onDragStart={(e) => { e.dataTransfer.setData("application/x-yonder-tab", String(i)); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => { if ([...e.dataTransfer.types].includes("application/x-yonder-tab")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const from = Number(e.dataTransfer.getData("application/x-yonder-tab")); if (!Number.isNaN(from) && from !== i) onMove(from, i); }}
      title={t.kind === "launch" ? "New tab" : `${title}\n${t.target ? serverKey(t.target) : ""}\nDouble-click to rename; right-click for more`}>
      {(t.kind === "term" || t.kind === "vnc") && <span className={`dot is-${t.state || "idle"}`} style={color ? { background: color } : undefined} aria-hidden />}
      {t.kind === "vnc" && <span className="tab-ic vnc" aria-hidden>▣</span>}
      {t.kind === "files" && <span className="tab-ic" aria-hidden>▤</span>}
      {renaming ? (
        <input className="tab-rename" autoFocus defaultValue={t.title || title} onClick={(e) => e.stopPropagation()}
          onBlur={(e) => onRename(e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") onRename(t.title || ""); e.stopPropagation(); }} />
      ) : <span className="tab-title">{title}</span>}
      {t.recording && <span className="tab-rec" title="Recording" aria-label="Recording" />}
      <button className="tab-x" tabIndex={-1} aria-label={`Close ${title}`} onClick={(e) => { e.stopPropagation(); onClose(); }}>×</button>
    </div>
  );
}

function SettingsDialog({ settings, save, close, about, openThemes }) {
  const set = (k, v) => save({ ...settings, [k]: v });
  return (
    <Dialog title="Settings" className="settings-dlg" onClose={close}>
      <h3>Terminal</h3>
      <div className="grid2">
        <div className="field">Colors
          <span className="theme-pick">
            <span className="theme-swatch" style={{ background: (THEMES[settings.theme] ?? THEMES.slate).colors.background,
              color: (THEMES[settings.theme] ?? THEMES.slate).colors.green }} aria-hidden>$_</span>
            <b>{(THEMES[settings.theme] ?? THEMES.slate).name}</b>
            <button type="button" className="mini" onClick={openThemes}>Change…</button>
          </span>
        </div>
        <label className="field">Font size
          <span className="stepper">
            <button type="button" onClick={() => set("fontSize", Math.max(8, settings.fontSize - 1))} aria-label="Smaller">−</button>
            <b>{settings.fontSize}</b>
            <button type="button" onClick={() => set("fontSize", Math.min(32, settings.fontSize + 1))} aria-label="Bigger">+</button>
          </span>
        </label>
        <label className="field wide">Font
          <select value={settings.fontFamily} onChange={(e) => set("fontFamily", e.target.value)}>
            {FONTS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            {!FONTS.some(([v]) => v === settings.fontFamily) && <option value={settings.fontFamily}>{settings.fontFamily}</option>}
          </select>
        </label>
        <label className="field">Scrollback (lines)
          <input type="number" min="500" max="100000" step="500" value={settings.scrollback} onChange={(e) => set("scrollback", Math.max(500, Number(e.target.value) || 5000))} />
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={settings.cursorBlink} onChange={(e) => set("cursorBlink", e.target.checked)} /> Blinking cursor</label>
      <label className="check"><input type="checkbox" checked={settings.copyOnSelect} onChange={(e) => set("copyOnSelect", e.target.checked)} /> Copy text as soon as it's selected (like PuTTY)</label>
      <label className="check"><input type="checkbox" checked={settings.confirmPaste} onChange={(e) => set("confirmPaste", e.target.checked)} /> Ask before pasting several lines (each one runs as a command)</label>
      <p className="hint">Copy and paste: select text and press <kbd>Ctrl</kbd>+<kbd>C</kbd> (without a selection it interrupts, as usual), <kbd>Ctrl</kbd>+<kbd>V</kbd> pastes.
        Right-click copies the selection, or pastes. <kbd>Ctrl</kbd>+click opens a link.</p>
      <h3>Recording</h3>
      <label className="check"><input type="checkbox" checked={!!settings.autoRecord} onChange={(e) => set("autoRecord", e.target.checked)} />
        Record every terminal from the moment it opens</label>
      <label className="field inline-select">Record as
        <select value={settings.recordFormat || "both"} onChange={(e) => set("recordFormat", e.target.value)}>
          <option value="both">Both: a replayable .cast and a plain-text .log</option>
          <option value="cast">.cast only (replays with timing and colours)</option>
          <option value="log">.log only (plain text)</option>
        </select>
      </label>
      <p className="hint">Recordings keep what the terminal shows, not the keys you press, so passwords typed at a prompt stay out.
        {about ? <> They're saved in <code>{about.recordings_dir}</code>.</> : null}</p>
      <div className="dialog-actions"><button className="primary" onClick={close}>Done</button></div>
    </Dialog>
  );
}

export function Logo({ size = 22 }) {
  // the sun going down over the sea, far away ("yonder"), with a prompt in the sky
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs><clipPath id="yonder-logo"><rect width="64" height="64" rx="14" /></clipPath></defs>
      <g clipPath="url(#yonder-logo)">
        <rect width="64" height="64" fill="#1C2A35" />
        <circle cx="32" cy="46" r="17" fill="#E8B10E" />
        <rect x="0" y="46" width="64" height="18" fill="#2F6FD6" />
        <path d="M0 53 H64" stroke="#4FC1C9" strokeWidth="3" />
        <path d="M0 59 H64" stroke="#4FC1C9" strokeWidth="2" opacity=".7" />
        <path d="M16 13 l8 6.5 -8 6.5" fill="none" stroke="#E6ECF1" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M30 26 h12" stroke="#E6ECF1" strokeWidth="4.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}

// ------------------------------------------------------------------ sign-in (when YONDER_PASSWORD is set)
function SignInGate({ children }) {
  const [state, setState] = useState("checking");
  useEffect(() => {
    api.auth().then((a) => setState(!a.required || a.ok ? "in" : "out")).catch(() => setState("in"));
    const out = () => setState("out");
    window.addEventListener("yonder-signin", out);
    return () => window.removeEventListener("yonder-signin", out);
  }, []);
  if (state === "checking") return null;
  if (state === "out") return <SignIn />;
  return children;
}

function SignIn() {
  const [pw, setPw] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api.login(pw); location.reload(); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <div className="signin">
      <form className="dialog" onSubmit={go}>
        <div className="signin-head"><Logo size={40} /><div><h2>Yonder</h2><p>This Yonder has a password.</p></div></div>
        <label className="field">Password
          <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
        </label>
        {err && <p className="err-text">{err}</p>}
        <div className="dialog-actions"><button className="primary" disabled={busy || !pw}>{busy ? "Signing in…" : "Sign in"}</button></div>
      </form>
    </div>
  );
}
