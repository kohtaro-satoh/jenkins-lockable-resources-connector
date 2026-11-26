#!/usr/bin/env bash
# Step 2, as ops, once `ssh ops@<host> sudo -n true` works:
#
#   ssh ops@<host> bash lrrc-e2e/02-lockdown.sh
#
# Turns off root login and password login. The ConoHa image's ssh-rsa
# allowance goes too: the key is ed25519. Existing sessions stay open, and the
# ConoHa console still works if something goes wrong.
set -euo pipefail

# sshd takes the first value it reads, and sshd_config includes this
# directory before its own "PermitRootLogin yes", so a 00- file wins.
sudo tee /etc/ssh/sshd_config.d/00-lrrc-e2e.conf >/dev/null <<'EOF'
# lockable-resources-remote-client-actions E2E server: key login as ops only.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo rm -f /etc/ssh/sshd_config.d/100-allowsshrsa.conf
sudo sshd -t
sudo systemctl restart ssh
sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) '
