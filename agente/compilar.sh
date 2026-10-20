#!/usr/bin/env bash
# Compila iit-agente para los equipos Linux (Raspberry Pi 32/64 bits y PC) en agente/dist/.
# Requiere Go ≥ 1.23. Sin acceso a proxy.golang.org: GOPROXY=direct GOSUMDB=off ./agente/compilar.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
build() { echo "  $1/$2${3:+ (GOARM=$3)}"; CGO_ENABLED=0 GOOS=$1 GOARCH=$2 GOARM=${3:-} go build -trimpath -ldflags "-s -w" -o "dist/iit-agente-$1-$4" .; }
build linux arm 6 arm      # Raspberry Pi OS 32 bits (armv6/armv7)
build linux arm64 "" arm64 # Raspberry Pi OS 64 bits
build linux amd64 "" amd64 # PC / servidor Linux
( cd dist && sha256sum iit-agente-* > SHA256SUMS )
ls -la dist
