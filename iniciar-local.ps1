# Configuración para prueba local
$env:ADMIN_TOKEN = "prueba-local-1234567890"
$env:HOST = "127.0.0.1"; $env:PORT = "8090"
$env:PLUGIN_HOST = "127.0.0.1"; $env:PLUGIN_PORT = "9100"
$env:DB_PATH = "$PSScriptRoot\data\hub.db"
$env:FRPS_PUBLIC_ADDR = "127.0.0.1"; $env:FRPS_BIND_PORT = "7000"
$env:FRPS_SUBDOMAIN_HOST = "localhost"
$env:FRPS_VHOST_HTTP_PORT = "8081"; $env:FRPS_VHOST_HTTPS_PORT = "8443"
$env:FRPS_TCP_PORT_MIN = "20000"; $env:FRPS_TCP_PORT_MAX = "20010"
$env:FRP_AUTH_TOKEN = ""
$env:FRPS_API_URL = "http://127.0.0.1:7500"; $env:FRPS_API_USER = "admin"; $env:FRPS_API_PASSWORD = "dash123"

# Hub (panel + API) en una ventana aparte
Start-Process node -ArgumentList "--disable-warning=ExperimentalWarning", "src\server.js" -WorkingDirectory "$PSScriptRoot\api"

# frps, si ya está descargado (Parte 2)
if (Test-Path "$PSScriptRoot\frp\frps.exe") {
  Start-Process "$PSScriptRoot\frp\frps.exe" -ArgumentList "-c", "$PSScriptRoot\frps\frps.toml"
}
