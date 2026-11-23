# Tests

End-to-end tests of Yonder against two real SSH servers, on a Linux machine where you're root (a VM or a
container: `setup_servers.sh` adds the users `alice` and `bob`). They need the web interface built
(`cd frontend && npm run build`), and `pip install websockets playwright && playwright install chromium`.

```
sudo sh tests/setup_servers.sh                       # once: SSH servers on :2222 and :2223
sh tests/reset.sh && python3 tests/api_test.py && python3 tests/edge_test.py
sh tests/reset.sh && python3 tests/ui_test.py        # in Chromium; screenshots in tests/shots
sh tests/reset.sh && python3 tests/forward_test.py   # needs the web and VNC servers below
sh tests/reset.sh && python3 tests/vnc_ui_test.py
sh tests/reset.sh && python3 tests/record_test.py
sh tests/reset.sh && python3 tests/features_test.py   # About, Themes, recording and playback, Save text
```

For the forwarding and desktop tests, a web server and a VNC server on the test machine (they listen on localhost
only; the tests reach them through SSH):

```
sudo apt install x11vnc xvfb xterm x11-apps
python3 -m http.server 9090 --bind 127.0.0.1 --directory /home/alice/projects/site &
Xvfb :1 -screen 0 1280x800x24 &  DISPLAY=:1 xterm &  DISPLAY=:1 xeyes &
x11vnc -storepasswd vncpw /tmp/sshtest/vncpass
x11vnc -display :1 -localhost -rfbport 5901 -rfbauth /tmp/sshtest/vncpass -forever -shared &
```

- `api_test.py`: host-key trust, wrong and right passwords, installing your key then logging in with it,
  keyboard-interactive, terminals (commands, resize, reattach with the screen replayed, taken over by a second
  socket, exit status), 12 terminals on one server spread over two SSH connections, files on two servers
  (upload, server-to-server copy, move as rename, copying a folder into itself refused, chmod, the editor and its
  stale-file check, binary files refused, zip download), disconnect, saved sessions.
- `edge_test.py` (after `api_test.py`): a key with a passphrase (missing, wrong, right), reconnecting by itself
  after the SSH connection dropped, a changed host key (flagged, a wrong fingerprint isn't trust, replacing it
  keeps known_hosts tidy).
- `forward_test.py`: a forward to a web page (and its connection count), the same forward twice is one, a busy
  local port, a forward to nothing (reported), a saved session's forwards starting when it connects and stopping on
  disconnect, the VNC greeting arriving through SSH, and a missing VNC server reported.
- `vnc_ui_test.py`: a desktop tab from a saved session: a wrong VNC password then the right one, typing on the
  desktop, the page not shifting, the forwards dialog, the session editor's fields, reloading the page.
- `record_test.py`: recording a session: the .cast (header, colours, resizes, timing) and the .log (no escape codes,
  progress lines kept as their final text), the listing, downloads, refusing other files, recording every terminal.
- `features_test.py`: the About dialog and notices, trying a theme and cancelling, filtering light themes, recording
  from the terminal's bar, playing it back, saving the terminal's text.
- `ui_test.py`: the whole interface: a saved session, the connect dialog, terminals in tabs, a file tab with a
  drag from one server to the other, editing, permissions, "Terminal here", reloading the page, settings,
  exiting a shell and starting a new one.
