#!/usr/bin/env bash
# Step 4, as ops: Caddy (https) in front of the E2E Jenkins.
#
#   ssh ops@<host> bash lrrc-e2e/04-jenkins.sh <domain> [1560|latest]
#
# The domain's A record must point here and the ConoHa security group must
# open 80 and 443, or Let's Encrypt cannot issue the certificate.
#
# Secrets are made once and kept in secrets.env (mode 600, never in git):
# the admin password, used only over SSH, and the API tokens of e2e-robot,
# e2e-ops and e2e-norights, which go into the repository's GitHub secrets.
set -euo pipefail
domain=${1:?usage: $0 <domain> [1560|latest]}
lr=${2:-latest}
cd "$(dirname "$0")"
export DEBIAN_FRONTEND=noninteractive

if [[ ! -f secrets.env ]]; then
  # Jenkins API tokens: "11" and 32 hex digits (what addFixedNewToken accepts).
  token() { printf '11%s' "$(openssl rand -hex 16)"; }
  (umask 077 && cat >secrets.env <<EOF
E2E_ADMIN_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
E2E_ROBOT_TOKEN=$(token)
E2E_OPS_TOKEN=$(token)
E2E_NORIGHTS_TOKEN=$(token)
EOF
  )
fi
printf 'E2E_DOMAIN=%s\nLR=%s\n' "$domain" "$lr" >.env

sudo -E apt-get install -y -q caddy </dev/null
sed "s/@DOMAIN@/$domain/" Caddyfile.in | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable caddy
sudo systemctl restart caddy

./switch.sh "$lr"

echo "checking https://$domain/jenkins/login ..."
for _ in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$domain/jenkins/login" || true)
  [[ "$code" == 200 ]] && break
  sleep 3
done
echo "https: HTTP $code"
