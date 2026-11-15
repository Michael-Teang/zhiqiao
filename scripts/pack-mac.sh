#!/usr/bin/env bash
# pack-mac.sh — 打包 macOS .app 到 dist/（在 macOS 上运行）。
# 用法: bash scripts/pack-mac.sh [arm64|x64]
set -euo pipefail

ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "unsupported arch: $ARCH (use arm64 or x64)"; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLOUD="resources/cloudflared-$ARCH"
if [ ! -f "$ROOT/$CLOUD" ]; then
  echo "缺少 $CLOUD，先运行: npm run fetch:cloudflared"
  exit 2
fi

npx @electron/packager "$ROOT" "智桥-zhiqiao" \
  --platform=darwin \
  --arch="$ARCH" \
  --electron-version=38.2.1 \
  --asar \
  --prune \
  --overwrite \
  --out="$ROOT/dist" \
  --ignore='^/dist' \
  --ignore='^/\.git' \
  --ignore='^/node_modules/\.cache'

APP="$ROOT/dist/智桥-zhiqiao-darwin-$ARCH/智桥-zhiqiao.app"
cp "$ROOT/$CLOUD" "$APP/Contents/Resources/cloudflared-$ARCH"
chmod +x "$APP/Contents/Resources/cloudflared-$ARCH"
cp "$ROOT/docs/使用说明-mac.txt" "$ROOT/dist/智桥-zhiqiao-darwin-$ARCH/使用说明.txt"

echo "packed: $APP"
