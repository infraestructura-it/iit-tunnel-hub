# frp.ps1 — descarga frp (frpc.exe y frps.exe) en la carpeta .\frp del proyecto
# Uso (desde cualquier carpeta):
#   powershell -ExecutionPolicy Bypass -File .\frp.ps1
#   powershell -ExecutionPolicy Bypass -File .\frp.ps1 -Force   # vuelve a descargar

param([switch]$Force)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"          # sin esto la descarga es muy lenta
[Net.ServicePointManager]::SecurityProtocol = "Tls12"

$v      = "0.71.0"
$dest   = Join-Path $PSScriptRoot "frp"
$zip    = Join-Path $env:TEMP "frp.zip"
$tmpDir = Join-Path $env:TEMP "frp_${v}_windows_amd64"
$exes   = "frpc.exe", "frps.exe"

$faltan = $exes | Where-Object { -not (Test-Path (Join-Path $dest $_)) }
if (-not $Force -and -not $faltan) {
  Write-Host "frp ya está en $dest (use -Force para volver a descargar)" -ForegroundColor Green
  Get-ChildItem $dest -Filter *.exe | Format-Table Name, Length, LastWriteTime
  return
}

try {
  Write-Host "Descargando frp $v..." -ForegroundColor Cyan
  Invoke-WebRequest "https://github.com/fatedier/frp/releases/download/v$v/frp_${v}_windows_amd64.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $env:TEMP -Force
  New-Item -ItemType Directory -Force $dest | Out-Null
  foreach ($e in $exes) { Copy-Item (Join-Path $tmpDir $e) $dest -Force }
  Remove-Item $zip, $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  Write-Host "Falló: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# Defender a veces borra los .exe segundos después de copiarlos
Start-Sleep -Seconds 2
$faltan = $exes | Where-Object { -not (Test-Path (Join-Path $dest $_)) }
if ($faltan) {
  Write-Host "Windows Defender eliminó: $($faltan -join ', ')" -ForegroundColor Yellow
  Write-Host "Permítalos en Seguridad de Windows > Protección contra virus > Historial de protección,"
  Write-Host "o use la versión Linux de frp dentro de WSL."
  exit 1
}

Write-Host "OK: frp $v listo en $dest" -ForegroundColor Green
Get-ChildItem $dest -Filter *.exe | Format-Table Name, Length, LastWriteTime