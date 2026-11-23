/** The backend's API. Errors carry the server's message; a 409 that needs the user to log in
 *  (again) carries `need` ("connect", "password", ...) so the caller can open the connect dialog. */
async function call(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/login")) window.dispatchEvent(new Event("yonder-signin"));
  if (!res.ok) {
    const d = data.detail;
    const msg = Array.isArray(d) ? d.map((e) => `${e.loc?.slice(-1)}: ${e.msg}`).join("; ") : d;
    const err = new Error(msg || `${res.status} ${res.statusText}`);
    err.status = res.status;
    if (data.need) { err.need = data.need; err.info = data; }
    throw err;
  }
  return data;
}

const qs = (o) => new URLSearchParams(o).toString();

export const api = {
  about: () => call("GET", "/about"),
  auth: () => call("GET", "/auth"),
  login: (password) => call("POST", "/login", { password }),
  logout: () => call("POST", "/logout"),

  sessions: () => call("GET", "/sessions"),
  addSession: (s) => call("POST", "/sessions", s),
  saveSession: (id, s) => call("PUT", `/sessions/${id}`, s),
  deleteSession: (id) => call("DELETE", `/sessions/${id}`),
  renameFolder: (old, nw) => call("POST", "/sessions/rename-folder", { old, new: nw }),
  clearRecent: () => call("DELETE", "/recent"),
  keys: () => call("GET", "/keys"),
  settings: () => call("GET", "/settings"),
  saveSettings: (s) => call("PUT", "/settings", s),

  connect: (body) => call("POST", "/connect", body),
  servers: () => call("GET", "/servers"),
  disconnect: (key) => call("POST", "/servers/disconnect", { key }),

  forwards: () => call("GET", "/forwards"),
  addForward: (f) => call("POST", "/forwards", f),
  stopForward: (id) => call("DELETE", `/forwards/${id}`),

  startRecord: (tid, format) => call("POST", `/terms/${tid}/record`, { format: format || null }),
  stopRecord: (tid) => call("DELETE", `/terms/${tid}/record`),
  recordings: () => call("GET", "/recordings"),
  recordingUrl: (name, download = false) => `/api/recordings/${encodeURIComponent(name)}${download ? "?download=true" : ""}`,
  deleteRecording: (name) => call("DELETE", `/recordings/${encodeURIComponent(name)}`),
  openRecordingsFolder: () => call("POST", "/recordings/open-folder"),
  notices: () => fetch("/api/notices").then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText)))),

  openTerm: (server, cols, rows, cwd) => call("POST", "/terms", { server, cols, rows, cwd }),
  terms: () => call("GET", "/terms"),
  closeTerm: (id) => call("DELETE", `/terms/${id}`),
  termSocketUrl: (id) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terms/${id}/ws`,

  filesPlaces: () => call("GET", "/files/places"),
  filesList: (loc, path) => call("GET", `/files/list?${qs({ loc, path: path ?? "" })}`),
  filesMkdir: (loc, path) => call("POST", "/files/mkdir", { loc, path }),
  filesRename: (loc, path, name) => call("POST", "/files/rename", { loc, path, name }),
  filesDelete: (loc, dir, names) => call("POST", "/files/delete", { loc, dir, names }),
  filesChmod: (loc, dir, names, perm) => call("POST", "/files/chmod", { loc, dir, names, perm }),
  filesExists: (loc, dir, names) => call("POST", "/files/exists", { loc, dir, names }),
  filesCopy: (req) => call("POST", "/files/copy", req),
  filesJobs: () => call("GET", "/files/jobs"),
  filesCancel: (id) => call("POST", `/files/jobs/${id}/cancel`),
  filesText: (loc, path) => call("GET", `/files/text?${qs({ loc, path })}`),
  filesSaveText: (loc, path, text, encoding, mtime) => call("PUT", "/files/text", { loc, path, text, encoding, mtime }),
  filesDownloadUrl: (loc, dir, names) => `/api/files/download?${qs({ loc, dir, names: names.join("\n") })}`,
  filesUploadUrl: (loc, dir, rel) => `/api/files/upload?${qs({ loc, dir, rel })}`,
};

/** "user@host:port" (the backend's key for a server) from a target. */
export const serverKey = (t) => `${t.user}@${t.host}:${t.port || 22}`;

/** A target from what the user typed in quick connect: user@host[:port]. */
export function parseQuick(text) {
  const s = text.trim().replace(/^ssh\s+/, "");
  const m = /^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  return { user: m[1] || "", host: m[2].replace(/^\[|\]$/g, ""), port: m[3] ? Number(m[3]) : 22 };
}

/** A target from a server key (when nothing better is known). */
export function targetFromKey(key) {
  const at = key.lastIndexOf("@"), colon = key.lastIndexOf(":");
  return { user: key.slice(0, at), host: key.slice(at + 1, colon), port: Number(key.slice(colon + 1)) || 22 };
}

export const targetLabel = (t) => t.name || `${t.user}@${t.host}${(t.port || 22) === 22 ? "" : `:${t.port}`}`;

export const store = {
  get(key, fallback) {
    try {
      // Yonder was called SSHDeck: what this browser kept under the old names is still used
      const v = localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^yonder\./, "sshdeck."));
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } },
};
