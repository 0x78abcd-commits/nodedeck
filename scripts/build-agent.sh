#!/usr/bin/env bash
# 本地开发用：编译 agent 到 resources/agent（需要安装 Go）
set -e
cd "$(dirname "$0")/../agent"
mkdir -p ../resources/agent
for a in amd64 arm64 arm 386; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$a GOARM=7 go build -trimpath -ldflags "-s -w -X main.version=dev" -o /tmp/nodedeck-agent-$a .
  gzip -9c /tmp/nodedeck-agent-$a > ../resources/agent/nodedeck-agent-linux-$a.gz
done
echo "ok: resources/agent"
