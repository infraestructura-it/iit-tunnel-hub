# actualizar.ps1 — aplica un zip de actualización de IIT Tunnel Hub en este equipo
#
# Hace, en orden:
#   1. Busca el zip (el indicado, o el iit-tunnel-hub*.zip más reciente en C:\descargas o Descargas)
#   2. Lo descomprime en una carpeta temporal y revisa que sea del proyecto (completo o parcial)
#      Si no sirve, se detiene aquí sin haber parado nada
#   3. Detiene el hub (solo el proceso que escucha en 8090), frps y frpc (recuerda qué frpc corrían)
#      y copia sobre el proyecto (nunca toca frp\, data\, .git\, .env ni frpc-*.toml)
#   4. Desbloquea los archivos y revisa que estén los principales
#   5. Arranca de nuevo con iniciar-local.ps1 y vuelve a lanzar los frpc que estaban corriendo
#   6. Muestra el git status (el commit y el push los hace usted)
#
# Uso (desde la carpeta del proyecto):
#   powershell -ExecutionPolicy Bypass -File .\actualizar.ps1
#   powershell -ExecutionPolicy Bypass -File .\actualizar.ps1 -Zip C:\descargas\iit-tunnel-hub-ia.zip
#   powershell -ExecutionPolicy Bypass -File .\actualizar.ps1 -SinIniciar     # solo copia, no arranca

param(
  [string]$Zip,
  [switch]$SinIniciar
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$PUERTO_HUB = 8090

function Paso($texto) { Write-Host "`n▶ $texto" -ForegroundColor Cyan }
function Ok($texto)   { Write-Host "  ✔ $texto" -ForegroundColor Green }
function Aviso($texto){ Write-Host "  ! $texto" -ForegroundColor Yellow }
function Falla($texto){ Write-Host "  ✘ $texto" -ForegroundColor Red; exit 1 }

# ---------- 1. zip ----------
Paso "Buscando el zip"
$carpetas = @('C:\descargas', (Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'Descargas')) |
  Where-Object { Test-Path $_ }

if ($Zip) {
  if (-not (Test-Path $Zip)) {
    # Se aceptó solo el nombre: se busca en las carpetas de descarga
    $encontrado = $carpetas | ForEach-Object { Join-Path $_ $Zip } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $encontrado) { Falla "No existe '$Zip' (busqué también en: $($carpetas -join ', '))" }
    $Zip = $encontrado
  }
} else {
  $ultimo = $carpetas | ForEach-Object { Get-ChildItem $_ -Filter 'iit-tunnel-hub*.zip' -File -ErrorAction SilentlyContinue } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $ultimo) { Falla "No encontré ningún iit-tunnel-hub*.zip en: $($carpetas -join ', '). Use -Zip <ruta>." }
  $Zip = $ultimo.FullName
}
$Zip = (Resolve-Path $Zip).Path
Ok "$Zip ($((Get-Item $Zip).LastWriteTime.ToString('yyyy-MM-dd HH:mm')))"

# ---------- 2. descomprimir (antes de detener nada: si el zip no sirve, todo sigue corriendo) ----------
Paso "Descomprimiendo"
$tmp = Join-Path $env:TEMP ("iit-act-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
Expand-Archive -Path $Zip -DestinationPath $tmp -Force

# El zip puede traer los archivos en la raíz o dentro de una sola carpeta envoltorio (iit-tunnel-hub\...).
# Puede ser completo o parcial (solo los archivos que cambiaron).
$conocidas = 'api', 'deploy', 'frps', 'test'
$origen = $tmp
$hijos = @(Get-ChildItem $tmp -Force)
if ($hijos.Count -eq 1 -and $hijos[0].PSIsContainer -and $hijos[0].Name -notin $conocidas) { $origen = $hijos[0].FullName }

$delProyecto = @(Get-ChildItem $origen -Force | Where-Object {
  ($_.PSIsContainer -and $_.Name -in $conocidas) -or
  (-not $_.PSIsContainer -and $_.Extension -in '.ps1', '.md', '.yml', '.example')
})
if (-not $delProyecto) { Remove-Item $tmp -Recurse -Force; Falla "El zip no parece del proyecto (no trae api\, deploy\, frps\, test\ ni scripts .ps1/.md)." }
$archivos = @(Get-ChildItem $origen -Recurse -File)
$parcial = -not (Test-Path "$origen\api\src\server.js")
Ok "$($archivos.Count) archivos$(if ($parcial) { ' (actualización parcial)' })"
$archivos | Select-Object -First 15 | ForEach-Object { Write-Host "    $($_.FullName.Substring($origen.Length + 1))" -ForegroundColor DarkGray }
if ($archivos.Count -gt 15) { Write-Host "    … y $($archivos.Count - 15) más" -ForegroundColor DarkGray }

# ---------- 2b. detener ----------
Paso "Deteniendo hub, frps y frpc"

# frpc: se guarda con qué configuración corría cada uno para relanzarlo al final
$frpcPrevios = @()
Get-CimInstance Win32_Process -Filter "Name = 'frpc.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -match '-c\s+"?([^"]+?\.toml)"?(\s|$)') {
    $toml = $Matches[1]
    if (-not [System.IO.Path]::IsPathRooted($toml)) { $toml = Join-Path "$root\frp" $toml }
    # El frpc interno del hub (data\hub-frpc.toml) lo arranca el propio hub con un token nuevo: no se relanza
    if ($toml -notmatch 'hub-frpc\.toml$') { $frpcPrevios += $toml }
  }
}

# Hub: SOLO el proceso que escucha en el puerto del panel (no tocar el node de iit-monitor-ups en 8080)
$hub = Get-NetTCPConnection -LocalPort $PUERTO_HUB -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($hub) {
  $proc = Get-Process -Id $hub.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') {
    Stop-Process -Id $proc.Id -Force
    Ok "Hub detenido (node, PID $($proc.Id))"
  } elseif ($proc) {
    Falla "El puerto $PUERTO_HUB lo usa '$($proc.ProcessName)' (PID $($proc.Id)), no el hub. No lo detengo."
  }
} else { Ok "El hub no estaba corriendo" }

foreach ($nombre in 'frps', 'frpc') {
  $p = Get-Process $nombre -ErrorAction SilentlyContinue
  if ($p) { $p | Stop-Process -Force; Ok "$nombre detenido ($($p.Count))" }
}

# Espera a que se liberen los puertos (iniciar-local.ps1 se niega a arrancar si siguen ocupados)
$puertos = 8090, 9100, 7000, 7500, 8081, 8443
for ($i = 0; $i -lt 20; $i++) {
  $ocupados = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $puertos }
  if (-not $ocupados) { break }
  Start-Sleep -Milliseconds 500
}

# ---------- 3. copiar ----------
Paso "Copiando sobre $root"
# robocopy: /E subcarpetas · /XD y /XF excluyen lo que nunca debe pisarse · códigos < 8 = éxito
robocopy $origen $root /E /NFL /NDL /NJH /NJS /NP /XD frp data .git node_modules /XF .env *.db frpc-*.toml instalar-* accesos-* *.rdp | Out-Null
$codigo = $LASTEXITCODE
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($codigo -ge 8) { Falla "robocopy terminó con error $codigo" }
Ok "Copiado (robocopy $codigo)"

# ---------- 4. desbloquear y revisar ----------
Paso "Desbloqueando y revisando"
Get-ChildItem $root -Recurse -File -Include *.ps1, *.js, *.html, *.css, *.toml, *.sh -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(\.git|frp|data)\\' } | Unblock-File
$faltan = @(
  'api\src\server.js', 'api\src\ai.js', 'api\src\ai-scope.js', 'api\src\telegram.js', 'api\src\alerts.js',
  'api\public\index.html', 'api\public\app.js', 'api\public\ai.js', 'frps\frps.toml', 'iniciar-local.ps1'
) | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($faltan) { Falla "Faltan archivos: $($faltan -join ', ')" }
Ok "Archivos principales presentes"
if (-not (Test-Path "$root\frp\frps.exe")) { Aviso "No está frp\frps.exe: ejecute .\frp.ps1 (o Defender lo borró)" }

# ---------- 5. arrancar ----------
if ($SinIniciar) {
  Aviso "Sin arrancar (-SinIniciar). Cuando quiera: .\iniciar-local.ps1"
} else {
  Paso "Arrancando (iniciar-local.ps1)"
  & "$root\iniciar-local.ps1"

  if ($frpcPrevios -and (Test-Path "$root\frp\frpc.exe")) {
    Start-Sleep -Seconds 3   # da tiempo a que frps y el plugin del hub estén escuchando
    foreach ($toml in ($frpcPrevios | Select-Object -Unique)) {
      if (Test-Path $toml) {
        Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\frp'; & '.\frpc.exe' -c '$toml'"
        Ok "frpc relanzado: $(Split-Path $toml -Leaf)"
      } else { Aviso "No encontré $toml; ese frpc no se relanzó" }
    }
  }
  Aviso "En el navegador recargue con Ctrl+Shift+R para tomar el panel nuevo."
}

# ---------- 6. git ----------
if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Path "$root\.git")) {
  Paso "Cambios para Git"
  $cambios = git -C $root status --short
  if ($cambios) {
    $cambios | ForEach-Object { "  $_" }
    Write-Host "`n  Para subirlos:" -ForegroundColor Gray
    Write-Host "    git add -A; git status; git commit -m `"<mensaje>`"; git push" -ForegroundColor Gray
  } else { Ok "Sin cambios: el zip ya estaba aplicado" }
}

Write-Host "`nListo." -ForegroundColor Green
