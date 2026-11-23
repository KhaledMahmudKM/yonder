#!/bin/sh
# Two throwaway SSH servers to test Yonder against, on a Linux machine where you're root
# (a VM or container: it adds the users alice and bob):
#   127.0.0.1:2222  alice / alicepw   password login
#   127.0.0.1:2223  bob   / bobpw     keyboard-interactive login only
set -e
D=/tmp/sshtest
mkdir -p /run/sshd $D
for u in alice bob; do id $u >/dev/null 2>&1 || useradd -m -s /bin/bash $u; done
echo 'alice:alicepw' | chpasswd; echo 'bob:bobpw' | chpasswd
mkdir -p /home/alice/projects/site && echo "<h1>hello</h1>" > /home/alice/projects/site/index.html && chown -R alice /home/alice/projects
for n in a b; do [ -f $D/host_$n ] || ssh-keygen -q -t ed25519 -N '' -f $D/host_$n; done
cat > $D/sshd_a <<CONF
Port 2222
ListenAddress 127.0.0.1
HostKey $D/host_a
PasswordAuthentication yes
KbdInteractiveAuthentication no
UsePAM yes
Subsystem sftp internal-sftp
PidFile $D/a.pid
CONF
sed -e 's/2222/2223/; s/host_a/host_b/; s/a.pid/b.pid/; s/KbdInteractiveAuthentication no/KbdInteractiveAuthentication yes/; s/PasswordAuthentication yes/PasswordAuthentication no/' $D/sshd_a > $D/sshd_b
/usr/sbin/sshd -f $D/sshd_a -E $D/a.log
/usr/sbin/sshd -f $D/sshd_b -E $D/b.log
echo "SSH servers on 127.0.0.1:2222 (alice) and 127.0.0.1:2223 (bob)"
