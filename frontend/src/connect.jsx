import { createContext, useCallback, useContext, useRef, useState } from "react";
import { api, serverKey, targetLabel } from "./api.js";
import { Dialog } from "./ui.jsx";

/** connect(target) => Promise<server | null>: logs in to a server, asking the user what the backend
 *  needs (trust its host key, a password, a key's passphrase). Resolves null if they cancel.
 *  Several tabs asking for the same server at once share one dialog. */
const Ctx = createContext(null);
export const useConnect = () => useContext(Ctx);

export function ConnectProvider({ children, onConnected }) {
  const [dlg, setDlg] = useState(null);          // { target, step, info, busy, error }
  const pending = useRef(new Map());              // server key -> promise
  const queue = useRef(Promise.resolve());        // one dialog at a time

  const run = useCallback((target) => new Promise((resolve) => {
    const extra = {};                             // what the user gave so far: trust, password, passphrase, install_key
    const attempt = async () => {
      setDlg((d) => d && { ...d, busy: true, error: "" });
      try {
        const r = await api.connect({ ...target, session_id: target.sessionId || target.session_id || "", ...extra });
        if (r.ok) {
          setDlg(null);
          onConnected?.(r);
          resolve(r.server);
          return;
        }
        setDlg({ target, step: r.need, info: r, busy: false, error: "",
          submit: (v) => {
            if (r.need === "hostkey" || r.need === "hostkey_changed") extra.trust = r.fingerprint;
            if (r.need === "password") { extra.password = v.password; extra.install_key = v.install; }
            if (r.need === "passphrase") extra.passphrase = v.passphrase;
            attempt();
          },
          cancel: () => { setDlg(null); resolve(null); } });
      } catch (e) {
        setDlg({ target, step: "error", info: {}, busy: false, error: e.message,
          submit: () => attempt(), cancel: () => { setDlg(null); resolve(null); } });
      }
    };
    setDlg({ target, step: "connecting", info: {}, busy: true, cancel: () => { setDlg(null); resolve(null); } });
    attempt();
  }), [onConnected]);

  const connect = useCallback((target) => {
    const key = serverKey(target);
    if (pending.current.has(key)) return pending.current.get(key);
    // quick path: already connected, no dialog at all
    const p = api.connect({ ...target, session_id: target.sessionId || "" }).then((r) => {
      if (r.ok) { onConnected?.(r); return r.server; }
      const next = queue.current.then(() => run(target));
      queue.current = next.catch(() => null);
      return next;
    }, () => {
      const next = queue.current.then(() => run(target));
      queue.current = next.catch(() => null);
      return next;
    }).finally(() => pending.current.delete(key));
    pending.current.set(key, p);
    return p;
  }, [run, onConnected]);

  return (
    <Ctx.Provider value={connect}>
      {children}
      {dlg && <ConnectDialog key={`${serverKey(dlg.target)} ${dlg.step}`} dlg={dlg} />}
    </Ctx.Provider>
  );
}

function ConnectDialog({ dlg }) {
  const { target, step, info, busy, error } = dlg;
  const [password, setPassword] = useState("");
  const [install, setInstall] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const name = targetLabel(target);
  const where = `${target.user}@${target.host}${(target.port || 22) === 22 ? "" : `:${target.port}`}`;
  const submit = (e) => { e?.preventDefault(); dlg.submit({ password, install, passphrase }); };

  let body = null, ok = null, okKind = "primary";
  if (step === "connecting") {
    body = <p className="busy-line"><span className="spinner" /> Connecting to {where}…</p>;
  } else if (step === "hostkey") {
    body = (<>
      <p>This is the first connection to <b>{target.host}</b>{target.port !== 22 && target.port ? ` (port ${target.port})` : ""}.
        Check that its key's fingerprint is the server's (on the server: <code>ssh-keygen -lf /etc/ssh/ssh_host_{info.key_type?.replace("ssh-", "").replace("ecdsa-sha2-nistp256", "ecdsa")}_key.pub</code>), then trust it.
        Yonder remembers it in your <code>known_hosts</code>, and warns you if it ever changes.</p>
      <dl className="fp"><dt>{info.key_type}</dt><dd><code>{info.fingerprint}</code></dd></dl>
    </>);
    ok = "Trust and connect";
  } else if (step === "hostkey_changed") {
    body = (<>
      <p className="warn"><b>Warning: {target.host}'s host key has changed.</b> Either the server was reinstalled or its key
        replaced, or someone is intercepting the connection. Don't continue unless you know why it changed.</p>
      <dl className="fp">
        <dt>Now</dt><dd><code>{info.key_type} {info.fingerprint}</code></dd>
        <dt>Before</dt><dd>{(info.old_fingerprints || []).map((f) => <code key={f}>{f}</code>)}</dd>
      </dl>
    </>);
    ok = "Replace the key and connect"; okKind = "danger-solid";
  } else if (step === "password") {
    body = (<>
      {info.wrong ? <p className="err-text">{info.message || "That password wasn't accepted."}</p>
        : <p>{info.message ? `${info.message} ` : ""}Password for <b>{where}</b>:</p>}
      <label className="field">Password
        <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
      </label>
      <label className="check"><input type="checkbox" checked={install} onChange={(e) => setInstall(e.target.checked)} />
        Install my SSH key on the server, so next time no password is needed</label>
      {info.hint && <p className="hint">{info.hint}</p>}
      <p className="hint">The password is kept in Yonder's memory while you're connected (for new tabs), never saved.</p>
    </>);
    ok = "Log in";
  } else if (step === "passphrase") {
    body = (<>
      {info.wrong ? <p className="err-text">That passphrase didn't open the key.</p> : <p>The key <code>{info.key_file}</code> has a passphrase:</p>}
      <label className="field">Passphrase
        <input type="password" autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
      </label>
    </>);
    ok = "Unlock and connect";
  } else if (step === "error") {
    body = <p className="err-text">{error}</p>;
    ok = "Try again";
  } else {
    body = <p>{info.message || `The server needs: ${step}.`}</p>;
  }

  return (
    <Dialog title={step === "error" ? `Couldn't connect to ${name}` : `Connect to ${name}`} className="connect-dlg" onClose={dlg.cancel}>
      <form onSubmit={submit}>
        {body}
        {error && step !== "error" && <p className="err-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={dlg.cancel}>Cancel</button>
          {ok && <button type="submit" className={okKind} disabled={busy || (step === "password" && !password) || (step === "passphrase" && !passphrase)}>
            {busy ? "Connecting…" : ok}</button>}
        </div>
      </form>
    </Dialog>
  );
}
