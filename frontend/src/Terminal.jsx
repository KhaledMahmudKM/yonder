import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { api, serverKey, targetLabel } from "./api.js";
import { useConnect } from "./connect.jsx";
import { useUI } from "./ui.jsx";
import { THEMES } from "./settings.js";

/** A terminal tab: xterm.js <-> WebSocket <-> a shell on the server (from DockerLab's console.js).
 *  The shell lives in the backend: closing or reloading the page leaves it running for a while,
 *  and the tab reattaches to it with its screen as it was. */
export default function TermView({ tab, active, settings, patch, onFiles }) {
  const box = useRef(null);
  const x = useRef(null);                 // { term, fit, search }
  const ws = useRef(null);
  const tabRef = useRef(tab); tabRef.current = tab;
  const activeRef = useRef(active); activeRef.current = active;
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const stateRef = useRef("idle");
  const retries = useRef(0);
  const [state, setStateRaw] = useState("idle");     // connecting | ok | dropped | exited | elsewhere | closed
  const [note, setNote] = useState("");
  const [find, setFind] = useState(null);             // search text, or null when the bar is closed
  const [rec, setRec] = useState(null);               // the recording in progress: { files, started }
  const [now, setNow] = useState(Date.now());
  const recRef = useRef(null); recRef.current = rec;
  const connect = useConnect();
  const { ask, say } = useUI();

  const setState = (s, n = "") => { stateRef.current = s; setStateRaw(s); setNote(n); patch({ state: s }); };

  // ---- the terminal itself, once
  useEffect(() => {
    const s = settingsRef.current;
    const term = new Terminal({
      cursorBlink: s.cursorBlink, fontFamily: s.fontFamily, fontSize: s.fontSize, scrollback: s.scrollback,
      theme: THEMES[s.theme]?.colors ?? THEMES.slate.colors, allowProposedApi: true, macOptionIsMeta: true,
    });
    const fit = new FitAddon(), search = new SearchAddon();
    term.loadAddon(fit); term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((e, uri) => { if (e.ctrlKey || e.metaKey) window.open(uri, "_blank", "noopener"); }));
    term.open(box.current);
    x.current = { term, fit, search };

    const enc = new TextEncoder();
    term.onData((d) => {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(enc.encode(d));
      else if (d === "\r" && ["exited", "closed"].includes(stateRef.current)) start("user");
    });
    term.onBinary((d) => {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(Uint8Array.from(d, (c) => c.charCodeAt(0)));
    });
    term.onResize(({ cols, rows }) => {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ resize: [cols, rows] }));
    });
    term.onTitleChange((t) => patch({ osTitle: t }));
    term.onBell(() => { if (!activeRef.current) patch({ bell: true }); });
    term.onSelectionChange(() => { if (settingsRef.current.copyOnSelect && term.hasSelection()) copyText(term.getSelection(), false); });

    // ---- copy and paste: Ctrl+C copies when text is selected (else interrupts, as usual); Ctrl+Shift+C copies;
    // Ctrl+V and Ctrl+Shift+V paste; right-click copies the selection, or pastes when nothing is selected.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.altKey && !e.ctrlKey && (/^[1-9]$/.test(e.key) || e.key === "PageUp" || e.key === "PageDown" || (e.shiftKey && /^[TtWw]$/.test(e.key)))) return false;  // app shortcuts
      if (!e.ctrlKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (k === "c" && (e.shiftKey || term.hasSelection())) { e.preventDefault(); copyText(term.getSelection()); term.clearSelection(); return false; }
      if (k === "v") { e.preventDefault(); paste(); return false; }
      if (k === "f" && e.shiftKey) { e.preventDefault(); setFind((f) => f ?? (term.getSelection() || "")); return false; }
      return true;
    });
    const onCtx = (e) => {
      e.preventDefault();
      if (term.hasSelection()) { copyText(term.getSelection()); term.clearSelection(); } else paste();
      term.focus();
    };
    box.current.addEventListener("contextmenu", onCtx);

    // fit whenever the box changes size, while it's visible
    const ro = new ResizeObserver(() => { if (box.current?.offsetParent) try { fit.fit(); } catch { /* not laid out */ } });
    ro.observe(box.current);

    start(tabRef.current.termId ? "auto" : "new");
    return () => {
      ro.disconnect();
      const w = ws.current; ws.current = null;
      if (w) { w.onclose = null; w.close(); }
      term.dispose();
    };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- settings, live
  useEffect(() => {
    const t = x.current?.term; if (!t) return;
    t.options.fontSize = settings.fontSize;
    t.options.fontFamily = settings.fontFamily;
    t.options.cursorBlink = settings.cursorBlink;
    t.options.scrollback = settings.scrollback;
    t.options.theme = THEMES[settings.theme]?.colors ?? THEMES.slate.colors;
    if (box.current?.offsetParent) try { x.current.fit.fit(); } catch { /* */ }
  }, [settings]);

  // ---- the keyboard back after a dialog or menu closes, or a click on this tab
  useEffect(() => {
    const back = () => {
      if (!activeRef.current || document.querySelector(".scrim, .ctx-menu") || !x.current) return;
      const a = document.activeElement;
      if (a && a !== document.body && !a.closest(".tabbar, .termview") ) return;   // the user is typing somewhere else
      if (a?.closest(".term-find")) return;
      x.current.term.focus();
    };
    window.addEventListener("yonder-refocus", back);
    return () => window.removeEventListener("yonder-refocus", back);
  }, []);

  // ---- shown: fit and focus
  useEffect(() => {
    if (!active || !x.current) return;
    requestAnimationFrame(() => {
      try { x.current.fit.fit(); } catch { /* */ }
      if (find == null) x.current.term.focus();
    });
    if (tab.bell || tab.activity) patch({ bell: false, activity: false });
  }, [active]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- clipboard
  const copyText = async (text, say = true) => {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); if (say) flash("Copied"); }
    catch { flash("Couldn't copy: the browser blocked it"); }
  };
  const paste = async () => {
    let text;
    try { text = await navigator.clipboard.readText(); } catch { flash("Paste blocked by the browser"); return; }
    if (!text) return;
    if (settingsRef.current.confirmPaste && /\r|\n/.test(text.trimEnd())) {
      const lines = text.trimEnd().split(/\r?\n/).length;
      const v = await ask({ title: `Paste ${lines} lines?`, body: `Each line runs as a command as soon as it's pasted:\n${text.slice(0, 300)}${text.length > 300 ? "…" : ""}`,
        options: [{ label: "Paste", value: "yes" }, { label: "Cancel", value: "no" }] });
      x.current?.term.focus();
      if (v !== "yes") return;
    }
    x.current?.term.paste(text);
  };
  const flashTimer = useRef(null);
  const [flashText, setFlashText] = useState("");
  const flash = (t) => { setFlashText(t); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlashText(""), 1400); };

  // ---- connecting
  function attach(id) {
    return new Promise((resolve) => {
      const term = x.current.term;
      const w = new WebSocket(api.termSocketUrl(id));
      w.binaryType = "arraybuffer";
      ws.current = w;
      let first = true;
      w.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const m = JSON.parse(ev.data);
          if (m.gone) { first = false; w.onclose = null; ws.current = null; resolve("gone"); return; }
          if (m.attached) {
            first = false; retries.current = 0;
            setRec(m.recording || null); patch({ recording: !!m.recording });
            term.reset();                                       // the replay that follows redraws the screen
            setState("ok");
            w.send(JSON.stringify({ resize: [term.cols, term.rows] }));
            resolve(true);
          }
          if ("exit" in m) { w.onclose = null; ws.current = null; ended(m.exit); }
          if (m.detached) { w.onclose = null; ws.current = null; setState("elsewhere", "This terminal is open in another tab or window."); }
          if (m.error) term.writeln(`\r\n\x1b[31m${m.error}\x1b[0m`);
          return;
        }
        term.write(new Uint8Array(ev.data));
        if (!activeRef.current && !tabRef.current.activity) patch({ activity: true });
      };
      w.onclose = (ev) => {
        ws.current = null;
        if (first) { resolve(false); if (ev.code === 4401) window.dispatchEvent(new Event("yonder-signin")); return; }
        dropped();
      };
    });
  }

  function ended(status) {
    if (recRef.current) { say("ok", "Recording saved.", null, { label: "Show recordings", onClick: () => window.dispatchEvent(new Event("yonder-recordings")) }); }
    setRec(null); patch({ recording: false });
    setState("exited");
    x.current.term.writeln(`\r\n\x1b[90m[session ended${status != null && status !== 0 ? ` with status ${status}` : ""}: press Enter for a new one]\x1b[0m`);
    patch({ termId: null });
  }

  function dropped() {
    // the shell is probably still running in Yonder: try to reattach, a few times
    const id = tabRef.current.termId;
    if (!id || retries.current >= 6) { setState("closed", "Lost the connection to Yonder."); return; }
    setState("dropped", "Connection lost, reconnecting…");
    const wait = Math.min(8000, 500 * 2 ** retries.current++);
    setTimeout(async () => {
      if (stateRef.current !== "dropped") return;
      const r = await attach(id);
      if (r === "gone") { patch({ termId: null }); setState("closed", "The session ended while the connection was lost."); }
      else if (r !== true) {
        if (retries.current < 6) dropped();
        else setState("closed", "Can't reach Yonder. Is it still running?");
      }
    }, wait);
  }

  /** mode: "new" (a new tab: may ask to log in), "user" (Reconnect pressed: may ask), "auto" (restoring: doesn't ask). */
  async function start(mode) {
    const term = x.current?.term; if (!term) return;
    const t = tabRef.current;
    setState("connecting");
    if (t.termId) {
      if ((await attach(t.termId)) === true) return;
      patch({ termId: null });
      if (mode === "auto") term.writeln("\x1b[90m[the previous session has ended]\x1b[0m");
    }
    const key = serverKey(t.target);
    for (let round = 0; round < 2; round++) {
      try {
        try { x.current.fit.fit(); } catch { /* hidden */ }
        const r = await api.openTerm(key, term.cols, term.rows, tabRef.current.cwd || null);
        patch({ termId: r.id, cwd: null });
        tabRef.current = { ...tabRef.current, termId: r.id };
        if ((await attach(r.id)) !== true) setState("closed", "The session ended right away.");
        return;
      } catch (e) {
        if (e.need && round === 0) {
          if (mode === "auto") { setState("closed", `Not connected to ${targetLabel(t.target)}.`); return; }
          const s = await connect(t.target);
          if (!s) { setState("closed", "Not connected."); return; }
          continue;
        }
        setState("closed", e.message);
        term.writeln(`\r\n\x1b[31m${e.message}\x1b[0m`);
        return;
      }
    }
  }

  // ---- recording (done by Yonder, so it goes on through a page reload) and saving the text
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [rec]);
  const toggleRecord = async () => {
    const id = tabRef.current.termId;
    if (!id) return;
    try {
      if (rec) {
        const r = await api.stopRecord(id);
        setRec(null); patch({ recording: false });
        say("ok", `Recording saved: ${r.files.join(" and ")}.`, null,
          { label: "Show recordings", onClick: () => window.dispatchEvent(new Event("yonder-recordings")) });
      } else {
        const r = await api.startRecord(id);
        setRec(r); patch({ recording: true });
      }
    } catch (e) { say("err", e.message); }
    x.current?.term.focus();
  };
  const saveText = () => {
    const t = x.current?.term; if (!t) return;
    const b = t.buffer.active, lines = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && !lines.at(-1)) lines.pop();
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
    const a = document.createElement("a");
    const when = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
    a.href = URL.createObjectURL(blob);
    a.download = `${targetLabel(tabRef.current.target).replace(/[^\w@.-]+/g, "_")}_${when}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash(`Saved ${lines.length} lines`);
    t.focus();
  };
  const recFor = rec ? Math.max(0, Math.round(now / 1000 - rec.started)) : 0;

  // ---- search in the scrollback
  const findNext = (back = false) => {
    if (!find) return;
    const opts = { caseSensitive: false, decorations: { matchOverviewRuler: "#E8B10E", activeMatchColorOverviewRuler: "#E8B10E", matchBackground: "#5C4A12", activeMatchBackground: "#E8B10E" } };
    const found = back ? x.current.search.findPrevious(find, opts) : x.current.search.findNext(find, opts);
    if (!found) flash("Not found");
  };
  const closeFind = () => { setFind(null); x.current.search.clearDecorations(); x.current.term.focus(); };

  const theme = THEMES[settings.theme] ?? THEMES.slate;
  const busy = state === "connecting" || state === "dropped";
  return (
    <div className={`termview ${active ? "" : "is-hidden"}`} style={{ "--term-bg": theme.colors.background, "--term-fg": theme.colors.foreground }}
      data-dark={theme.dark ? "1" : "0"}>
      <div className="term-bar">
        <span className={`dot is-${state}`} aria-hidden />
        <span className="term-where">{targetLabel(tab.target)}</span>
        <span className="term-note">{flashText || note || (state === "ok" ? "" : state === "connecting" ? "Connecting…" : "")}</span>
        <span className="spacer" />
        {find != null && (
          <form className="term-find" onSubmit={(e) => { e.preventDefault(); findNext(); }}
            onKeyDown={(e) => { if (e.key === "Escape") closeFind(); if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); findNext(true); } }}>
            <input autoFocus value={find} placeholder="Find" aria-label="Find in the terminal" onChange={(e) => setFind(e.target.value)} />
            <button type="button" className="mini" onClick={() => findNext(true)} title="Previous (Shift+Enter)">↑</button>
            <button type="submit" className="mini" title="Next (Enter)">↓</button>
            <button type="button" className="mini" onClick={closeFind} title="Close (Esc)">×</button>
          </form>
        )}
        {find == null && <button className="mini ghost" onClick={() => setFind(x.current?.term.getSelection() || "")} title="Find in the scrollback (Ctrl+Shift+F)">Find</button>}
        <button className="mini ghost" onClick={saveText} disabled={state === "connecting"}
          title="Save what the terminal shows, with its scrollback, as a text file">Save text</button>
        <button className={`mini ${rec ? "rec-on" : "ghost"}`} onClick={toggleRecord} disabled={!tab.termId || state !== "ok"}
          title={rec ? `Recording into ${rec.files.join(" and ")}: click to stop` : "Record this session from now on (output only, not the keys you press)"}>
          {rec ? <><span className="rec-dot" aria-hidden /> {String(Math.floor(recFor / 60)).padStart(2, "0")}:{String(recFor % 60).padStart(2, "0")} Stop</> : "Record"}</button>
        <button className="mini ghost" onClick={() => onFiles(tab)} title="Open this server's files in a new tab">Files</button>
        {state === "elsewhere" && <button className="mini" onClick={() => start("user")}>Bring it here</button>}
        {(state === "closed" || state === "exited") && <button className="mini primary" onClick={() => start("user")}>
          {state === "exited" ? "New session" : "Reconnect"}</button>}
      </div>
      <div className={`term-box${busy ? " is-busy" : ""}`} ref={box} />
    </div>
  );
}
