import { useEffect, useMemo, useState } from "react";
import { api, parseQuick, serverKey, store } from "./api.js";
import { ForwardsEditor } from "./Forwards.jsx";
import { Dialog, useUI } from "./ui.jsx";

/** Saved sessions, in folders (like PuTTY or WinSCP), quick connect and recent connections. */

export const sessionTarget = (s) => ({ host: s.host, port: s.port || 22, user: s.user, key_file: s.key_file || "",
  name: s.name, sessionId: s.id || s.session_id || "", remote_dir: s.remote_dir || "", color: s.color || "",
  vnc_host: s.vnc_host || "", vnc_port: s.vnc_port || null });

const where = (s) => `${s.user ? `${s.user}@` : ""}${s.host}${(s.port || 22) === 22 ? "" : `:${s.port}`}`;

/** Sessions grouped into a folder tree: { folders: {name: node}, sessions: [] }. */
function tree(sessions) {
  const root = { folders: {}, sessions: [] };
  for (const s of sessions) {
    let n = root;
    for (const part of (s.folder || "").split("/").filter(Boolean)) n = (n.folders[part] ??= { folders: {}, sessions: [] });
    n.sessions.push(s);
  }
  return root;
}

export function SessionList({ sessions, servers, filter = "", compact, act }) {
  const [closed, setClosed] = useState(() => store.get("yonder.closedFolders", {}));
  useEffect(() => store.set("yonder.closedFolders", closed), [closed]);
  const { openMenu } = useUI();
  const on = new Set(servers.map((s) => s.key));
  const f = filter.trim().toLowerCase();
  const shown = f ? sessions.filter((s) => `${s.name} ${s.folder} ${s.host} ${s.user}`.toLowerCase().includes(f)) : sessions;
  const root = useMemo(() => tree(shown), [shown]);

  const menu = (ev, s) => openMenu(ev, [
    { label: "Open a terminal", onClick: () => act.terminal(sessionTarget(s)) },
    { label: "Open files", onClick: () => act.files(sessionTarget(s)) },
    { label: s.vnc_port ? `Open the desktop (VNC :${s.vnc_port})` : "Open a desktop (VNC)…", onClick: () => act.desktop(sessionTarget(s)) },
    on.has(serverKey(s)) && { label: "Port forwards…", onClick: () => act.ports(serverKey(s)) },
    "-",
    { label: "Edit…", onClick: () => act.edit(s) },
    { label: "Duplicate", onClick: () => act.edit({ ...s, id: undefined, name: `${s.name} (copy)` }) },
    on.has(serverKey(s)) && { label: "Disconnect", onClick: () => act.disconnect(serverKey(s)) },
    "-",
    { label: "Delete", danger: true, onClick: () => act.remove(s) },
  ]);

  const folderMenu = (ev, path) => openMenu(ev, [
    { label: "New session here…", onClick: () => act.edit({ folder: path }) },
    { label: "Rename folder…", onClick: () => act.renameFolder(path) },
  ]);

  const renderNode = (node, path, depth) => (
    <>
      {Object.keys(node.folders).sort((a, b) => a.localeCompare(b)).map((name) => {
        const p = path ? `${path}/${name}` : name;
        const isClosed = !f && closed[p];
        return (
          <li key={`f:${p}`} className="s-folder">
            <button className="s-folder-btn" style={{ paddingLeft: 8 + depth * 14 }} aria-expanded={!isClosed}
              onClick={() => setClosed((c) => ({ ...c, [p]: !c[p] }))} onContextMenu={(ev) => folderMenu(ev, p)}>
              <span className="chev">{isClosed ? "▸" : "▾"}</span> {name}
            </button>
            {!isClosed && <ul>{renderNode(node.folders[name], p, depth + 1)}</ul>}
          </li>
        );
      })}
      {node.sessions.map((s) => {
        const live = on.has(serverKey(s));
        return (
          <li key={s.id} className={`s-item${live ? " is-live" : ""}`} onContextMenu={(ev) => menu(ev, s)}>
            <button className="s-open" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => act.terminal(sessionTarget(s))}
              title={`${where(s)}: click for a terminal, right-click for more`}>
              <span className={`s-dot${live ? " is-on" : ""}`} style={s.color ? { background: s.color } : undefined} aria-hidden />
              <span className="s-name">{s.name}</span>
              {!compact && <span className="s-where">{where(s)}</span>}
            </button>
            <span className="s-actions">
              <button className="mini ghost" onClick={() => act.terminal(sessionTarget(s))} title="Terminal">{compact ? ">_" : "Terminal"}</button>
              <button className="mini ghost" onClick={() => act.files(sessionTarget(s))} title="Files">{compact ? "▤" : "Files"}</button>
              {s.vnc_port && <button className="mini ghost" onClick={() => act.desktop(sessionTarget(s))} title="Desktop (VNC)">{compact ? "▣" : "Desktop"}</button>}
              {!compact && <button className="mini ghost" onClick={() => act.edit(s)} title="Edit">Edit</button>}
            </span>
          </li>
        );
      })}
    </>
  );

  if (!sessions.length) return <p className="hint s-empty">No saved sessions yet.</p>;
  if (!shown.length) return <p className="hint s-empty">No session matches “{filter}”.</p>;
  return <ul className={`s-list${compact ? " is-compact" : ""}`}>{renderNode(root, "", 0)}</ul>;
}

export function Sidebar({ data, servers, forwards, act, top }) {
  const [q, setQ] = useState("");
  return (
    <aside className="sidebar" aria-label="Sessions">
      {top}
      <div className="side-head">
        <b>Sessions</b>
        <button className="mini" onClick={() => act.edit({})} title="New saved session">New…</button>
      </div>
      <input className="side-find" type="search" placeholder="Find a session" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a session" />
      <div className="side-scroll">
        <SessionList sessions={data.sessions} servers={servers} filter={q} compact act={act} />
      </div>
      <ConnectedList servers={servers} forwards={forwards} act={act} />
    </aside>
  );
}

function ConnectedList({ servers, forwards = [], act }) {
  if (!servers.length) return null;
  return (
    <div className="side-connected">
      <b>Connected</b>
      <ul>
        {servers.map((s) => (
          <li key={s.key} title={`${s.key}: ${s.sessions} open session${s.sessions === 1 ? "" : "s"} on ${s.connections} connection${s.connections === 1 ? "" : "s"}; logged in with ${s.login}`}>
            <span className={`s-dot${s.connected ? " is-on" : ""}`} aria-hidden />
            <span className="s-name">{s.label}</span>
            <button className="mini ghost" onClick={() => act.ports(s.key)} title="Port forwards on this server">
              Ports{forwards.filter((f) => f.server === s.key).length ? ` (${forwards.filter((f) => f.server === s.key).length})` : ""}</button>
            <button className="mini ghost" onClick={() => act.disconnect(s.key)} title="Disconnect: closes its terminals and forwards, and forgets its password">Disconnect</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The page of a new tab: quick connect, saved sessions, recent connections. */
export function Launcher({ data, servers, forwards, act, active }) {
  const [quick, setQuick] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const go = (kind) => {
    const t = parseQuick(quick);
    if (!t) { setErr("Type user@address, e.g. alice@192.168.56.10 or root@server.example.com:2222"); return; }
    if (!t.user) { setErr(`Type the user name too: e.g. alice@${t.host}`); return; }
    setErr("");
    // a saved session for that server brings its key file and name
    const s = data.sessions.find((x) => serverKey(x) === serverKey(t));
    act[kind](s ? sessionTarget(s) : t);
  };
  return (
    <div className={`launcher${active ? "" : " is-hidden"}`}>
      <div className="launch-inner">
        <section className="launch-quick">
          <h2>Connect to a server</h2>
          <form onSubmit={(e) => { e.preventDefault(); go("terminal"); }} className="quick-row">
            <input autoFocus={active} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="user@address[:port]"
              aria-label="Quick connect: user@address[:port]" spellCheck={false} list="recent-targets" />
            <button type="submit" className="primary">Terminal</button>
            <button type="button" onClick={() => go("files")}>Files</button>
            <button type="button" onClick={() => { const t = parseQuick(quick) || {}; act.edit({ host: t.host || "", user: t.user || "", port: t.port || 22 }); }}>Save as session…</button>
          </form>
          <datalist id="recent-targets">{data.recent.map((r) => <option key={where(r)} value={where(r)} />)}</datalist>
          {err && <p className="err-text">{err}</p>}
        </section>

        <div className="launch-cols">
          <section className="launch-saved">
            <div className="sec-head">
              <h3>Saved sessions</h3>
              <input type="search" placeholder="Find" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a saved session" />
              <button className="mini" onClick={() => act.edit({})}>New session…</button>
            </div>
            <SessionList sessions={data.sessions} servers={servers} filter={q} act={act} />
          </section>
          <section className="launch-recent">
            <div className="sec-head">
              <h3>Recent</h3>
              {data.recent.length > 0 && <button className="link" onClick={act.clearRecent}>Clear</button>}
            </div>
            {!data.recent.length ? <p className="hint">Servers you connect to show up here.</p> : (
              <ul className="recent">
                {data.recent.map((r) => (
                  <li key={`${where(r)}`}>
                    <button className="s-open" onClick={() => act.terminal(sessionTarget(r))} title="Open a terminal">
                      <span className="s-name">{r.name || where(r)}</span>
                      {r.name && <span className="s-where">{where(r)}</span>}
                    </button>
                    <span className="s-actions">
                      <button className="mini ghost" onClick={() => act.terminal(sessionTarget(r))}>Terminal</button>
                      <button className="mini ghost" onClick={() => act.files(sessionTarget(r))}>Files</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <ConnectedList servers={servers} forwards={forwards} act={act} />
          </section>
        </div>
        <p className="hint launch-keys">Shortcuts: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> new tab · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> close tab ·
          <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd> go to a tab · <kbd>Alt</kbd>+<kbd>PgUp</kbd>/<kbd>PgDn</kbd> previous / next ·
          in a terminal, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> finds text.</p>
      </div>
    </div>
  );
}

/** Add or edit a saved session. */
export function SessionEditor({ session, folders, close, onSaved }) {
  const [s, setS] = useState({ name: "", folder: "", host: "", port: 22, user: "", key_file: "", remote_dir: "", color: "",
    vnc_host: "", vnc_port: "", forwards: [], ...session });
  const [keys, setKeys] = useState({ files: [], dir: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.keys().then(setKeys).catch(() => {}); }, []);
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });

  const save = async (then) => {
    setBusy(true); setErr("");
    try {
      const body = { ...s, port: Number(s.port) || 22, vnc_port: Number(s.vnc_port) || null,
        forwards: (s.forwards || []).filter((f) => Number(f.port)).map((f) => ({ ...f, port: Number(f.port), local_port: Number(f.local_port) || 0 })) };
      delete body.id;
      const r = s.id ? await api.saveSession(s.id, body) : await api.addSession(body);
      onSaved(r, then);
      close();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const COLORS = ["", "#2E9E5B", "#2F6FD6", "#B07A12", "#C8432B", "#8E3BA8", "#0F7C86"];
  return (
    <Dialog title={s.id ? `Edit ${session.name}` : "New saved session"} className="session-dlg" onClose={close}>
      <form onSubmit={(e) => { e.preventDefault(); save("terminal"); }}>
        <div className="grid2">
          <label className="field wide">Address
            <input value={s.host} onChange={set("host")} placeholder="192.168.56.10 or server.example.com" required spellCheck={false} />
          </label>
          <label className="field">Port<input type="number" min="1" max="65535" value={s.port} onChange={set("port")} /></label>
          <label className="field">User<input value={s.user} onChange={set("user")} placeholder="alice" spellCheck={false} /></label>
          <label className="field">Name<input value={s.name} onChange={set("name")} placeholder={s.user && s.host ? `${s.user}@${s.host}` : "Web server"} /></label>
          <label className="field">Folder
            <input value={s.folder} onChange={set("folder")} list="session-folders" placeholder="e.g. Course/Lab 3" />
            <datalist id="session-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
          </label>
          <label className="field wide">Key file <small>(optional: otherwise your agent and ~/.ssh keys, then a password)</small>
            <input value={s.key_file} onChange={set("key_file")} list="key-files" placeholder={keys.dir ? `${keys.dir}${keys.dir.includes("\\") ? "\\" : "/"}id_ed25519` : ""} spellCheck={false} />
            <datalist id="key-files">{keys.files.map((f) => <option key={f} value={f} />)}</datalist>
          </label>
          <label className="field wide">Files start in <small>(optional: otherwise the home folder)</small>
            <input value={s.remote_dir} onChange={set("remote_dir")} placeholder="/var/www" spellCheck={false} />
          </label>
          <details className="wide more" open={!!(s.vnc_port || s.forwards?.length)}>
            <summary>Desktop (VNC) and port forwards</summary>
            <div className="grid2">
              <label className="field">VNC port <small>(5900 + display: :1 is 5901)</small>
                <input type="number" min="1" max="65535" value={s.vnc_port || ""} onChange={set("vnc_port")} placeholder="5901" />
              </label>
              <label className="field">VNC address, as the server sees it
                <input value={s.vnc_host} onChange={set("vnc_host")} placeholder="localhost" spellCheck={false} />
              </label>
            </div>
            <div className="field">Port forwards, started when it connects <small>(this computer's port → address:port on the server)</small>
              <ForwardsEditor value={s.forwards} onChange={(forwards) => setS({ ...s, forwards })} />
            </div>
          </details>
          <div className="field wide">Color
            <div className="swatches">
              {COLORS.map((c) => (
                <button type="button" key={c || "none"} className={`swatch${s.color === c ? " is-on" : ""}`} style={{ background: c || "transparent" }}
                  aria-label={c || "No color"} aria-pressed={s.color === c} onClick={() => setS({ ...s, color: c })}>{c ? "" : "∅"}</button>
              ))}
            </div>
          </div>
        </div>
        {err && <p className="err-text">{err}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={close}>Cancel</button>
          <button type="button" disabled={busy || !s.host} onClick={() => save(null)}>Save</button>
          <button type="submit" className="primary" disabled={busy || !s.host}>Save and connect</button>
        </div>
      </form>
    </Dialog>
  );
}
