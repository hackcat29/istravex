#!/usr/bin/env bash
# Runs on the VPS for every deploy (as root, or a user with sudo). Idempotent.
#   TAG          image tag to run (git commit)
#   GHCR_USER    registry user (the workflow's actor)
#   GHCR_TOKEN   short-lived GITHUB_TOKEN, used only for this pull
#
# The VPS is shared with other sites behind the host's nginx. This script only
# touches /opt/istravex, its own container, and its own nginx site
# (istravex-api.conf); every nginx change is checked with `nginx -t` and
# rolled back if it fails, so a bad config can never take other sites down.
set -euo pipefail
APP_DIR=/opt/istravex
SITE=/etc/nginx/sites-available/istravex-api.conf
LINK=/etc/nginx/sites-enabled/istravex-api.conf
CERT_NAME=istravex-api
CERT=/etc/letsencrypt/live/${CERT_NAME}/fullchain.pem
WEBROOT=/var/www/certbot
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

# Docker, nginx and certbot are shared with the host's other sites: require
# them, never install or reconfigure them from here.
for bin in docker nginx certbot; do
  command -v "$bin" > /dev/null 2>&1 || { echo "$bin is required on the VPS" >&2; exit 1; }
done
$SUDO docker compose version > /dev/null 2>&1 || { echo "the Docker Compose plugin is required on the VPS" >&2; exit 1; }

# ── Container ────────────────────────────────────────────────────────────
cd "$APP_DIR"
printf 'TAG=%s\n' "$TAG" > .env
echo "$GHCR_TOKEN" | $SUDO docker login ghcr.io -u "$GHCR_USER" --password-stdin > /dev/null
trap '$SUDO docker logout ghcr.io > /dev/null 2>&1 || true' EXIT
$SUDO docker compose pull --quiet
$SUDO docker compose up -d --remove-orphans --wait --wait-timeout 120
# Remove only this project's superseded images; other projects share the host.
$SUDO docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/hackcat29/istravex" > /dev/null

# ── nginx ────────────────────────────────────────────────────────────────
install_site() {
  local src=$1 backup=""
  if [ -f "$SITE" ]; then backup=$(mktemp) && cp "$SITE" "$backup"; fi
  $SUDO cp "$src" "$SITE"
  $SUDO ln -sf "$SITE" "$LINK"
  if ! $SUDO nginx -t > /dev/null 2>&1; then
    echo "nginx -t failed with $(basename "$src"); restoring the previous config" >&2
    $SUDO nginx -t || true
    if [ -n "$backup" ]; then $SUDO cp "$backup" "$SITE"; else $SUDO rm -f "$SITE" "$LINK"; fi
    $SUDO nginx -t
    exit 1
  fi
  $SUDO systemctl reload nginx
  [ -z "$backup" ] || rm -f "$backup"
}

$SUDO mkdir -p "$WEBROOT"
if [ ! -f "$CERT" ]; then
  echo "no certificate yet: bootstrapping over HTTP, then requesting one"
  install_site "$APP_DIR/nginx/istravex-api.http.conf"
  $SUDO certbot certonly --webroot -w "$WEBROOT" --cert-name "$CERT_NAME" \
    -d api.istravex.com -d rpc.istravex.com \
    --non-interactive --agree-tos --keep-until-expiring \
    --deploy-hook "systemctl reload nginx"
fi
install_site "$APP_DIR/nginx/istravex-api.conf"

$SUDO docker compose ps
