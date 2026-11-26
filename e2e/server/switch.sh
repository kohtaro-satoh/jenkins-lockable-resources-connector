#!/usr/bin/env bash
# Runs the E2E Jenkins with the given lockable-resources version, building its
# image first if needed. Memory allows only one Jenkins at a time.
#
#   switch.sh 1560|latest        (REBUILD=1 to rebuild the image, e.g. for a newer "latest")
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
  1560) version=1560.va_b_cd589f23eb_ ;;
  latest) version=latest ;;
  *) echo "usage: $0 1560|latest" >&2; exit 2 ;;
esac
lr=$1
domain=$(sed -n 's/^E2E_DOMAIN=//p' .env)
[[ -n "$domain" ]] || { echo "E2E_DOMAIN missing in .env (run 04-jenkins.sh)" >&2; exit 1; }

if [[ "${REBUILD:-}" == 1 ]] || ! docker image inspect "lrrc-e2e-jenkins:$lr" >/dev/null 2>&1; then
  docker build --pull --build-arg "LR_VERSION=$version" -t "lrrc-e2e-jenkins:$lr" jenkins
fi

printf 'E2E_DOMAIN=%s\nLR=%s\n' "$domain" "$lr" >.env
docker compose up -d --force-recreate --remove-orphans

echo "waiting for Jenkins..."
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/jenkins/login || true)
  [[ "$code" == 200 ]] && break
  sleep 3
done
[[ "$code" == 200 ]] || { docker logs --tail 50 lrrc-e2e-jenkins; docker stop lrrc-e2e-jenkins; exit 1; }
log=$(docker logs lrrc-e2e-jenkins 2>&1)
grep -E '\[e2e\]|SEVERE|Failed to run script' <<<"$log" || true
# Fail closed: with the setup wizard off, a Jenkins whose init scripts did not
# all finish may be open to anyone. Do not leave it running.
for marker in 'users, tokens and permissions set' 'remote API on' 'jobs e2e-admin and e2e-holder ready'; do
  if ! grep -qF "[e2e] $marker" <<<"$log"; then
    echo "init script did not finish ($marker); stopping Jenkins" >&2
    docker stop lrrc-e2e-jenkins >/dev/null
    exit 1
  fi
done
running=$(docker exec lrrc-e2e-jenkins \
  sed -n 's/^Plugin-Version: //p' /var/jenkins_home/plugins/lockable-resources/META-INF/MANIFEST.MF | tr -d '\r')
echo "running: lockable-resources $running ($lr)"
