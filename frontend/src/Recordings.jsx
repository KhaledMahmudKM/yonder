import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api.js";
import { THEMES } from "./settings.js";
import { Dialog, useUI } from "./ui.jsx";
import { fmtSize } from "./Files.jsx";

/** Recorded terminal sessions: the list, and a player for .cast recordings. */

export const fmtDuration = (s) => {
  if (s == null) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

export function RecordingsDialog({ close, settings }) {
  const { say, ask } = useUI();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [playing, setPlaying] = useState(null);
  const [q, setQ] = useState("");
  const load = () => api.recordings().then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const remove = async (g) => {
    const v = await ask({ title: `Delete the recording ${g.title}?`, body: `${Object.values(g.files).map((f) => f.name).join(" and ")}, from ${data.folder}.`,
      options: [{ label: "Cancel", value: "no" }, { label: "Delete", value: "yes", kind: "danger" }] });
    if (v !== "yes") return;
    for (const f of Object.values(g.files)) await api.deleteRecording(f.name).catch((e) => say("err", e.message));
    load();
  };
  const openFolder = () => api.openRecordingsFolder().catch((e) => say("err", e.message));

  if (playing) return <Player rec={playing} settings={settings} back={() => setPlaying(null)} close={close} />;
  const f = q.trim().toLowerCase();
  const list = (data?.recordings ?? []).filter((g) => !f || `${g.title} ${g.base}`.toLowerCase().includes(f));
  return (
    <Dialog title="Recordings" className="recordings-dlg" onClose={close}>
      <p className="hint">Terminal sessions you recorded, newest first: <b>.cast</b> replays here (or in asciinema) as it happened;
        <b> .log</b> is plain text for any editor. They're in <code>{data?.folder ?? "…"}</code>.</p>
      <div className="rec-tools">
        <input type="search" placeholder="Find" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a recording" />
        {data?.can_open_folder && <button className="mini" onClick={openFolder}>Open the folder</button>}
      </div>
      {err && <p className="err-text">{err}</p>}
      {data && !data.recordings.length && <p className="hint rec-empty">No recordings yet. Press <b>Record</b> in a terminal's bar to start one,
        or turn on <i>Record every terminal</i> in Settings.</p>}
      {list.length > 0 && (
        <table className="rec-table">
          <thead><tr><th>Session</th><th>Started</th><th className="num">Length</th><th>Files</th><th /></tr></thead>
          <tbody>
            {list.map((g) => (
              <tr key={g.base}>
                <td className="rec-title" title={g.base}>{g.title}</td>
                <td>{new Date((g.started ?? g.mtime) * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</td>
                <td className="num">{fmtDuration(g.duration)}</td>
                <td className="rec-files">
                  {Object.entries(g.files).map(([kind, file]) => (
                    <a key={kind} href={api.recordingUrl(file.name, true)} download title={`Download ${file.name} (${fmtSize(file.size)})`}>.{kind}</a>
                  ))}
                </td>
                <td className="rec-actions">
                  {g.files.cast && <button className="mini primary" onClick={() => setPlaying(g)}>Play</button>}
                  {!g.files.cast && g.files.log && <a className="button mini" href={api.recordingUrl(g.files.log.name)} target="_blank" rel="noreferrer">View</a>}
                  <button className="mini danger" onClick={() => remove(g)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="dialog-actions"><button className="primary" onClick={close}>Close</button></div>
    </Dialog>
  );
}

/** Plays an asciicast v2 recording in a terminal of its own: play, pause, speed, jump, skip idle time. */
function Player({ rec, settings, back, close }) {
  const box = useRef(null);
  const term = useRef(null);
  const [cast, setCast] = useState(null);       // { width, height, events: [[t, type, data]] }
  const [err, setErr] = useState("");
  const [pos, setPos] = useState(0);            // seconds into the recording (after idle-skipping)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [skipIdle, setSkipIdle] = useState(true);
  const st = useRef({ i: 0, t: 0, timer: null, started: 0, from: 0 });

  // load and parse; with skipIdle, pauses longer than 2 s count as 2 s (like asciinema's idle_time_limit)
  useEffect(() => {
    fetch(api.recordingUrl(rec.files.cast.name)).then((r) => r.ok ? r.text() : Promise.reject(new Error(r.statusText))).then((txt) => {
      const lines = txt.split("\n").filter(Boolean);
      const head = JSON.parse(lines[0]);
      const events = [];
      for (const l of lines.slice(1)) { try { const e = JSON.parse(l); if (Array.isArray(e)) events.push(e); } catch { /* a cut-off last line */ } }
      setCast({ width: head.width || 80, height: head.height || 24, title: head.title, events });
    }).catch((e) => setErr(e.message));
  }, [rec]);
  const timeline = useMemo(() => {
    if (!cast) return [];
    let prev = 0, acc = 0;
    return cast.events.map(([t, type, data]) => {
      acc += skipIdle ? Math.min(t - prev, 2) : t - prev;
      prev = t;
      return [acc, type, data];
    });
  }, [cast, skipIdle]);
  const total = timeline.length ? timeline.at(-1)[0] : 0;

  useEffect(() => {
    if (!cast) return;
    const theme = THEMES[settings.theme] ?? THEMES.slate;
    const t = new Terminal({ cols: cast.width, rows: cast.height, fontFamily: settings.fontFamily, fontSize: Math.min(settings.fontSize, 14),
      theme: theme.colors, disableStdin: true, cursorBlink: false, scrollback: 2000, convertEol: false });
    t.open(box.current);
    term.current = t;
    return () => { clearTimeout(st.current.timer); t.dispose(); };
  }, [cast]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** Redraw from the start up to `to` seconds at once (to jump), then go on from there. */
  const seek = (to) => {
    const t = term.current; if (!t) return;
    clearTimeout(st.current.timer);
    t.reset();
    t.resize(cast.width, cast.height);
    let out = "", i = 0;
    for (; i < timeline.length && timeline[i][0] <= to; i++) {
      const [, type, data] = timeline[i];
      if (type === "o") out += data;
      else if (type === "r") { t.write(out); out = ""; const [c, r] = data.split("x").map(Number); if (c && r) t.resize(c, r); }
    }
    t.write(out);
    st.current.i = i;
    st.current.t = to;
    setPos(to);
  };

  const tick = () => {
    const s = st.current;
    const now = s.from + ((performance.now() - s.started) / 1000) * s.speed;
    let out = "";
    while (s.i < timeline.length && timeline[s.i][0] <= now) {
      const [, type, data] = timeline[s.i++];
      if (type === "o") out += data;
      else if (type === "r") { term.current.write(out); out = ""; const [c, r] = data.split("x").map(Number); if (c && r) term.current.resize(c, r); }
    }
    if (out) term.current.write(out);
    s.t = now;
    setPos(Math.min(now, total));
    if (s.i >= timeline.length) { setPlaying(false); return; }
    const next = (timeline[s.i][0] - now) / s.speed * 1000;
    s.timer = setTimeout(tick, Math.max(10, Math.min(next, 250)));
  };

  const play = () => {
    const s = st.current;
    if (s.i >= timeline.length) seek(0);
    s.from = st.current.t; s.started = performance.now(); s.speed = speed;
    setPlaying(true);
    clearTimeout(s.timer);
    s.timer = setTimeout(tick, 0);
  };
  const pause = () => { clearTimeout(st.current.timer); setPlaying(false); };

  // speed or idle-skipping changed while playing: carry on from where it is
  useEffect(() => { if (playing) { st.current.from = st.current.t; st.current.started = performance.now(); st.current.speed = speed; } }, [speed]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (cast && term.current) { pause(); seek(0); } }, [timeline]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (cast && term.current && timeline.length) play(); }, [cast]);   // eslint-disable-line react-hooks/exhaustive-deps

  const keys = (e) => {
    if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
    if (e.key === " ") { e.preventDefault(); playing ? pause() : play(); }
    if (e.key === "ArrowRight") { e.preventDefault(); seek(Math.min(total, pos + 5)); if (playing) play(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); seek(Math.max(0, pos - 5)); if (playing) play(); }
  };

  return (
    <Dialog className="player-dlg" label={`Play ${rec.title}`} onClose={close}>
      <div className="player" onKeyDown={keys} tabIndex={-1}>
        <header>
          <button className="mini" onClick={() => { pause(); back(); }}>← Recordings</button>
          <div className="player-title"><b>{rec.title}</b><small>{new Date((rec.started ?? rec.mtime) * 1000).toLocaleString()}</small></div>
          <a className="button mini" href={api.recordingUrl(rec.files.cast.name, true)} download>Download .cast</a>
          <button className="icon" aria-label="Close" onClick={close}>×</button>
        </header>
        {err && <p className="err-text">{err}</p>}
        <div className="player-screen" style={{ background: (THEMES[settings.theme] ?? THEMES.slate).colors.background }}>
          <div ref={box} />
        </div>
        <footer className="player-controls">
          <button className="primary" onClick={playing ? pause : play} disabled={!cast} aria-label={playing ? "Pause" : "Play"} data-default>
            {playing ? "❚❚" : "▶"}</button>
          <span className="num">{fmtDuration(pos)}</span>
          <input type="range" min="0" max={total || 1} step="0.1" value={pos} aria-label="Position"
            onChange={(e) => { const was = playing; seek(Number(e.target.value)); if (was) play(); }} />
          <span className="num">{fmtDuration(total)}</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
            {[0.5, 1, 1.5, 2, 4, 8].map((x) => <option key={x} value={x}>{x}×</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={skipIdle} onChange={(e) => setSkipIdle(e.target.checked)} /> Skip pauses</label>
        </footer>
        <p className="hint player-keys"><kbd>Space</kbd> play or pause · <kbd>←</kbd> <kbd>→</kbd> 5 seconds back or ahead</p>
      </div>
    </Dialog>
  );
}
