#!/usr/bin/env bash
# Step 3, as ops: Docker Engine and Compose from the Ubuntu archive.
#
#   ssh ops@<host> bash lrrc-e2e/03-docker.sh
#
# Containers publish ports on 127.0.0.1 only: Docker's port publishing goes
# around ufw, so anything bound to 0.0.0.0 would be open to the internet.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

sudo -E apt-get install -y -q docker.io docker-compose-v2 </dev/null
# Bounded logs: the disk should not fill up between runs.
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sudo systemctl restart docker
sudo usermod -aG docker "$USER"
sudo docker version --format 'docker {{.Server.Version}}'
sudo docker compose version
