#!/usr/bin/env bash
# Deploy discord-index to a remote Linux host over SSH: rsync the project, build it, and install
# user systemd units for the sync timer and the loopback MCP server.
#
#   bash scripts/install-remote.sh <ssh-host>
set -euo pipefail

HOST="${1:?usage: install-remote.sh <ssh-host>}"
REMOTE_DIR="discord-index"

echo "==> syncing project to ${HOST}:~/${REMOTE_DIR}"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude data \
  --exclude .git --exclude .env --exclude policy.yaml \
  ./ "${HOST}:${REMOTE_DIR}/"

echo "==> installing on ${HOST}"
ssh "$HOST" bash -euo pipefail <<REMOTE
cd "${REMOTE_DIR}"
corepack enable >/dev/null 2>&1 || true
pnpm install --prod=false
pnpm build

mkdir -p ~/.config/systemd/user
cp deploy/discord-index-sync.service  ~/.config/systemd/user/
cp deploy/discord-index-sync.timer    ~/.config/systemd/user/
cp deploy/discord-index-mcp.service   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now discord-index-sync.timer
systemctl --user enable --now discord-index-mcp.service
# Keep the timer running when nobody is logged in.
loginctl enable-linger \$USER || true
systemctl --user status discord-index-mcp.service --no-pager | head -5
REMOTE

cat <<NOTE

Next on ${HOST}:
  1. scp your .env:   scp .env ${HOST}:${REMOTE_DIR}/.env
  2. first backfill:  ssh ${HOST} 'cd ${REMOTE_DIR} && node dist/cli.js sync --full'
  3. point an MCP client at it, e.g. openclaw:
       ssh ${HOST} "openclaw mcp set discord-index '{\"url\":\"http://127.0.0.1:8087/mcp\",\"transport\":\"streamable-http\"}'"
  4. reach it from your laptop:  ssh -L 8087:127.0.0.1:8087 ${HOST}
NOTE
