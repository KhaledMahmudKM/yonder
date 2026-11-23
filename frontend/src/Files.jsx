import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, serverKey, targetFromKey, targetLabel } from "./api.js";
import { useConnect } from "./connect.jsx";
import { Dialog, plural, useUI } from "./ui.jsx";

/** A file-browser tab: two panes, like WinSCP (from DockerLab's Files.jsx). Each pane shows this
 *  computer or any connected server; copy or move between them with the buttons, F5/F6, or by
 *  dragging (server A to server B works too); drop files from Explorer onto a pane to upload them. */

const DND = "application/x-yonder-files";
const SIDES = ["left", "right"];

export const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB`
  : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const fmtTime = (t) => (t ? new Date(t * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "");

export default function FilesView({ tab, active, patch, servers, sessions, onTerminalHere }) {
  const { say, ask, askText } = useUI();
  const connect = useConnect();
  const [pc, setPc] = useState(null);
  const init = tab.panes || {};
  const fresh = (p) => ({ loc: p?.loc || "pc", path: p?.path || "", data: null, err: "", need: null, sel: [], anchor: null, sort: ["name", 1] });
  const [panes, setPanes] = useState({ left: fresh(init.left), right: fresh(init.right) });
  const [focus, setFocus] = useState(init.focus || "right");
  const [jobs, setJobs] = useState([]);
  const [editing, setEditing] = useState(null);         // { loc, path, where }
  const [chmod, setChmod] = useState(null);             // { side, names, perm }
  const panesRef = useRef(panes); panesRef.current = panes;

  const patchPane = (side, p) => setPanes((ps) => ({ ...ps, [side]: { ...ps[side], ...(typeof p === "function" ? p(ps[side]) : p) } }));

  /** Where a location is, for messages. */
  const label = useCallback((loc) => {
    if (loc === "pc") return "this computer";
    const k = loc.slice(2);
    const s = servers.find((x) => x.key === k);
    return s?.label || (tab.target && serverKey(tab.target) === k ? targetLabel(tab.target) : k);
  }, [servers, tab.target]);

  /** The target to connect to for a server location (the tab's, a saved session's, or from its key). */
  const targetFor = useCallback((loc) => {
    const k = loc.slice(2);
    if (tab.target && serverKey(tab.target) === k) return tab.target;
    const s = sessions.find((x) => serverKey(x) === k);
    if (s) return { host: s.host, port: s.port, user: s.user, key_file: s.key_file, name: s.name, sessionId: s.id };
    return targetFromKey(k);
  }, [sessions, tab.target]);

  const go = useCallback(async (side, loc, path, keepSel = false, interactive = false) => {
    patchPane(side, { loading: true });
    try {
      const data = await api.filesList(loc, path);
      patchPane(side, (p) => ({ loc, path: data.path, data, err: "", need: null, loading: false,
        sel: keepSel ? p.sel.filter((n) => data.entries.some((e) => e.name === n)) : [], anchor: keepSel ? p.anchor : null }));
    } catch (e) {
      if (e.need && interactive) {
        patchPane(side, { loading: false });
        const s = await connect(targetFor(loc));
        if (s) return go(side, loc, path, keepSel, false);
      }
      patchPane(side, (p) => ({ loc, path, loading: false, err: e.message, need: e.need || null, data: p.loc === loc ? p.data : null }));
    }
  }, [connect, targetFor]);

  // remember where each pane is, in the tab (so a reload comes back here)
  useEffect(() => {
    patch({ panes: { left: { loc: panes.left.loc, path: panes.left.data?.path ?? panes.left.path },
      right: { loc: panes.right.loc, path: panes.right.data?.path ?? panes.right.path }, focus } });
  }, [panes.left.loc, panes.left.data?.path, panes.right.loc, panes.right.data?.path, focus]);   // eslint-disable-line react-hooks/exhaustive-deps

  // first load
  useEffect(() => {
    api.filesPlaces().then((p) => setPc(p.pc)).catch(() => {});
    for (const side of SIDES) { const p = panesRef.current[side]; go(side, p.loc, p.path, false, tab.fresh && p.loc !== "pc"); }
    if (tab.fresh) patch({ fresh: false });
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = (side, keepSel = true) => { const p = panesRef.current[side]; return go(side, p.loc, p.data?.path ?? p.path, keepSel); };
  const refreshLoc = (loc) => SIDES.forEach((s) => panesRef.current[s].loc === loc && refresh(s));

  // ---- transfers: poll the server's copy jobs while any of ours runs
  const running = jobs.some((j) => j.state === "running" && !j.upload);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const all = await api.filesJobs().catch(() => null);
      if (!all) return;
      setJobs((js) => js.map((j) => {
        if (j.upload) return j;
        const n = all.find((x) => x.id === j.id);
        if (!n) return j;
        if (j.state === "running" && n.state !== "running") {
          const errs = n.errors.filter((x) => !x.endsWith("skipped"));
          const skipped = n.errors.length - errs.length;
          const copied = n.files_done - skipped;
          if (n.state === "done" && !copied && skipped) say("info", `Nothing ${j.verb.toLowerCase()} to ${j.to}: ${skipped === 1 ? "the item is" : `all ${skipped} items are`} already there, so ${skipped === 1 ? "it was" : "they were"} skipped.`);
          else if (n.state === "done") say("ok", `${j.verb} ${j.what}${n.total_bytes ? ` (${fmtSize(n.total_bytes)})` : ""} to ${j.to}.` + (skipped ? ` ${skipped} already there, skipped.` : ""));
          else if (n.state === "cancelled") say("info", `${j.verb === "Moved" ? "Move" : "Copy"} to ${j.to} cancelled.`);
          else say("err", `${j.verb === "Moved" ? "Move" : "Copy"} to ${j.to} failed for ${plural(errs.length, "item")}.`, errs);
          refreshLoc(j.dst); if (j.verb === "Moved") refreshLoc(j.src);
        }
        return { ...j, ...n };
      }));
    }, 500);
    return () => clearInterval(t);
  }, [running]);   // eslint-disable-line react-hooks/exhaustive-deps

  const other = (side) => (side === "left" ? "right" : "left");

  /** Copy (or move) names from one pane's folder into a folder of the other pane (or the same). */
  const transfer = async (fromSide, names, move = false, toSide = other(fromSide), toDir = null) => {
    const from = panesRef.current[fromSide], to = panesRef.current[toSide];
    if (!names.length || !from.data || !to.data) return;
    const dstDir = toDir ?? to.data.path;
    if (from.loc === to.loc && from.data.path === dstDir) { say("info", "That's the folder they're already in."); return; }
    let overwrite = false;
    try {
      const { exists } = await api.filesExists(to.loc, dstDir, names);
      if (exists.length) {
        const v = await ask({ title: `${plural(exists.length, "item")} already there`,
          body: `${exists.slice(0, 6).join(", ")}${exists.length > 6 ? ", …" : ""} already exist${exists.length === 1 ? "s" : ""} in ${dstDir} on ${label(to.loc)}. Folders are merged either way; for files that exist in both:`,
          options: [{ label: "Skip them", value: "skip" }, { label: "Replace them", value: "replace", kind: "danger" }, { label: "Cancel", value: "cancel" }] });
        if (v === "cancel" || !v) return;
        overwrite = v === "replace";
      }
      const job = await api.filesCopy({ src: from.loc, src_dir: from.data.path, names, dst: to.loc, dst_dir: dstDir, move, overwrite });
      setJobs((js) => [{ ...job, verb: move ? "Moved" : "Copied", to: `${dstDir} on ${label(to.loc)}`, dst: to.loc, src: from.loc,
        what: names.length === 1 ? names[0] : plural(names.length, "item") }, ...js].slice(0, 12));
    } catch (e) { say("err", e.message); }
  };

  // ---- uploads from Explorer (or the Upload button): one request per file, with progress
  const upload = async (side, items, dir = null) => {
    const p = panesRef.current[side];
    if (!p.data || !items.length) return;
    const target = dir ?? p.data.path;
    const total = items.reduce((n, it) => n + it.file.size, 0);
    const id = `up-${Date.now()}`;
    const job = { id, upload: true, state: "running", what: items.length === 1 ? items[0].rel : plural(items.length, "file"),
      to: `${target} on ${label(p.loc)}`, total_bytes: total, done_bytes: 0, files_total: items.length, files_done: 0, current: "" };
    setJobs((js) => [job, ...js].slice(0, 12));
    const set = (x) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...x } : j)));
    let done = 0;
    const failed = [];
    for (const [i, it] of items.entries()) {
      set({ current: it.rel, files_done: i });
      try {
        await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open("PUT", api.filesUploadUrl(p.loc, target, it.rel));
          x.upload.onprogress = (e) => set({ done_bytes: done + e.loaded });
          x.onload = () => (x.status < 300 ? resolve() : reject(new Error((() => { try { return JSON.parse(x.responseText).detail; } catch { return x.statusText; } })())));
          x.onerror = () => reject(new Error("the connection to Yonder failed"));
          x.send(it.file);
        });
      } catch (e) { failed.push(`${it.rel}: ${e.message}`); }
      done += it.file.size;
      set({ done_bytes: done });
    }
    set({ state: failed.length ? "failed" : "done", files_done: items.length - failed.length, current: "" });
    if (failed.length) say("err", `Upload to ${job.to}: ${plural(failed.length, "file")} failed.`, failed);
    else say("ok", `Uploaded ${job.what} (${fmtSize(total)}) to ${job.to}.`);
    refresh(side);
  };

  /** Files dropped from Explorer, with folders: walk them (webkitGetAsEntry) for relative paths. */
  const droppedFiles = async (dt) => {
    const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...dt.files].map((f) => ({ file: f, rel: f.name }));
    const out = [];
    const walk = async (e, prefix) => {
      if (e.isFile) out.push({ file: await new Promise((res, rej) => e.file(res, rej)), rel: prefix + e.name });
      else if (e.isDirectory) {
        const r = e.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => r.readEntries(res, rej));
          if (!batch.length) break;
          for (const c of batch) await walk(c, `${prefix}${e.name}/`);
        }
      }
    };
    for (const e of entries) await walk(e, "");
    return out;
  };

  // ---- actions on a pane
  const mkdir = async (side) => {
    const p = panesRef.current[side];
    const name = (await askText("New folder", `In ${p.data.path}`, "", "Create"))?.trim();
    if (!name) return;
    try {
      await api.filesMkdir(p.loc, joinPath(p, name));
      await refresh(side);
      patchPane(side, { sel: [name], anchor: name });
    } catch (e) { say("err", e.message); }
  };

  const newFile = async (side) => {
    const p = panesRef.current[side];
    const name = (await askText("New text file", `In ${p.data.path}`, "", "Create and edit"))?.trim();
    if (!name) return;
    try {
      const { exists } = await api.filesExists(p.loc, p.data.path, [name]);
      if (!exists.length) await api.filesSaveText(p.loc, joinPath(p, name), "");
      await refresh(side);
      patchPane(side, { sel: [name], anchor: name });
      setEditing({ loc: p.loc, path: joinPath(p, name), where: label(p.loc), side });
    } catch (e) { say("err", e.message); }
  };

  const rename = async (side) => {
    const p = panesRef.current[side];
    if (p.sel.length !== 1) return;
    const old = p.sel[0];
    const name = (await askText("Rename", `New name for ${old}`, old, "Rename"))?.trim();
    if (!name || name === old) return;
    try {
      await api.filesRename(p.loc, joinPath(p, old), name);
      await refresh(side);
      patchPane(side, { sel: [name], anchor: name });
    } catch (e) { say("err", e.message); }
  };

  const remove = async (side) => {
    const p = panesRef.current[side];
    if (!p.sel.length) return;
    const dirs = p.data.entries.filter((e) => p.sel.includes(e.name) && e.type === "dir").length;
    const what = p.sel.length === 1 ? p.sel[0] : plural(p.sel.length, "item");
    const v = await ask({ title: `Delete ${what}?`,
      body: `From ${p.data.path} on ${label(p.loc)}.${dirs ? " Folders are deleted with everything in them." : ""} There's no recycle bin.`,
      options: [{ label: "Cancel", value: "no" }, { label: "Delete", value: "yes", kind: "danger" }] });
    if (v !== "yes") return;
    try {
      await api.filesDelete(p.loc, p.data.path, p.sel);
      say("ok", `Deleted ${what} from ${p.data.path} on ${label(p.loc)}.`);
      refresh(side, false);
    } catch (e) { say("err", e.message); refresh(side); }
  };

  const download = (side) => {
    const p = panesRef.current[side];
    if (!p.sel.length) return;
    const a = document.createElement("a");
    a.href = api.filesDownloadUrl(p.loc, p.data.path, p.sel);
    a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
  };

  const edit = (side) => {
    const p = panesRef.current[side];
    const e = p.sel.length === 1 && p.data.entries.find((x) => x.name === p.sel[0]);
    if (!e || e.type !== "file") return;
    setEditing({ loc: p.loc, path: joinPath(p, e.name), where: label(p.loc), side });
  };

  const perms = (side) => {
    const p = panesRef.current[side];
    if (!p.sel.length) return;
    const first = p.data.entries.find((x) => x.name === p.sel[0]);
    setChmod({ side, names: [...p.sel], perm: first?.perm ?? 0o644, where: `${p.data.path} on ${label(p.loc)}` });
  };

  const terminalHere = (side, dirName = null) => {
    const p = panesRef.current[side];
    if (!p.loc.startsWith("s:") || !p.data) return;
    onTerminalHere(targetFor(p.loc), dirName ? joinPath(p, dirName) : p.data.path);
  };

  const openEntry = (side, e) => {
    const p = panesRef.current[side];
    if (e.type === "dir") go(side, p.loc, joinPath(p, e.name));
    else { patchPane(side, { sel: [e.name], anchor: e.name }); setTimeout(() => edit(side), 0); }
  };

  const up = (side) => { const p = panesRef.current[side]; if (p.data?.parent != null) go(side, p.loc, p.data.parent); };

  const choose = async (side, value) => {
    if (value.startsWith("connect:")) {
      const s = sessions.find((x) => x.id === value.slice(8));
      if (!s) return;
      const srv = await connect({ host: s.host, port: s.port, user: s.user, key_file: s.key_file, name: s.name, sessionId: s.id });
      if (srv) go(side, `s:${srv.key}`, s.remote_dir || "");
      return;
    }
    go(side, value, "", false, true);
  };

  const act = { transfer, upload, mkdir, newFile, rename, remove, download, edit, perms, terminalHere, openEntry, up, go, refresh, droppedFiles, choose };

  return (
    <div className={`files${active ? "" : " is-hidden"}`}>
      <div className="files-panes">
        {SIDES.map((side) => (
          <Pane key={side} side={side} pane={panes[side]} pc={pc} servers={servers} sessions={sessions} active={focus === side}
            onFocus={() => setFocus(side)} patch={(x) => patchPane(side, x)} act={act}
            otherLabel={label(panes[other(side)].loc)} label={label} />
        ))}
      </div>
      <Transfers jobs={jobs} setJobs={setJobs} />
      {editing && <Editor file={editing} close={(saved) => { setEditing(null); if (saved) refresh(editing.side); }} />}
      {chmod && <ChmodDialog c={chmod} close={async (perm) => {
        setChmod(null);
        if (perm == null) return;
        const p = panesRef.current[chmod.side];
        try { await api.filesChmod(p.loc, p.data.path, chmod.names, perm); refresh(chmod.side); say("ok", `Permissions of ${chmod.names.length === 1 ? chmod.names[0] : plural(chmod.names.length, "item")} set to ${perm.toString(8).padStart(3, "0")}.`); }
        catch (e) { say("err", e.message); }
      }} />}
    </div>
  );
}

const joinPath = (p, name) => {
  const base = p.data.path;
  if (p.loc === "pc" && (/^[A-Za-z]:\\/.test(base) || base === "")) return base ? (base.endsWith("\\") ? base + name : `${base}\\${name}`) : name;
  return base.endsWith("/") ? base + name : `${base}/${name}`;
};

// ======================================================================= one pane
function Pane({ side, pane, pc, servers, sessions, active, onFocus, patch, act, otherLabel, label }) {
  const { loc, data, err, need, sel, sort, loading } = pane;
  const { openMenu } = useUI();
  const [pathText, setPathText] = useState("");
  const [filter, setFilter] = useState("");
  const [dropHere, setDropHere] = useState(null);       // "pane" | entry name, while dragging over
  const fileInput = useRef(null);
  const listRef = useRef(null);
  useEffect(() => { setPathText(data?.path ?? pane.path ?? ""); setFilter(""); }, [data?.path]);   // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => {
    const f = filter.toLowerCase();
    const es = (data?.entries ?? []).filter((e) => !f || e.name.toLowerCase().includes(f));
    const [k, d] = sort;
    es.sort((a, b) => (a.type === "dir") !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1)
      : k === "size" ? (a.size - b.size) * d : k === "mtime" ? (a.mtime - b.mtime) * d
      : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * d);
    return es;
  }, [data, sort, filter]);

  const selSet = new Set(sel);
  const selSize = entries.filter((e) => selSet.has(e.name) && e.type === "file").reduce((n, e) => n + e.size, 0);
  const one = sel.length === 1 ? entries.find((e) => e.name === sel[0]) : null;
  const isServer = loc.startsWith("s:");

  const click = (e, ev) => {
    onFocus();
    if (ev.shiftKey && pane.anchor) {
      const names = entries.map((x) => x.name);
      const [a, b] = [names.indexOf(pane.anchor), names.indexOf(e.name)].sort((x, y) => x - y);
      patch({ sel: names.slice(a, b + 1) });
    } else if (ev.ctrlKey || ev.metaKey) {
      patch({ sel: selSet.has(e.name) ? sel.filter((n) => n !== e.name) : [...sel, e.name], anchor: e.name });
    } else patch({ sel: [e.name], anchor: e.name });
  };

  const key = (ev) => {
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT") return;
    const k = ev.key;
    const move = (delta) => {
      const names = entries.map((x) => x.name);
      const i = Math.max(-1, names.indexOf(pane.anchor ?? sel.at(-1)));
      const n = names[Math.min(names.length - 1, Math.max(0, i + delta))];
      if (n) { patch({ sel: [n], anchor: n }); listRef.current?.querySelector(`[data-name="${CSS.escape(n)}"]`)?.scrollIntoView({ block: "nearest" }); }
    };
    const handled = {
      Enter: () => one && act.openEntry(side, one), Backspace: () => act.up(side), Delete: () => act.remove(side),
      F2: () => act.rename(side), F4: () => act.edit(side), F5: () => act.transfer(side, sel), F6: () => act.transfer(side, sel, true),
      F7: () => act.mkdir(side), ArrowDown: () => move(1), ArrowUp: () => move(-1),
      a: () => patch({ sel: entries.map((e) => e.name) }),
      r: () => act.refresh(side),
    }[k];
    if (handled && ((k !== "a" && k !== "r") || ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); handled(); }
  };

  const connected = servers;                  // logged in (a dropped connection comes back by itself)
  const keys = new Set(connected.map((s) => s.key));
  const offline = sessions.filter((s) => !keys.has(serverKey(s)));
  const known = loc === "pc" || connected.some((s) => `s:${s.key}` === loc);

  // ---- drag and drop
  const isOurs = (ev) => [...ev.dataTransfer.types].includes(DND);
  const over = (ev, target) => {
    if (!isOurs(ev) && ![...ev.dataTransfer.types].includes("Files")) return;
    ev.preventDefault(); ev.stopPropagation();
    ev.dataTransfer.dropEffect = isOurs(ev) && ev.shiftKey ? "move" : "copy";
    setDropHere(target);
  };
  const drop = async (ev, dir) => {
    ev.preventDefault(); ev.stopPropagation(); setDropHere(null); onFocus();
    if (!data) return;
    const targetDir = dir ? joinPath(pane, dir) : null;
    if (isOurs(ev)) {
      const { side: from, names } = JSON.parse(ev.dataTransfer.getData(DND));
      if (from === side && !dir) return;
      act.transfer(from, names, ev.shiftKey, side, targetDir);
    } else if (ev.dataTransfer.files?.length || ev.dataTransfer.items?.length) {
      act.upload(side, await act.droppedFiles(ev.dataTransfer), targetDir);
    }
  };

  const rowMenu = (ev, e) => {
    onFocus();
    if (!selSet.has(e.name)) patch({ sel: [e.name], anchor: e.name });
    const many = selSet.has(e.name) && sel.length > 1;
    openMenu(ev, [
      e.type === "dir" ? { label: "Open", onClick: () => act.openEntry(side, e) } : { label: "Edit", hint: "F4", onClick: () => act.edit(side), disabled: many },
      { label: `Copy to ${otherLabel}`, hint: "F5", onClick: () => act.transfer(side, many ? sel : [e.name]) },
      { label: `Move to ${otherLabel}`, hint: "F6", onClick: () => act.transfer(side, many ? sel : [e.name], true) },
      { label: "Download", onClick: () => act.download(side) },
      "-",
      { label: "Rename", hint: "F2", onClick: () => act.rename(side), disabled: many },
      { label: "Permissions…", onClick: () => act.perms(side) },
      isServer && e.type === "dir" && !many && { label: "Open a terminal here", onClick: () => act.terminalHere(side, e.name) },
      "-",
      { label: "Delete", hint: "Del", danger: true, onClick: () => act.remove(side) },
    ]);
  };

  const sortBy = (k) => patch({ sort: [k, sort[0] === k ? -sort[1] : 1] });
  const arrow = (k) => (sort[0] === k ? (sort[1] > 0 ? " ▲" : " ▼") : "");
  const placeLabel = loc === "pc" ? (pc?.label ?? "This computer") : label(loc);

  return (
    <section className={`files-pane${active ? " is-active" : ""}${dropHere === "pane" ? " is-drop" : ""}`}
      onMouseDown={onFocus} onKeyDown={key} tabIndex={0} aria-label={`${side} pane: ${placeLabel}`}
      onDragOver={(e) => over(e, "pane")} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setDropHere(null)}
      onDrop={(e) => drop(e, null)}>
      <div className="files-loc">
        <span className={`loc-dot ${loc === "pc" ? "is-pc" : keys.has(loc.slice(2)) && !need ? "is-on" : "is-off"}`} aria-hidden />
        <select aria-label="Location" value={known ? loc : ""} onChange={(e) => act.choose(side, e.target.value)}>
          {!known && <option value="">{placeLabel}{need ? " (not connected)" : ""}</option>}
          {!pc?.hidden && <option value="pc">{pc?.label ?? "This computer"}</option>}
          {connected.length > 0 && <optgroup label="Connected">
            {connected.map((s) => <option key={s.key} value={`s:${s.key}`}>{s.label}</option>)}
          </optgroup>}
          {offline.length > 0 && <optgroup label="Saved sessions: connect to">
            {offline.map((s) => <option key={s.id} value={`connect:${s.id}`}>{s.folder ? `${s.folder} / ` : ""}{s.name}</option>)}
          </optgroup>}
        </select>
        <button className="mini" title="Up one folder (Backspace)" disabled={data?.parent == null} onClick={() => act.up(side)}>↑</button>
        <button className="mini" title="Home folder" onClick={() => act.go(side, loc, "", false, true)}>⌂</button>
        <button className="mini" title="Refresh (Ctrl+R)" onClick={() => act.refresh(side)}>⟳</button>
      </div>
      <form className="files-path" onSubmit={(e) => { e.preventDefault(); act.go(side, loc, pathText, false, true); }}>
        <input aria-label="Path" value={pathText} onChange={(e) => setPathText(e.target.value)} spellCheck={false} />
        <input className="files-filter" aria-label="Filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </form>
      <div className="files-tools">
        <button className="mini primary" disabled={!sel.length} onClick={() => act.transfer(side, sel)}
          title={`Copy the selection to ${otherLabel}, into the folder open in the other pane (F5)`}>
          {side === "left" ? "Copy →" : "← Copy"}</button>
        <button className="mini" disabled={!sel.length} onClick={() => act.transfer(side, sel, true)} title={`Move to ${otherLabel} (F6)`}>
          {side === "left" ? "Move →" : "← Move"}</button>
        <span className="sep" />
        <button className="mini" disabled={!one || one.type !== "file"} onClick={() => act.edit(side)} title="Edit the text file (F4)">Edit</button>
        <button className="mini" disabled={sel.length !== 1} onClick={() => act.rename(side)} title="Rename (F2)">Rename</button>
        <button className="mini danger" disabled={!sel.length} onClick={() => act.remove(side)} title="Delete (Del)">Delete</button>
        <span className="sep" />
        <button className="mini" onClick={() => act.mkdir(side)} disabled={!data} title="New folder (F7)">New folder</button>
        <button className="mini" onClick={() => act.newFile(side)} disabled={!data} title="New text file">New file</button>
        <span className="sep" />
        <button className="mini" disabled={!sel.length} onClick={() => act.download(side)}
          title="Download to your browser's Downloads folder (several items, or a folder, as a .zip)">Download</button>
        <button className="mini" disabled={!data} onClick={() => fileInput.current?.click()} title="Upload files into this folder (or drop them here from Explorer)">Upload…</button>
        <input ref={fileInput} type="file" multiple hidden
          onChange={(e) => { act.upload(side, [...e.target.files].map((f) => ({ file: f, rel: f.name }))); e.target.value = ""; }} />
        {isServer && <button className="mini ghost" disabled={!data} onClick={() => act.terminalHere(side, null)} title="Open a terminal in this folder">Terminal here</button>}
      </div>
      {err && (
        <div className="files-err" role="alert">
          <span>{err}</span>
          {need && <button className="mini primary" onClick={() => act.go(side, loc, pane.path || data?.path || "", false, true)}>Connect</button>}
        </div>
      )}
      <div className="files-list" ref={listRef}>
        <table>
          <thead>
            <tr>
              <th onClick={() => sortBy("name")}>Name{arrow("name")}</th>
              <th className="num" onClick={() => sortBy("size")}>Size{arrow("size")}</th>
              <th onClick={() => sortBy("mtime")}>Modified{arrow("mtime")}</th>
              <th>Rights</th>
              {isServer && <th>Owner</th>}
            </tr>
          </thead>
          <tbody>
            {data?.parent != null && !filter && (
              <tr className="is-up" onDoubleClick={() => act.up(side)}><td colSpan={5}><span className="fi" aria-hidden>↰</span> ..</td></tr>
            )}
            {data && entries.map((e) => (
              <tr key={e.name} data-name={e.name}
                className={`${selSet.has(e.name) ? "is-sel" : ""}${dropHere === e.name ? " is-drop" : ""}${e.name.startsWith(".") ? " is-dot" : ""}`}
                onClick={(ev) => click(e, ev)} onDoubleClick={() => act.openEntry(side, e)} onContextMenu={(ev) => rowMenu(ev, e)}
                draggable onDragStart={(ev) => {
                  const names = selSet.has(e.name) ? sel : [e.name];
                  if (!selSet.has(e.name)) patch({ sel: [e.name], anchor: e.name });
                  ev.dataTransfer.setData(DND, JSON.stringify({ side, names }));
                  ev.dataTransfer.effectAllowed = "copyMove";
                }}
                onDragOver={e.type === "dir" ? (ev) => over(ev, e.name) : undefined}
                onDrop={e.type === "dir" ? (ev) => drop(ev, e.name) : undefined}>
                <td className="nm" title={e.link ? `${e.name} (a link)` : e.name}>
                  <span className={`fi ${e.type}`} aria-hidden>{e.type === "dir" ? "▸" : ""}</span>{e.name}{e.link && <span className="lnk" aria-label="link"> ↪</span>}
                </td>
                <td className="num">{e.type === "dir" ? "" : fmtSize(e.size)}</td>
                <td>{fmtTime(e.mtime)}</td>
                <td className="mode">{e.mode}</td>
                {isServer && <td className="owner">{e.owner}</td>}
              </tr>
            ))}
            {data && !entries.length && <tr className="empty"><td colSpan={5}>{filter ? "Nothing matches the filter." : "Empty folder. Drop files here to upload them."}</td></tr>}
          </tbody>
        </table>
        {loading && <div className="files-loading">Loading…</div>}
      </div>
      <footer className="files-status">
        {data ? `${plural(entries.length, "item")}${filter ? " shown" : ""}${sel.length ? ` · ${sel.length} selected${selSize ? ` (${fmtSize(selSize)})` : ""}` : ""}` : ""}
      </footer>
    </section>
  );
}

// ======================================================================= transfers
function Transfers({ jobs, setJobs }) {
  if (!jobs.length) return null;
  return (
    <div className="files-jobs" aria-live="polite">
      <div className="files-jobs-head">
        <b>Transfers</b>
        <button className="link" onClick={() => setJobs((js) => js.filter((j) => j.state === "running"))}>Clear finished</button>
      </div>
      {jobs.map((j) => {
        const pct = j.total_bytes ? Math.round((100 * j.done_bytes) / j.total_bytes) : j.state === "running" ? 0 : 100;
        return (
          <div key={j.id} className={`files-job is-${j.state}`}>
            <span className="what">{j.upload ? "Upload" : j.verb === "Moved" ? "Move" : "Copy"} {j.what} → {j.to}</span>
            <span className="fj-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></span>
            <span className="num">{j.state === "running" ? `${fmtSize(j.done_bytes)} of ${fmtSize(j.total_bytes || 0)}` : j.state}</span>
            {j.state === "running" && !j.upload ? <button className="mini" onClick={() => api.filesCancel(j.id)}>Cancel</button> : <span />}
            {j.state === "running" && j.current && <small className="cur">{j.current}</small>}
          </div>
        );
      })}
    </div>
  );
}

// ======================================================================= a small text editor
function Editor({ file, close }) {
  const { ask, say } = useUI();
  const [doc, setDoc] = useState(null);         // { text, encoding, mtime, crlf }
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const ta = useRef(null);
  const name = file.path.split(/[\\/]/).pop();

  useEffect(() => {
    api.filesText(file.loc, file.path).then((d) => { setDoc(d); setText(d.text.replace(/\r\n/g, "\n")); setTimeout(() => ta.current?.focus(), 0); })
      .catch((e) => setErr(e.message));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = doc && text !== doc.text.replace(/\r\n/g, "\n");
  const save = async () => {
    if (!doc || busy) return;
    setBusy(true); setErr("");
    try {
      const out = doc.crlf ? text.replace(/\n/g, "\r\n") : text;
      const r = await api.filesSaveText(file.loc, file.path, out, doc.encoding, doc.mtime);
      setDoc({ ...doc, text: out, mtime: r.mtime });
      setSavedOnce(true);
      say("ok", `Saved ${name} on ${file.where}.`);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const tryClose = async () => {
    if (dirty) {
      const v = await ask({ title: `Close ${name} without saving?`, body: "Your changes will be lost.",
        options: [{ label: "Keep editing", value: "no" }, { label: "Close without saving", value: "yes", kind: "danger" }] });
      if (v !== "yes") { ta.current?.focus(); return; }
    }
    close(savedOnce);
  };
  const keys = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    if (e.key === "Tab" && !e.ctrlKey && e.target === ta.current) {     // a tab character, not the next field
      e.preventDefault();
      const t = ta.current, a = t.selectionStart, b = t.selectionEnd;
      setText(text.slice(0, a) + "\t" + text.slice(b));
      requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 1; });
    }
  };

  const lines = text.split("\n").length;
  return (
    <Dialog className="editor-dlg" label={`Edit ${name}`} onClose={tryClose}>
      <div className="editor" onKeyDown={keys}>
        <header>
          <div><h2>{name}{dirty ? " •" : ""}</h2><small>{file.path} on {file.where}</small></div>
          <span className="spacer" />
          {doc && <small className="ed-info">{plural(lines, "line")} · {doc.encoding.toUpperCase()}{doc.crlf ? " · CRLF" : ""}</small>}
          <button onClick={tryClose}>Close</button>
          <button className="primary" disabled={!dirty || busy} onClick={save} title="Save (Ctrl+S)">{busy ? "Saving…" : "Save"}</button>
        </header>
        {err && <p className="err-text">{err}</p>}
        {doc ? <textarea ref={ta} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={`Contents of ${name}`} />
          : !err && <p className="hint">Loading…</p>}
      </div>
    </Dialog>
  );
}

// ======================================================================= permissions
function ChmodDialog({ c, close }) {
  const [perm, setPerm] = useState(c.perm & 0o7777);
  const [octal, setOctal] = useState((c.perm & 0o7777).toString(8).padStart(3, "0"));
  const set = (p) => { setPerm(p); setOctal(p.toString(8).padStart(3, "0")); };
  const bit = (b) => (
    <input type="checkbox" checked={!!(perm & b)} onChange={(e) => set(e.target.checked ? perm | b : perm & ~b)} />
  );
  const who = [["Owner", 6], ["Group", 3], ["Others", 0]];
  return (
    <Dialog title={`Permissions of ${c.names.length === 1 ? c.names[0] : plural(c.names.length, "item")}`} onClose={() => close(null)}>
      <p className="hint">In {c.where}. Only the owner (or root) can change them.</p>
      <table className="chmod">
        <thead><tr><th /><th>Read</th><th>Write</th><th>Run / open</th></tr></thead>
        <tbody>
          {who.map(([w, s]) => (
            <tr key={w}><th>{w}</th><td>{bit(4 << s)}</td><td>{bit(2 << s)}</td><td>{bit(1 << s)}</td></tr>
          ))}
        </tbody>
      </table>
      <label className="field inline">Octal
        <input value={octal} maxLength={4} onChange={(e) => { setOctal(e.target.value); if (/^[0-7]{3,4}$/.test(e.target.value)) setPerm(parseInt(e.target.value, 8)); }} />
      </label>
      <div className="dialog-actions">
        <button onClick={() => close(null)}>Cancel</button>
        <button className="primary" disabled={!/^[0-7]{3,4}$/.test(octal)} onClick={() => close(perm)}>Set</button>
      </div>
    </Dialog>
  );
}
