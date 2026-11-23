import { useEffect, useState } from "react";
import { api } from "./api.js";
import { THEMES } from "./settings.js";
import { Dialog } from "./ui.jsx";

/** Choose the terminal's colours: every theme shown on the same sample session. Clicking one tries
 *  it on your open terminals at once; Cancel puts the one you had back. */
export function ThemesDialog({ settings, save, close, Logo }) {
  const [start] = useState(settings.theme);
  const [show, setShow] = useState("all");                 // all | dark | light
  const pick = (k) => save({ ...settings, theme: k });
  const list = Object.entries(THEMES).filter(([, t]) => show === "all" || (show === "dark") === t.dark);
  return (
    <Dialog title="Themes" className="themes-dlg" onClose={() => { pick(start); close(); }}>
      <div className="themes-head">
        <p className="hint">Click a theme to try it on your open terminals. The tab bar and file browser keep their colours.</p>
        <div className="seg" role="radiogroup" aria-label="Show">
          {[["all", "All"], ["dark", "Dark"], ["light", "Light"]].map(([v, l]) => (
            <button key={v} role="radio" aria-checked={show === v} className={show === v ? "is-on" : ""} onClick={() => setShow(v)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="theme-grid" role="radiogroup" aria-label="Themes">
        {list.map(([k, t]) => (
          <button key={k} role="radio" aria-checked={settings.theme === k} className={`theme-card${settings.theme === k ? " is-on" : ""}`}
            onClick={() => pick(k)} onDoubleClick={() => { pick(k); close(); }}>
            <Sample c={t.colors} font={settings.fontFamily} />
            <span className="theme-name">{t.name}{settings.theme === k && <span className="theme-check" aria-hidden> ✓</span>}</span>
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button onClick={() => { pick(start); close(); }}>Cancel</button>
        <button className="primary" onClick={close}>Use {THEMES[settings.theme]?.name ?? "this theme"}</button>
      </div>
    </Dialog>
  );
}

function Sample({ c, font }) {
  const S = ({ k, b, children }) => <span style={{ color: c[k] ?? c.foreground, fontWeight: b ? 700 : 400 }}>{children}</span>;
  const prompt = <><S k="green" b>alice@web</S><S k="foreground">:</S><S k="blue" b>~</S><S k="foreground">$ </S></>;
  return (
    <pre className="theme-sample" style={{ background: c.background, color: c.foreground, fontFamily: font }} aria-hidden>
      {prompt}ls{"\n"}
      <S k="blue" b>docs</S>  <S k="green" b>run.sh</S>  notes.txt  <S k="cyan" b>www</S>{"\n"}
      {prompt}git status -s{"\n"}
      <S k="red"> M</S> app.py  <S k="green">A </S> new.py  <S k="red">??</S> tmp{"\n"}
      <S k="yellow">warning:</S> disk 91% full{"\n"}
      {prompt}<span style={{ background: c.cursor, color: c.background }}> </span>
    </pre>
  );
}

/** About Yonder. */
export function AboutDialog({ about, close, Logo }) {
  const [notices, setNotices] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { if (notices === "") api.notices().then(setNotices).catch((e) => { setErr(e.message); setNotices(null); }); }, [notices]);
  if (notices) {
    return (
      <Dialog title="Third-party notices" className="notices-dlg" onClose={() => setNotices(null)}>
        <pre className="notices">{notices}</pre>
        <div className="dialog-actions"><button className="primary" onClick={() => setNotices(null)}>Back</button></div>
      </Dialog>
    );
  }
  return (
    <Dialog className="about-dlg" label="About Yonder" onClose={close}>
      <div className="about-head">
        <Logo size={72} />
        <div>
          <h2>Yonder</h2>
          <p className="about-version">Version {about?.version ?? "…"}</p>
          <p>A terminal, a file manager and a remote desktop for your servers, in your browser: many tabs, to many servers at once.</p>
        </div>
      </div>
      {about && (
        <dl className="about-list">
          <dt>Your sessions and settings</dt><dd><code>{about.data_dir}</code></dd>
          <dt>Recordings</dt><dd><code>{about.recordings_dir}</code></dd>
          <dt>SSH keys and known hosts</dt><dd><code>{about.ssh_dir}</code></dd>
          <dt>Running on</dt><dd>Python {about.python} ({about.platform})</dd>
          <dt>Shells after a reload</dt><dd>kept running for {Math.round(about.detached_ttl / 60)} minutes, until their tab comes back</dd>
        </dl>
      )}
      <p className="hint">Built with FastAPI and paramiko (the server side), React, xterm.js and noVNC (the page). It grew out of DockerLab,
        and was called SSHDeck until version 0.3.</p>
      <p className="hint">Free software under the GNU General Public License, version 3 or later.</p>
      {err && <p className="err-text">{err}</p>}
      <div className="dialog-actions">
        <button onClick={() => setNotices("")}>Third-party notices</button>
        <button className="primary" onClick={close}>Close</button>
      </div>
    </Dialog>
  );
}
