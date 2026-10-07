'use strict';
// Instalación con código de un solo uso: el administrador genera un código en el panel y en el equipo
// cliente se pega UNA línea que descarga un arranque mínimo desde el hub. Ese arranque canjea el código
// (POST /api/enroll) y recibe el instalador normal con el token, directo por la conexión al hub: ningún
// archivo con secretos viaja por correo, USB o carpetas compartidas.
//
// El arranque se ejecuta con "irm … | iex" (Windows) o "curl … | sudo bash" (Linux). Se escribe solo
// con ASCII: Windows PowerShell 5.1 puede leer mal los acentos de un texto descargado.

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para que se lean sin dudas
const CODE_LEN = 12;                                  // 60 bits: imposible de adivinar en su vigencia
const MINUTES = { min: 5, def: 30, max: 1440 };
const PLATFORMS = ['windows', 'linux'];

function newCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Normaliza lo que escribió o pegó la persona. null si no tiene forma de código. */
function normalizeCode(v) {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== CODE_LEN || [...s].some((c) => !ALPHABET.includes(c))) return null;
  return s;
}
const hashCode = (norm) => crypto.createHash('sha256').update('iit-enroll:' + norm).digest('hex');
const hintOf = (norm) => norm.slice(-4);

/** Nombre del equipo tal como lo reporta el arranque, limpio para usarlo como nombre de máquina. */
function cleanHost(v) {
  const s = String(v ?? '').replace(/[^A-Za-z0-9.-]/g, '').replace(/^[.-]+|[.-]+$/g, '').slice(0, 63);
  return s || 'equipo';
}

/** URL con la que el equipo cliente llega al hub: HUB_PUBLIC_URL o la que usó quien hace la petición. */
function baseUrl(req, config) {
  if (config.hubPublicUrl) return config.hubPublicUrl;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!/^[A-Za-z0-9.\-[\]:]{1,200}$/.test(host)) return null;
  return `${proto}://${host}`;
}

const isLoopbackHost = (h) => { h = String(h || '').replace(/^\[|\]$/g, ''); return h === 'localhost' || h === '::1' || /^127\./.test(h); };

/** ¿La URL solo sirve en este mismo equipo? (el equipo cliente no la alcanzaría) */
function isLoopback(url) {
  try { return isLoopbackHost(new URL(url).hostname); } catch { return true; }
}

/**
 * Servidor frps para el equipo: si quedó 127.0.0.1 pero el hub se abrió por una dirección de red,
 * 127.0.0.1 en el equipo sería él mismo. Se usa la dirección del hub (frps corre en el mismo servidor).
 */
function effectiveServerAddr(serverAddr, base) {
  if (!isLoopbackHost(serverAddr) || !base || isLoopback(base)) return { serverAddr, adjusted: false };
  return { serverAddr: new URL(base).hostname.replace(/^\[|\]$/g, ''), adjusted: true };
}

function commands(base, code) {
  return {
    windows: `[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm ${base}/i/${code}/windows | iex`,
    linux: `curl -fsSL ${base}/i/${code}/linux | sudo bash`,
  };
}

// ---------- arranques ----------

function windowsBootstrap(base, code) {
  // Todo va dentro de "& { }" y termina con return: un "exit" cerraría la ventana de PowerShell
  return `& {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $hub  = '${base}'
  $code = '${code}'
  Write-Host ''
  Write-Host '  IIT Tunnel Hub - instalacion con codigo' -ForegroundColor Cyan
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Write-Host '  ! PowerShell no esta como administrador: frpc arrancara solo al iniciar sesion este usuario.' -ForegroundColor Yellow
    Write-Host '    Para que arranque con el equipo, cierre y abra PowerShell como administrador antes de pegar el comando.' -ForegroundColor Yellow
  }
  Write-Host '  -> Canjeando el codigo en el hub...' -ForegroundColor Cyan
  try {
    $body = @{ code = $code; platform = 'windows'; hostname = $env:COMPUTERNAME } | ConvertTo-Json -Compress
    $script = Invoke-RestMethod -Method Post -Uri "$hub/api/enroll" -Body $body -ContentType 'application/json; charset=utf-8' -UseBasicParsing
  } catch {
    $msg = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch { $msg = $_.ErrorDetails.Message } }
    if (-not $msg) { $msg = $_.Exception.Message }
    Write-Host "  X No se pudo canjear el codigo: $msg" -ForegroundColor Red
    return
  }
  if (-not ($script -is [string]) -or $script -notmatch 'IIT Tunnel Hub') {
    Write-Host '  X El hub no devolvio un instalador valido.' -ForegroundColor Red
    return
  }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('iit-instalar-' + [guid]::NewGuid().ToString('N') + '.ps1')
  try {
    [IO.File]::WriteAllText($tmp, $script.TrimStart([char]0xFEFF), (New-Object Text.UTF8Encoding $true))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}
`;
}

function linuxBootstrap(base, code) {
  return `#!/usr/bin/env bash
# IIT Tunnel Hub - instalacion con codigo (canjea el codigo y ejecuta el instalador de la maquina)
set -euo pipefail
HUB='${base}'
CODE='${code}'
if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecute con sudo:  curl -fsSL $HUB/i/$CODE/linux | sudo bash" >&2; exit 1
fi
HOST="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9.-' | cut -c1-63)"
BODY="{\\"code\\":\\"$CODE\\",\\"platform\\":\\"linux\\",\\"hostname\\":\\"$HOST\\"}"
TMP="$(umask 077; mktemp)"
trap 'rm -f "$TMP"' EXIT
printf '\\033[36m->\\033[0m Canjeando el codigo en el hub...\\n'
if command -v curl >/dev/null 2>&1; then
  curl -sS -o "$TMP" -H 'content-type: application/json' --data "$BODY" "$HUB/api/enroll" || true
elif command -v wget >/dev/null 2>&1; then
  wget -q --content-on-error -O "$TMP" --header='content-type: application/json' --post-data="$BODY" "$HUB/api/enroll" || true
else
  echo "Se necesita curl o wget" >&2; exit 1
fi
if ! head -n 1 "$TMP" 2>/dev/null | grep -q '^#!/usr/bin/env bash'; then
  MSG="$(sed -n 's/.*"error":"\\([^"]*\\)".*/\\1/p' "$TMP" 2>/dev/null | head -n 1)"
  printf '\\033[31mX\\033[0m No se pudo canjear el codigo: %s\\n' "\${MSG:-sin respuesta del hub}" >&2
  exit 1
fi
bash "$TMP"
`;
}

/** Arranque que solo muestra un error (código inválido, vencido o usado) sin cerrar la ventana. */
function errorBootstrap(platform, msg) {
  const safe = String(msg).replace(/[^A-Za-z0-9 .,:;()/-]/g, '');
  if (platform === 'windows') return `& { Write-Host ''; Write-Host '  X ${safe}' -ForegroundColor Red }\n`;
  return `#!/usr/bin/env bash\necho "X ${safe}" >&2\nexit 1\n`;
}

module.exports = {
  MINUTES, PLATFORMS, newCode, normalizeCode, hashCode, hintOf, cleanHost, baseUrl, isLoopback, isLoopbackHost, effectiveServerAddr, commands,
  windowsBootstrap, linuxBootstrap, errorBootstrap,
};
