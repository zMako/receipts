#!/usr/bin/env bash
# Repoint the stable demo link (https://zmako.github.io/receipts/) at the current tunnel.
#
#   scripts/demo-link.sh https://new-name.trycloudflare.com
#
# Start a fresh tunnel first if the old one died (laptop slept or rebooted):
#   npx -y cloudflared@0.7.3 tunnel --url http://localhost:5173
# then copy the printed trycloudflare.com URL into this script. GitHub Pages republishes in about a minute.
set -euo pipefail
URL="${1:?usage: demo-link.sh https://xxx.trycloudflare.com}"
URL="${URL%/}"
WORK="$(mktemp -d)"
git clone -q --branch gh-pages --depth 1 https://github.com/zMako/receipts.git "$WORK"
cd "$WORK"
sed -i '' -E "s#https://[a-z0-9-]+\.trycloudflare\.com#${URL}#g" index.html
git add index.html
git commit -qm "Point the demo link at ${URL}"
git push -q origin gh-pages
echo "Updated. https://zmako.github.io/receipts/ will redirect to ${URL} within about a minute."
