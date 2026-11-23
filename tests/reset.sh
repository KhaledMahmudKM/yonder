#!/bin/sh
# Start Yonder afresh for a test run: its own ~/.ssh and data folder in /tmp, nothing remembered.
HERE=$(cd "$(dirname "$0")" && pwd)
pkill -f "python3 main.py"; sleep 1
rm -rf /tmp/sshtest/client_ssh /tmp/sshtest/home /home/alice/.ssh /home/bob/.ssh /home/bob/site /home/bob/proj /home/alice/proj
printf 'server {\n  listen 80;\n}\n' > /home/alice/projects/site/nginx.conf; chmod 644 /home/alice/projects/site/nginx.conf; chown alice /home/alice/projects/site/nginx.conf
cd "$HERE/../backend" && (YONDER_SSH_DIR=/tmp/sshtest/client_ssh YONDER_HOME=/tmp/sshtest/home nohup python3 main.py > /tmp/sshtest/app.log 2>&1 &)
sleep 2
