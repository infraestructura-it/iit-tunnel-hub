#!/usr/bin/env bash
# Instalación sin Docker en Debian/Ubuntu (VPS o servidor local), con systemd.
# Uso (como root, desde la carpeta del proyecto):   sudo ./deploy/install.sh
set -euo pipefail

FRP_VERSION="${FRP_VERSION:-0.71.0}"
PREFIX=/opt/iit-tunnel-hub
SRC="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Ejecute como root (sudo)."; exit 1; }

# Node >= 22.13 (trae node:sqlite)
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Se requiere Node.js 22.13 o superior. En Debian/Ubuntu:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
  exit 1
fi

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; armv7l|armv6l) ARCH=arm ;;
  *) echo "Arquitectura no soportada: $(uname -m)"; exit 1 ;;
esac

echo "→ Usuario de servicio"
id iit-hub >/dev/null 2>&1 || useradd --system --home "$PREFIX" --shell /usr/sbin/nologin iit-hub

echo "→ Archivos en $PREFIX"
mkdir -p "$PREFIX"
cp -r "$SRC/api" "$SRC/frps" "$PREFIX/"
if [ ! -f "$PREFIX/.env" ]; then
  cp "$SRC/.env.example" "$PREFIX/.env"
  sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-40)|" "$PREFIX/.env"
  sed -i "s|^FRPS_API_PASSWORD=.*|FRPS_API_PASSWORD=$(openssl rand -hex 16)|" "$PREFIX/.env"
  CREATED_ENV=1
fi
chown -R root:iit-hub "$PREFIX" && chmod 640 "$PREFIX/.env"

echo "→ frps v$FRP_VERSION ($ARCH)"
curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz" | tar xz -C /tmp
install -m 755 "/tmp/frp_${FRP_VERSION}_linux_${ARCH}/frps" /usr/local/bin/frps
rm -rf "/tmp/frp_${FRP_VERSION}_linux_${ARCH}"

echo "→ Servicios systemd"
install -m 644 "$SRC/deploy/systemd/iit-hub.service" /etc/systemd/system/
install -m 644 "$SRC/deploy/systemd/iit-frps.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable iit-hub iit-frps >/dev/null

if [ "${CREATED_ENV:-0}" = 1 ]; then
  echo
  echo "Se creó $PREFIX/.env con tokens aleatorios."
  echo "Edite FRPS_PUBLIC_ADDR y FRPS_SUBDOMAIN_HOST y luego arranque:"
  echo "  sudo systemctl start iit-hub iit-frps"
  echo
  echo "Token del panel:  $(grep ^ADMIN_TOKEN= "$PREFIX/.env" | cut -d= -f2-)"
else
  systemctl restart iit-hub iit-frps
  echo "Servicios reiniciados."
fi
