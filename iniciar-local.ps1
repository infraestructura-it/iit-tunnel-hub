# iniciar-local.ps1 — arranca IIT Tunnel Hub en este equipo para pruebas
# Uso (desde la carpeta iit-tunnel-hub):
#   powershell -ExecutionPolicy Bypass -File .\iniciar-local.ps1

$root = $PSScriptRoot

# ---------- configuración de prueba local ----------
$env:ADMIN_TOKEN = "prueba-local-1234567890"
$env:HOST = "127.0.0.1"; $env:PORT = "8090"
$env:PLUGIN_HOST = "127.0.0.1"; $env:PLUGIN_PORT = "9100"
$env:DB_PATH = "$root\data\hub.db"
$env:FRPS_PUBLIC_ADDR = "127.0.0.1"; $env:FRPS_BIND_PORT = "7000"
$env:FRPS_SUBDOMAIN_HOST = "localhost"
$env:FRPS_VHOST_HTTP_PORT = "8081"; $env:FRPS_VHOST_HTTPS_PORT = "8443"
$env:FRPS_TCP_PORT_MIN = "20000"; $env:FRPS_TCP_PORT_MAX = "20010"
# En PowerShell asignar "" BORRA la variable; se usa un valor fijo para que frps y frpc coincidan
$env:FRP_AUTH_TOKEN = "iit-local-frp"
$env:FRPS_API_URL = "http://127.0.0.1:7500"; $env:FRPS_API_USER = "admin"; $env:FRPS_API_PASSWORD = "dash123"

# ---------- comprobaciones ----------
# Detiene un frps anterior que pudiera haber quedado corriendo con otra configuración
Get-Process frps -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

$ocupados = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 8090, 9100, 7000, 7500, 8081, 8443 }
if ($ocupados) {
  Write-Host "Puertos ocupados (cierre una instancia anterior del hub o frps):" -ForegroundColor Yellow
  $ocupados | ForEach-Object { "  $($_.LocalPort) -> $((Get-Process -Id $_.OwningProcess).ProcessName)" }
  return
}

# ---------- hub (panel + API) ----------
Write-Host "Iniciando hub en http://127.0.0.1:$env:PORT ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\api'; node --disable-warning=ExperimentalWarning --openssl-legacy-provider src\server.js"
Start-Sleep -Seconds 2

# ---------- frps ----------
if (Test-Path "$root\frp\frps.exe") {
  Write-Host "Iniciando frps ..." -ForegroundColor Cyan
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "& '$root\frp\frps.exe' -c '$root\frps\frps.toml'"
} else {
  Write-Host "No se encontró frp\frps.exe: el panel abre, pero sin túneles." -ForegroundColor Yellow
}

Start-Sleep -Seconds 1
Start-Process "http://127.0.0.1:$env:PORT"
Write-Host "Token de administración: $env:ADMIN_TOKEN" -ForegroundColor Green
Write-Host "La primera vez, el panel pide crear el administrador con ese token; después entre con su usuario." -ForegroundColor Gray
