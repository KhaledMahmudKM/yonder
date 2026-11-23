import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Shared bits: toasts (say), a question dialog (ask), a text prompt (askText), context menus. */
const UI = createContext(null);
export const useUI = () => useContext(UI);

export function UIProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [question, setQuestion] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [menu, setMenu] = useState(null);

  /** A notification. `action` ({ label, onClick }) adds a button to it. */
  const say = useCallback((kind, text, list, action) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-4), { id, kind, text, list, action }]);
    if (kind !== "err") setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 9000 : kind === "ok" ? 3500 : 6000);
  }, []);
  const ask = useCallback((q) => new Promise((resolve) => setQuestion({ ...q, resolve })), []);
  const askText = useCallback((title, label, value = "", ok = "OK") =>
    new Promise((resolve) => setPrompt({ title, label, value, ok, resolve })), []);
  /** A context menu at the mouse: items are { label, onClick, danger, disabled, hint } or "-". */
  const openMenu = useCallback((ev, items) => {
    ev.preventDefault(); ev.stopPropagation();
    setMenu({ x: ev.clientX, y: ev.clientY, items });
  }, []);

  return (
    <UI.Provider value={{ say, ask, askText, openMenu }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast is-${t.kind}`} role={t.kind === "err" ? "alert" : "status"}>
            <div className="toast-text">{t.text}{t.list && <ul>{t.list.slice(0, 8).map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {t.action && <button className="toast-action" onClick={() => { setToasts((ts) => ts.filter((x) => x.id !== t.id)); t.action.onClick(); }}>{t.action.label}</button>}</div>
            <button className="icon" aria-label="Dismiss" onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
      {question && <AskDialog q={question} close={(v) => { question.resolve(v); setQuestion(null); }} />}
      {prompt && <PromptDialog prompt={prompt} close={(v) => { prompt.resolve(v); setPrompt(null); }} />}
      {menu && <Menu menu={menu} close={() => setMenu(null)} />}
    </UI.Provider>
  );
}

/** After a dialog or menu closes, the active terminal takes the keyboard back. */
export const refocus = () => setTimeout(() => window.dispatchEvent(new Event("yonder-refocus")), 0);

export function Dialog({ title, className = "", onClose, children, label }) {
  const ref = useRef(null);
  useEffect(() => {
    const first = ref.current?.querySelector("[data-default]:not(:disabled), input:not([type=checkbox]):not([readonly]), select, textarea, button.primary:not(:disabled)");
    first?.focus();
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();   // so Escape still closes it
    return refocus;
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} tabIndex={-1} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={label || title}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose?.(); } }}>
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

function AskDialog({ q, close }) {
  return (
    <Dialog title={q.title} onClose={() => close(null)}>
      {q.body && <p>{q.body}</p>}
      <div className="dialog-actions">
        {q.options.map((o, i) => (
          <button key={o.value} className={o.kind === "danger" ? "danger-solid" : i === 0 ? "primary" : ""}
            data-default={o === q.options.find((x) => x.kind !== "danger") ? "" : undefined}
            onClick={() => close(o.value)}>{o.label}</button>
        ))}
      </div>
    </Dialog>
  );
}

function PromptDialog({ prompt, close }) {
  const [v, setV] = useState(prompt.value);
  const ref = useRef(null);
  useEffect(() => refocus, []);
  useEffect(() => {
    const i = ref.current; if (!i) return;
    i.focus();
    const dot = prompt.value.lastIndexOf(".");
    i.setSelectionRange(0, dot > 0 ? dot : prompt.value.length);   // the name, not the extension
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <form className="dialog" role="dialog" aria-modal="true" aria-label={prompt.title}
        onSubmit={(e) => { e.preventDefault(); close(v); }} onKeyDown={(e) => e.key === "Escape" && close(null)}>
        <h2>{prompt.title}</h2>
        <label className="field">{prompt.label}<input ref={ref} value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} /></label>
        <div className="dialog-actions">
          <button type="button" onClick={() => close(null)}>Cancel</button>
          <button type="submit" className="primary" disabled={!v.trim()}>{prompt.ok}</button>
        </div>
      </form>
    </div>
  );
}

function Menu({ menu, close }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.min(menu.x, innerWidth - r.width - 8), top: Math.min(menu.y, innerHeight - r.height - 8) });
    ref.current.querySelector("button:not(:disabled)")?.focus();
  }, [menu]);
  useEffect(() => {
    const off = (e) => { if (!ref.current?.contains(e.target)) close(); };
    const key = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const bs = [...ref.current.querySelectorAll("button:not(:disabled)")];
        const i = bs.indexOf(document.activeElement);
        bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length]?.focus();
      }
    };
    window.addEventListener("mousedown", off, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("mousedown", off, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", close); refocus(); };
  }, [close]);
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={pos}>
      {menu.items.filter(Boolean).map((it, i) => it === "-" ? <hr key={i} /> : (
        <button key={i} role="menuitem" className={it.danger ? "danger" : ""} disabled={it.disabled}
          onClick={() => { close(); it.onClick(); }}>
          <span>{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}

export const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
