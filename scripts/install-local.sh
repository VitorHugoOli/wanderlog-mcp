#!/usr/bin/env bash
# Build and install this fork where MCP clients run it from.
#
# Installed outside ~/Desktop on purpose: macOS privacy protection (TCC) can
# block or prompt for apps (Claude Desktop) spawning code from Desktop/Documents.
# Clients point at:  node ~/.local/share/wanderlog-mcp/app/dist/index.js
# Re-run after every change; running sessions pick it up when restarted.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${WANDERLOG_INSTALL_DIR:-$HOME/.local/share/wanderlog-mcp/app}"

npm run build >/dev/null
mkdir -p "$TARGET"
rm -rf "$TARGET/dist"
cp -R dist "$TARGET/dist"
cp package.json package-lock.json "$TARGET/"
(cd "$TARGET" && npm ci --omit=dev --ignore-scripts --silent)
echo "installed $(node -p "require('./package.json').version") ($(git rev-parse --short HEAD)) to $TARGET"
