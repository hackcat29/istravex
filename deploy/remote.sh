#!/usr/bin/env bash
# Runs on the VPS (as root, or a user with sudo) for every deploy. Idempotent.
#   TAG          image tag to run (git commit)
#   GHCR_USER    registry user (the workflow's actor)
#   GHCR_TOKEN   short-lived GITHUB_TOKEN, used only for this pull
#   CONFIGURE_UFW=true  also open 22/80/443 in ufw (off by default: use the
#                       Contabo panel firewall, or enable this deliberately)
set -euo pipefail
APP_DIR=/opt/istravex
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

if ! command -v docker > /dev/null 2>&1; then
  echo "installing Docker Engine"
  curl -fsSL https://get.docker.com | $SUDO sh
fi
$SUDO systemctl enable --now docker > /dev/null

if [ "${CONFIGURE_UFW:-false}" = "true" ] && command -v ufw > /dev/null 2>&1; then
  $SUDO ufw allow OpenSSH
  $SUDO ufw allow 80/tcp
  $SUDO ufw allow 443/tcp
  $SUDO ufw allow 443/udp
  $SUDO ufw --force enable
fi

cd "$APP_DIR"
printf 'TAG=%s\n' "$TAG" > .env
echo "$GHCR_TOKEN" | $SUDO docker login ghcr.io -u "$GHCR_USER" --password-stdin > /dev/null
trap '$SUDO docker logout ghcr.io > /dev/null 2>&1 || true' EXIT
$SUDO docker compose pull --quiet
$SUDO docker compose up -d --remove-orphans --wait --wait-timeout 120
$SUDO docker image prune -f > /dev/null
$SUDO docker compose ps
