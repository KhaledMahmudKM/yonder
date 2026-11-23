# Yonder

A terminal, a file manager and a remote desktop for SSH servers, in your web browser: many tabs, to many servers at once.

- **Terminals:** a full terminal (xterm.js) on any Linux server with an SSH server. Nothing to install on the server.
- **Files, WinSCP style:** two panes, each showing your computer or any connected server. Copy, move, rename, delete, upload, download, edit text files, change permissions. Copying from server A to server B is one drag.
- **Desktops (VNC)** in a tab, through the server's SSH connection: the VNC server can stay closed to the network.
- **Port forwarding** (like `ssh -L`): reach a web admin page or database that listens only on the server.
- **Tabs:** terminal, file and desktop tabs, to the same or different servers. Rename, reorder, duplicate; reload the page and the terminals come back as they were.
- **Recording:** record terminal sessions and replay them in Yonder (or asciinema), or keep them as plain-text logs.
- **Saved sessions** in folders (like PuTTY or WinSCP), quick connect, recent connections; 14 colour themes.

Yonder was called SSHDeck until version 0.3. Its saved sessions (`~/.sshdeck`), its `SSHDECK_…` settings and the browser's open tabs carry over by themselves.

Yonder runs on your own computer and opens in your browser (`http://127.0.0.1:8022`). It's built from [DockerLab](#what-came-from-dockerlab)'s SSH, terminal and file-manager parts.

## 1. Getting Yonder

**Windows:** download `Yonder.exe` and double-click it. A window opens showing what Yonder does, and Yonder opens in your browser; keep the window open, and press **Ctrl+C** in it to stop Yonder. Double-clicking it again while it runs just opens the browser. The app isn't signed, so the first time Windows may say *Windows protected your PC*: choose *More info*, then *Run anyway*.

**From the source (Windows, macOS, Linux):** Python 3.10 or later.

```
pip install -r backend/requirements.txt
python backend/main.py
```

then open `http://127.0.0.1:8022`. The release `.zip` has the web interface built in; from a Git checkout, build it first: `cd frontend && npm install && npm run build`.

## 2. Connecting

Type `user@address` (or `user@address:port`) in **Connect to a server** and press **Terminal** or **Files**, or save the server as a session first (**New session…**).

The first time, Yonder shows the server's **host key** fingerprint. Check it (on the server: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) and trust it: Yonder saves it in your `~/.ssh/known_hosts`, the same file OpenSSH uses. If a server's key ever changes, Yonder shows a red warning with the old and new fingerprints and connects only if you choose to replace the key.

To log in, Yonder tries, in order:

1. the session's own **key file**, if you picked one (it asks for the key's passphrase if it has one);
2. your **SSH agent** (Pageant, or the OpenSSH agent on Windows 10 and 11);
3. your keys in `~/.ssh` (those without a passphrase);
4. a **password**, which it asks for. Tick *Install my SSH key on the server* and Yonder adds your public key to the server's `~/.ssh/authorized_keys`, so next time no password is needed. If you have no key yet, it makes one (`~/.ssh/id_ed25519`).

Passwords and passphrases are **never saved**. Yonder keeps them in memory while you're connected, so new tabs and dropped connections reconnect without asking again; **Disconnect** (in the sidebar) closes the server's terminals and forgets them.

## 3. Tabs

| | |
|---|---|
| New tab | **+**, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>: shows quick connect and your sessions |
| Close a tab | **×**, middle-click, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> |
| Go to a tab | click, <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd>, <kbd>Alt</kbd>+<kbd>PgUp</kbd> / <kbd>PgDn</kbd> |
| Rename | double-click the tab (empty the name to go back to the automatic one) |
| Reorder | drag the tab |
| More | right-click a tab: duplicate, files or terminal on the same server, close others |

The browser keeps <kbd>Ctrl</kbd>+<kbd>T</kbd>, <kbd>Ctrl</kbd>+<kbd>W</kbd> and <kbd>Ctrl</kbd>+<kbd>Tab</kbd> for its own tabs, so Yonder uses <kbd>Alt</kbd>. A dot on a tab you're not looking at means new output there; a flash means the terminal rang its bell.

All the tabs to one server share one SSH connection. OpenSSH allows 10 sessions per connection, so Yonder opens another connection, with the same login, when one fills up (after 8, to leave room).

## 4. Terminals

- **Copy:** select text and press <kbd>Ctrl</kbd>+<kbd>C</kbd> (without a selection, <kbd>Ctrl</kbd>+<kbd>C</kbd> interrupts as usual), or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>. **Paste:** <kbd>Ctrl</kbd>+<kbd>V</kbd>. Right-click copies the selection, or pastes when nothing is selected (like PuTTY). Pasting several lines asks first, since each line runs as a command (this can be turned off in Settings).
- **Find** in the scrollback: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>.
- **Links:** <kbd>Ctrl</kbd>+click opens them.
- **Reloading the page, or losing the connection to Yonder, doesn't end your shell.** It keeps running in Yonder for 10 minutes, and the tab comes back to it with its screen as it was. Closing the tab ends it. When a shell ends (you typed `exit`), press <kbd>Enter</kbd> for a new one.
- **Save text** (in the terminal's bar) saves what the terminal shows, with its scrollback, as a `.txt` file.
- **Themes** (⚙ menu): 14 colour schemes, each shown on a sample session; click one to try it on your open terminals, *Cancel* puts yours back. Among them Dracula, Nord, Gruvbox, One Dark, Monokai, Tokyo Night, Catppuccin, Solarized dark and light, GitHub light, and PuTTY's classic colours.
- **Settings** (⚙ menu): font and size, scrollback, cursor, copy on select, recording. **About Yonder** shows the version, where your data is kept, and the third-party notices.

### Recording a session

**Record** in a terminal's bar records it from that moment, until you press it again (it shows the time and a red dot on the tab), or the session ends. Yonder writes, in your recordings folder (`~/.yonder/recordings`, shown in About):

- a **`.cast`** file (asciinema's format): every piece of output with its timing and colours. **Recordings…** in the ⚙ menu lists them and plays them back: pause, jump, 0.5× to 8× speed, and *Skip pauses* (long pauses play as 2 seconds). `asciinema play` plays them too, and they can be uploaded to asciinema.org;
- a **`.log`** file: the same session as plain text, like PuTTY's session log, for any editor.

Settings chooses which of the two to write, and can **record every terminal** from the moment it opens. Only the output is recorded, not the keys you press: what you type shows up anyway as the shell echoes it, while passwords typed at a prompt (`sudo`, `passwd`) stay out. Recording is done by Yonder, not the page, so it goes on through a page reload, and a recording is complete as soon as it stops.

## 5. Files

A file tab has two panes; each shows **this computer** or any **connected server** (its menu also lists saved sessions, to connect to one). Copy or move between the panes with the buttons, <kbd>F5</kbd> / <kbd>F6</kbd>, or by dragging (<kbd>Shift</kbd> while dropping moves). Drop files or folders from Explorer onto a pane to upload them there.

| Key | |
|---|---|
| <kbd>Enter</kbd> | open the folder, or edit the file |
| <kbd>Backspace</kbd> | up one folder |
| <kbd>F2</kbd> | rename |
| <kbd>F4</kbd> | edit a text file |
| <kbd>F5</kbd> / <kbd>F6</kbd> | copy / move to the other pane's folder |
| <kbd>F7</kbd> | new folder |
| <kbd>Del</kbd> | delete (there's no recycle bin) |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | select all; <kbd>Ctrl</kbd>/<kbd>Shift</kbd>+click to select several |

- Copies run in the background, with progress and **Cancel**; if files already exist, Yonder asks whether to replace or skip them. Unix permissions are kept. A move within one server is a rename: instant.
- **Download** saves to your browser's Downloads folder; several items, or a folder, come as a `.zip`.
- **Edit** opens text files up to 2 MB in an editor (<kbd>Ctrl</kbd>+<kbd>S</kbd> saves). If the file changed on the server since you opened it, Yonder doesn't overwrite it.
- **Permissions…** (right-click) sets read, write and run for owner, group and others.
- **Terminal here** opens a terminal in the folder the pane shows.

## 6. Desktops (VNC)

A desktop tab shows a server's graphical desktop (noVNC in the browser). It goes **through the server's SSH connection**: Yonder asks the server to connect to its own VNC server, usually at `localhost:5901`, and passes the traffic along. So the VNC server can listen on the server's localhost only, the traffic is encrypted, and no VNC port has to be open to the network.

- **Open one:** in a saved session's settings (**Edit**, then *Desktop (VNC) and port forwards*), set the VNC port; the session then has a **Desktop** button. Without that, right-click the session (*Open a desktop (VNC)…*) or a tab (*Desktop on this server (VNC)…*). Its port is 5900 + the display number: `:1` is 5901. To reach a VNC server on another machine behind the server, give its address too (e.g. `10.0.0.5:5900`).
- **The VNC password** (set on the server with `vncpasswd`, not your login password) is asked for when the desktop wants one, and kept in the page's memory for reconnecting, never saved.
- **In the bar:** *Fit to the tab*, *Actual size* (scroll), or *Resize the desktop* to the tab (TigerVNC and other Xvnc servers); *View only*; *Send clipboard* puts your clipboard's text on the desktop's clipboard (text copied on the desktop comes to your clipboard by itself); *Ctrl+Alt+Del*; *Full screen*.

A VNC server on a Linux server, for example with TigerVNC (Debian, Ubuntu: `sudo apt install tigervnc-standalone-server`, plus a desktop such as XFCE): run `vncpasswd` once, then `vncserver :1 -localhost yes`. To share the screen of a desktop that's already running instead, use `x11vnc -localhost -rfbauth ~/.vnc/passwd -display :0`.

## 7. Port forwarding

A port on this computer that leads to an address as the server sees it, through its SSH connection (like `ssh -L`). For example, a web admin page on the server's `localhost:8080`, a database that only listens on the server, or a machine on a network behind the server.

- **For now:** *Ports* next to a connected server in the sidebar (or right-click a tab, *Port forwards on this server…*). Give the address and port as the server sees them, and optionally the port on this computer (otherwise any free one). **Open** opens it in the browser, **Copy** copies its address (`127.0.0.1:<port>`) for another program.
- **Every time:** add forwards to a saved session (**Edit**, *Desktop (VNC) and port forwards*); they start when Yonder connects to it.

Forwards listen on `127.0.0.1` only, and end when you disconnect the server or stop Yonder. If the server refuses (`AllowTcpForwarding no` in its `sshd_config`), the forward shows *failing* with the reason. The same goes for desktops, which use the same mechanism.

## 8. Safety

- Yonder listens only on `127.0.0.1`: other computers can't reach it.
- **Other websites can't use it either.** A web page open in your browser could otherwise send requests to `127.0.0.1`, or open a terminal WebSocket. Yonder refuses any request that comes from another site (its `Origin`), and any request for another host name (which stops DNS rebinding).
- Host keys are checked on every connection; a changed key is never accepted without you.
- Nothing secret is written to disk: saved sessions hold address, port, user and key-file path.

To run Yonder for use from other computers (for example in a lab VM), set `YONDER_BIND=0.0.0.0` **and** `YONDER_PASSWORD`, and `YONDER_ALLOWED_HOSTS` to the names or addresses people will use to reach it. It's still one user's Yonder: everyone who signs in shares its connections and sessions.

## 9. Settings

| Environment variable | Default | |
|---|---|---|
| `YONDER_PORT` | `8022` | the port it serves the page on |
| `YONDER_BIND` | `127.0.0.1` | the address it listens on |
| `YONDER_PASSWORD` | (none) | a password for the web interface |
| `YONDER_ALLOWED_HOSTS` | (none) | more host names it answers to, comma-separated (`*` for any) |
| `YONDER_OPEN_BROWSER` | `1` in the `.exe` | open the browser at start |
| `YONDER_DETACHED_TTL` | `600` | seconds a shell keeps running after its tab lost its connection |
| `YONDER_MAX_SESSIONS` | `8` | sessions per SSH connection before another is opened |
| `YONDER_FILES_LOCAL` | `1` | `0` hides this computer's files |
| `YONDER_HOME` | `~/.yonder` | where saved sessions and settings are kept |
| `YONDER_FORWARD_BIND` | `127.0.0.1` | the address port forwards listen on (`0.0.0.0` lets other computers use them) |
| `YONDER_SSH_DIR` | `~/.ssh` | where keys and `known_hosts` are |

## 10. How it's built

A Python backend (FastAPI, paramiko) and a React web interface (Vite, xterm.js, noVNC), built into `backend/static`.

```
backend/
  main.py      the API, the terminal WebSocket, serves the page
  ssh.py       connections: one Server per user@host:port, a pool of SSH connections with a session cap,
               host-key trust, logins (key file, agent, ~/.ssh keys, password, keyboard-interactive)
  terms.py     shells that outlive their WebSocket, with the last 256 KB of output to replay
  forwards.py  port forwarding (SSH direct-tcpip channels); the VNC relay uses the same tunnels
  recording.py session recordings: asciicast v2 (.cast) and plain text (.log)
  files.py     this computer and SFTP behind one interface; copy jobs with progress; zip downloads; the editor
  store.py     saved sessions, recent connections, settings (~/.yonder/sessions.json)
  guard.py     refuses other sites' requests and unknown host names
  webauth.py   the optional password
frontend/src/
  App.jsx      tab bar, keyboard shortcuts, settings
  connect.jsx  the connect dialog: host key, password, passphrase
  Terminal.jsx a terminal tab;  Files.jsx  a file tab (panes, transfers, editor, permissions)
  Vnc.jsx      a desktop tab (noVNC, loaded only when one opens);  Forwards.jsx  port forwards
  Recordings.jsx  the recordings list and player;  Dialogs.jsx  Themes and About;  settings.js  the themes
  Sessions.jsx sidebar, new-tab page, session editor
```

**The terminal protocol:** `POST /api/terms {server}` opens a shell and returns its id; the WebSocket `/api/terms/<id>/ws` carries it. Binary frames are terminal bytes both ways; text frames are JSON: `{"resize": [cols, rows]}` from the browser, `{"attached"}`, `{"exit": status}`, `{"detached": "elsewhere"}` from Yonder.

**The desktop protocol:** the WebSocket `/api/vnc/ws?server=<user@host:port>&host=localhost&port=5901` carries the VNC (RFB) stream, unchanged, between noVNC and a direct-tcpip channel on the server's SSH connection.

**Developing:** run the backend (`python backend/main.py`), then `cd frontend && npm run dev`; Vite serves the page with hot reload and passes `/api` (WebSockets too) to the backend.

**Releases:** push a tag such as `v0.1.0`; GitHub builds `Yonder.exe` and a source `.zip` (`.github/workflows/release.yml`, with `tools/packaging/yonder.spec`).

### What came from DockerLab

| Yonder | from DockerLab's |
|---|---|
| `ssh.py` | `connection.py` (host-key trust, key install) and `vmshell.py` (the shell), now for any number of servers |
| `files.py` | `files.py`, without containers; the SFTP location takes any server |
| `terms.py`, the terminal WebSocket | the `/api/vm/console` WebSocket, now detachable |
| `webauth.py` | `webauth.py` |
| `Terminal.jsx` | `console.js` (copy and paste, resize) |
| `Files.jsx` | `Files.jsx` (two panes, keys, drag and drop, transfers) |
| packaging, release workflow | `tools/packaging`, `release.yml` |

## 11. Not yet

Jump hosts (bastions), remote forwarding (`ssh -R`) and SOCKS (`ssh -D`), split views (terminal and files side by side), sending one command to several tabs, logging a session to a file, `sudo` in the file manager, resuming interrupted transfers, one-time-code (2FA) logins.

## License

GPL-3.0-or-later, like DockerLab. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
