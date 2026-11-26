#!/usr/bin/env bash
# Step 1 on a fresh ConoHa Ubuntu 26.04 VPS (docs/PLAN.md §10.3), as root:
#
#   scp -r e2e/server root@<host>:lrrc-e2e && ssh root@<host> bash lrrc-e2e/01-bootstrap.sh
#
# Creates the work user "ops" (the same SSH key as root, passwordless sudo),
# opens only 22/80/443 in ufw and brings the packages up to date. Root login
# stays on until step 2, so a mistake here cannot lock anyone out.
# Safe to run again.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
OPS=ops

echo "== user $OPS"
id "$OPS" >/dev/null 2>&1 || adduser --disabled-password --comment '' "$OPS" </dev/null
usermod -aG sudo "$OPS"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$OPS" >/etc/sudoers.d/90-$OPS
chmod 0440 /etc/sudoers.d/90-$OPS
visudo -cf /etc/sudoers.d/90-$OPS
install -d -m 0700 -o "$OPS" -g "$OPS" /home/$OPS/.ssh
install -m 0600 -o "$OPS" -g "$OPS" /root/.ssh/authorized_keys /home/$OPS/.ssh/authorized_keys

echo "== firewall"
ufw allow OpenSSH
ufw allow 80/tcp comment 'http: ACME challenge, redirect to https'
ufw allow 443/tcp comment 'https: Caddy -> Jenkins'
# The ConoHa security group "Web" also opens FTP (20/21); nothing here uses it.
ufw deny 20:21/tcp comment 'ftp: not used'
ufw --force enable
ufw status verbose

echo "== packages"
apt-get update -q </dev/null
apt-get -y -q -o Dpkg::Options::=--force-confold full-upgrade </dev/null
apt-get -y -q autoremove </dev/null
if [[ -f /var/run/reboot-required ]]; then
  echo "REBOOT REQUIRED: $(tr '\n' ' ' </var/run/reboot-required.pkgs 2>/dev/null)"
fi
