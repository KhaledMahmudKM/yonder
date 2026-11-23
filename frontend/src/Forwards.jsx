import { useState } from "react";
import { api } from "./api.js";
import { Dialog, plural, useUI } from "./ui.jsx";

/** Port forwards of one server, like ssh -L: a port on this computer leading to host:port as the server sees it. */
export function ForwardsDialog({ server, forwards, refresh, close }) {
  const { say } = useUI();
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("");
  const [local, setLocal] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const mine = forwards.filter((f) => f.server === server.key);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const f = await api.addForward({ server: server.key, host: host.trim() || "localhost", port: Number(port), local_port: Number(local) || 0, label: label.trim() });
      if (mine.some((x) => x.id === f.id)) say("info", `That's already forwarded, at 127.0.0.1:${f.local_port}.`);
      else say("ok", `127.0.0.1:${f.local_port} now leads to ${f.host}:${f.port} on ${server.label}.`);
      setPort(""); setLocal(""); setLabel("");
      refresh();
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const stop = async (f) => { await api.stopForward(f.id).catch((x) => say("err", x.message)); refresh(); };

  return (
    <Dialog title={`Port forwards on ${server.label}`} className="forwards-dlg" onClose={close}>
      <p>A port on this computer that leads to an address as <b>{server.label}</b> sees it, through its SSH connection
        (like <code>ssh -L</code>). For example, a web admin page or database that listens only on the server itself.</p>
      {mine.length ? (
        <table className="fwd-table">
          <thead><tr><th>On this computer</th><th /><th>On the server</th><th>Use</th><th /></tr></thead>
          <tbody>
            {mine.map((f) => (
              <tr key={f.id}>
                <td><code>{f.local}</code>{f.label && <small> {f.label}</small>}</td>
                <td aria-hidden>→</td>
                <td><code>{f.host}:{f.port}</code></td>
                <td>{f.error ? <span className="err-text" title={f.error}>failing</span>
                  : <small>{f.active ? `${plural(f.active, "connection")} open` : f.total ? `${plural(f.total, "connection")} so far` : "unused yet"}</small>}</td>
                <td className="fwd-actions">
                  <a className="button mini" href={`http://127.0.0.1:${f.local_port}/`} target="_blank" rel="noreferrer" title="If it's a web page">Open</a>
                  <button className="mini" onClick={() => navigator.clipboard?.writeText(`127.0.0.1:${f.local_port}`).then(() => say("ok", "Address copied."))}>Copy</button>
                  <button className="mini danger" onClick={() => stop(f)}>Stop</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="hint">No forwards yet.</p>}
      {mine.some((f) => f.error) && <p className="err-text">{mine.find((f) => f.error).error}</p>}
      <form className="fwd-add" onSubmit={add}>
        <h3>New forward</h3>
        <div className="fwd-row">
          <label className="field">Address, as the server sees it<input value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} /></label>
          <label className="field">Port<input type="number" min="1" max="65535" required value={port} onChange={(e) => setPort(e.target.value)} placeholder="8080" /></label>
          <label className="field">Port on this computer<input type="number" min="1" max="65535" value={local} onChange={(e) => setLocal(e.target.value)} placeholder="any free" /></label>
          <label className="field">Name<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" /></label>
        </div>
        {err && <p className="err-text">{err}</p>}
        <p className="hint">To start forwards every time you connect, add them to the saved session (Edit).</p>
        <div className="dialog-actions">
          <button type="button" onClick={close}>Close</button>
          <button className="primary" disabled={busy || !port}>Start forward</button>
        </div>
      </form>
    </Dialog>
  );
}

/** The forwards of a saved session, in the session editor: started each time it connects. */
export function ForwardsEditor({ value, onChange }) {
  const rows = value || [];
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="fwd-editor">
      {rows.map((r, i) => (
        <div className="fwd-erow" key={i}>
          <input aria-label="Port on this computer" type="number" min="0" max="65535" placeholder="any" value={r.local_port || ""} onChange={(e) => set(i, "local_port", e.target.value)} />
          <span aria-hidden>→</span>
          <input aria-label="Address on the server" value={r.host ?? "localhost"} onChange={(e) => set(i, "host", e.target.value)} spellCheck={false} />
          <span aria-hidden>:</span>
          <input aria-label="Port on the server" type="number" min="1" max="65535" placeholder="port" value={r.port || ""} onChange={(e) => set(i, "port", e.target.value)} />
          <input aria-label="Name" placeholder="name" value={r.label || ""} onChange={(e) => set(i, "label", e.target.value)} />
          <button type="button" className="icon" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="mini" onClick={() => onChange([...rows, { local_port: "", host: "localhost", port: "", label: "" }])}>Add a forward</button>
    </div>
  );
}

/** A VNC address as the user types it: "5901", ":1" (display 1), "host:5901", "host:1". */
export function parseVnc(text, fallbackHost = "localhost") {
  const s = String(text || "").trim();
  if (!s) return null;
  let host = fallbackHost, p = s;
  const m = /^(.*):(\d+)$/.exec(s);
  if (m) { host = m[1] || fallbackHost; p = m[2]; }
  else if (!/^\d+$/.test(s)) return null;
  let port = Number(p);
  if (s.startsWith(":") || port < 100) port += 5900;      // a display number
  return port > 0 && port < 65536 ? { host, port } : null;
}
