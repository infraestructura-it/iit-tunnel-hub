'use strict';
// Instaladores autocontenidos por máquina: llevan la configuración y el token incrustados,
// descargan frpc para la arquitectura del equipo y lo dejan como servicio.

const { frpcToml } = require('./machines');

const FRP_VERSION = '0.71.0';
const RELEASES = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`;

function header(machine, comment) {
  return [
    `${comment} Instalador de IIT Tunnel Hub`,
    `${comment} Máquina: ${machine.name}${machine.client ? ' · Cliente: ' + machine.client : ''} (${machine.id})`,
    `${comment} Generado: ${new Date().toISOString()}`,
    `${comment} ⚠ Contiene el token de la máquina: no lo comparta ni lo suba a repositorios.`,
  ].join('\n');
}

// ---------- Linux: Raspberry Pi, tarjetas ARM, PC, servidores ----------

function linuxInstaller(machine, services, frps, token, serverAddr) {
  const toml = frpcToml(machine, services, frps, token, { serverAddr, certDir: '/etc/iit-frpc/certs' });
  if (toml.split('\n').some((l) => l.trim() === 'IIT_FRPC_TOML')) throw new Error('marcador reservado en la configuración');

  return `#!/usr/bin/env bash
${header(machine, '#')}
#
# Uso:            sudo bash instalar-${machine.id}.sh
# Desinstalar:    sudo bash instalar-${machine.id}.sh --desinstalar
#
# Compatible con Debian, Ubuntu, Raspberry Pi OS, Armbian y similares (amd64, arm64, armv7, armv6).
set -euo pipefail

FRP_VERSION="${FRP_VERSION}"
MACHINE_ID="${machine.id}"
SERVER="${serverAddr}:${frps.bindPort}"
DIR=/etc/iit-frpc
BIN=/usr/local/bin/iit-frpc
UNIT=/etc/systemd/system/iit-frpc.service

ok()   { printf '\\033[32m✔\\033[0m %s\\n' "$*"; }
info() { printf '\\033[36m→\\033[0m %s\\n' "$*"; }
err()  { printf '\\033[31m✘\\033[0m %s\\n' "$*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then exec sudo bash "$0" "$@"; fi
  err "Ejecute como root:  sudo bash $0"; exit 1
fi

has_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

stop_frpc() {
  if has_systemd; then systemctl disable --now iit-frpc >/dev/null 2>&1 || true; fi
  pkill -f "$BIN -c $DIR/frpc.toml" 2>/dev/null || true
  if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v 'iit-frpc' || true) | crontab - 2>/dev/null || true
  fi
}

if [ "\${1:-}" = "--desinstalar" ]; then
  info "Desinstalando IIT frpc…"
  stop_frpc
  rm -f "$UNIT" "$BIN"; rm -rf "$DIR"
  has_systemd && systemctl daemon-reload || true
  ok "Desinstalado. La máquina ya no se conecta al servidor."
  exit 0
fi

echo
info "IIT Tunnel Hub · instalando la máquina $MACHINE_ID"
info "Servidor: $SERVER"

case "$(uname -m)" in
  x86_64|amd64)        ARCH=amd64 ;;
  aarch64|arm64)       ARCH=arm64 ;;
  armv7l|armv7|armv6l) ARCH=arm ;;
  riscv64)             ARCH=riscv64 ;;
  *) err "Arquitectura no soportada: $(uname -m)"; exit 1 ;;
esac
ok "Arquitectura: $(uname -m) → $ARCH"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else err "Se necesita curl o wget"; exit 1; fi
}

if [ -x "$BIN" ] && "$BIN" --version 2>/dev/null | grep -qx "$FRP_VERSION"; then
  ok "frpc $FRP_VERSION ya instalado"
else
  info "Descargando frpc $FRP_VERSION…"
  TMP="$(mktemp -d)"
  fetch "${RELEASES}/frp_\${FRP_VERSION}_linux_\${ARCH}.tar.gz" | tar xz -C "$TMP"
  install -m 755 "$TMP/frp_\${FRP_VERSION}_linux_\${ARCH}/frpc" "$BIN"
  rm -rf "$TMP"
  ok "frpc instalado en $BIN"
fi

stop_frpc
mkdir -p "$DIR/certs"
umask 077
cat > "$DIR/frpc.toml" <<'IIT_FRPC_TOML'
${toml.trimEnd()}
IIT_FRPC_TOML
chmod 600 "$DIR/frpc.toml"
ok "Configuración en $DIR/frpc.toml"

"$BIN" verify -c "$DIR/frpc.toml" >/dev/null || { err "La configuración no es válida"; exit 1; }
START="$(date '+%Y-%m-%d %H:%M:%S')"

if has_systemd; then
  cat > "$UNIT" <<IIT_UNIT
[Unit]
Description=IIT Tunnel Hub · frpc ($MACHINE_ID)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$BIN -c $DIR/frpc.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
IIT_UNIT
  systemctl daemon-reload
  systemctl enable --now iit-frpc >/dev/null
  ok "Servicio iit-frpc activo (arranca con el sistema)"
  read_log() { journalctl -u iit-frpc --since "$START" --no-pager 2>/dev/null; }
  LOGHINT="journalctl -u iit-frpc -n 50"
else
  info "Sin systemd: se usa cron @reboot"
  nohup "$BIN" -c "$DIR/frpc.toml" > "$DIR/frpc.log" 2>&1 &
  if command -v crontab >/dev/null 2>&1; then
    ( (crontab -l 2>/dev/null | grep -v 'iit-frpc' || true); echo "@reboot $BIN -c $DIR/frpc.toml > $DIR/frpc.log 2>&1 # iit-frpc" ) | crontab -
    ok "Arranque automático registrado en cron"
  else
    err "No hay cron: frpc quedó corriendo pero no arrancará solo tras reiniciar"
  fi
  read_log() { tail -n 50 "$DIR/frpc.log" 2>/dev/null; }
  LOGHINT="tail -n 50 $DIR/frpc.log"
fi

info "Verificando conexión con el servidor…"
for _ in $(seq 1 15); do
  sleep 1
  LOG="$(read_log || true)"
  if echo "$LOG" | grep -q "login to server success"; then
    echo; ok "¡Conectada! La máquina $MACHINE_ID ya aparece en línea en el panel."; exit 0
  fi
  if echo "$LOG" | grep -qE "token|inválid|no registrada|deshabilitada"; then
    echo; err "El servidor rechazó la conexión:"; echo "$LOG" | grep -E "error" | tail -n 2
    stop_frpc
    err "Se detuvo frpc. Genere un instalador nuevo desde el panel (Rotar token) y vuelva a ejecutarlo."
    exit 1
  fi
done
echo
err "No se confirmó la conexión en 15 s. Revise que el equipo llegue a $SERVER"
echo "   Registro:  $LOGHINT"
exit 1
`;
}

// ---------- Windows: PC, servidores, mini PC ----------

function windowsInstaller(machine, services, frps, token, serverAddr) {
  const toml = frpcToml(machine, services, frps, token, {
    serverAddr,
    certDir: '__IIT_DIR__\\certs',
    extra: [`log.to = '__IIT_DIR__\\frpc.log'`, `log.maxDays = 3`],
  });
  if (toml.split('\n').some((l) => l.startsWith("'@"))) throw new Error('secuencia reservada en la configuración');

  // BOM UTF-8: Windows PowerShell 5.1 lee los .ps1 sin BOM como ANSI y rompe los caracteres
  return `\uFEFF${header(machine, '#')}
#
# Uso (PowerShell como ADMINISTRADOR para que arranque con el equipo):
#   powershell -ExecutionPolicy Bypass -File .\\instalar-${machine.id}.ps1
# Sin administrador se instala para el usuario actual y arranca al iniciar sesión.
# Desinstalar:
#   powershell -ExecutionPolicy Bypass -File .\\instalar-${machine.id}.ps1 -Desinstalar

param([switch]$Desinstalar)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = "Tls12"

$FrpVersion = "${FRP_VERSION}"
$MachineId  = "${machine.id}"
$Server     = "${serverAddr}:${frps.bindPort}"
$TaskName   = "IIT frpc"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrators")
$Dir   = if ($admin) { Join-Path $env:ProgramData "iit-frpc" } else { Join-Path $env:LOCALAPPDATA "iit-frpc" }
$Exe   = Join-Path $Dir "frpc.exe"
$Conf  = Join-Path $Dir "frpc.toml"
$Log   = Join-Path $Dir "frpc.log"

function Ok($m)   { Write-Host "  ✔ $m" -ForegroundColor Green }
function Info($m) { Write-Host "  → $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "  ✘ $m" -ForegroundColor Red }

function Stop-Frpc {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Get-Process frpc -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

if ($Desinstalar) {
  Info "Desinstalando IIT frpc…"
  Stop-Frpc
  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
  Ok "Desinstalado. La máquina ya no se conecta al servidor."
  exit 0
}

Write-Host ""
Info "IIT Tunnel Hub · instalando la máquina $MachineId"
Info "Servidor: $Server"
if ($admin) { Ok "Modo administrador: arrancará con el equipo ($Dir)" }
else { Write-Host "  ! Sin administrador: arrancará al iniciar sesión este usuario ($Dir)" -ForegroundColor Yellow }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
New-Item -ItemType Directory -Force (Join-Path $Dir "certs") | Out-Null
Stop-Frpc

if ($admin) {
  try { Add-MpPreference -ExclusionPath $Dir; Ok "Exclusión de Windows Defender agregada" }
  catch { Write-Host "  ! No se pudo agregar la exclusión de Defender" -ForegroundColor Yellow }
}

$ver = if (Test-Path $Exe) { (& $Exe --version 2>$null) } else { "" }
if ($ver -eq $FrpVersion) { Ok "frpc $FrpVersion ya instalado" }
else {
  Info "Descargando frpc $FrpVersion ($arch)…"
  $zip = Join-Path $env:TEMP "iit-frp.zip"
  $tmp = Join-Path $env:TEMP "frp_\${FrpVersion}_windows_$arch"
  Invoke-WebRequest "${RELEASES}/frp_\${FrpVersion}_windows_$arch.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $env:TEMP -Force
  Copy-Item (Join-Path $tmp "frpc.exe") $Exe -Force
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  if (-not (Test-Path $Exe)) {
    Fail "Windows Defender eliminó frpc.exe. Ejecute este instalador como administrador,"
    Fail "o permita el archivo en Seguridad de Windows > Historial de protección."
    exit 1
  }
  Ok "frpc instalado en $Exe"
}

$toml = @'
${toml.trimEnd()}
'@
$toml = $toml.Replace("__IIT_DIR__", $Dir)
[IO.File]::WriteAllText($Conf, $toml, (New-Object Text.UTF8Encoding $false))
Ok "Configuración en $Conf"

& $Exe verify -c $Conf | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "La configuración no es válida"; exit 1 }
Remove-Item $Log -ErrorAction SilentlyContinue

$action   = New-ScheduledTaskAction -Execute $Exe -Argument "-c \`"$Conf\`"" -WorkingDirectory $Dir
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable \`
              -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
if ($admin) {
  $trigger   = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
} else {
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Ok "Tarea programada '$TaskName' creada e iniciada"

Info "Verificando conexión con el servidor…"
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  $content = if (Test-Path $Log) { Get-Content $Log -Raw } else { "" }
  if ($content -match "login to server success") {
    Write-Host ""; Ok "¡Conectada! La máquina $MachineId ya aparece en línea en el panel."; exit 0
  }
  if ($content -match "token|inválid|no registrada|deshabilitada") {
    Write-Host ""; Fail "El servidor rechazó la conexión:"
    ($content -split "\`n" | Select-String "error" | Select-Object -Last 2) | ForEach-Object { Write-Host "    $_" }
    Stop-Frpc
    Fail "Se detuvo frpc. Genere un instalador nuevo desde el panel (Rotar token) y vuelva a ejecutarlo."
    exit 1
  }
}
Write-Host ""
Fail "No se confirmó la conexión en 15 s. Revise que el equipo llegue a $Server"
Write-Host "    Registro: $Log"
exit 1
`;
}

const PLATFORMS = {
  linux: { ext: 'sh', build: linuxInstaller, type: 'text/x-shellscript; charset=utf-8' },
  windows: { ext: 'ps1', build: windowsInstaller, type: 'text/plain; charset=utf-8' },
};

module.exports = { PLATFORMS, FRP_VERSION };
