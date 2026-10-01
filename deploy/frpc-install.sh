#!/usr/bin/env bash
# Instala frpc como servicio en una máquina Linux (gateway, Raspberry Pi, mini PC…).
# Uso:  sudo ./frpc-install.sh frpc-<maquina>.toml
# Para Windows vea la sección "Máquinas Windows" del README.
set -euo pipefail

FRP_VERSION="${FRP_VERSION:-0.71.0}"
CONF="${1:-}"

[ "$(id -u)" -eq 0 ] || { echo "Ejecute como root (sudo)."; exit 1; }
[ -f "$CONF" ] || { echo "Uso: sudo $0 frpc-<maquina>.toml   (descárguelo desde el panel)"; exit 1; }
grep -q 'PEGUE_AQUI_EL_TOKEN' "$CONF" && { echo "El archivo no tiene token: pegue el token de la máquina en metadatas.token."; exit 1; }

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; armv7l|armv6l) ARCH=arm ;;
  *) echo "Arquitectura no soportada: $(uname -m)"; exit 1 ;;
esac

echo "→ frpc v$FRP_VERSION ($ARCH)"
curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz" | tar xz -C /tmp
install -m 755 "/tmp/frp_${FRP_VERSION}_linux_${ARCH}/frpc" /usr/local/bin/frpc
rm -rf "/tmp/frp_${FRP_VERSION}_linux_${ARCH}"

echo "→ Configuración en /etc/frp/frpc.toml"
mkdir -p /etc/frp/certs
install -m 600 "$CONF" /etc/frp/frpc.toml

cat > /etc/systemd/system/frpc.service <<'EOF'
[Unit]
Description=frpc (IIT Tunnel Hub)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/etc/frp
ExecStart=/usr/local/bin/frpc -c /etc/frp/frpc.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now frpc
sleep 2
systemctl --no-pager --lines=5 status frpc || true
echo
echo "Listo. Si usa servicios https con TLS en la máquina, ponga el certificado en /etc/frp/certs/"
