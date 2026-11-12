# Corre test/e2e.sh desde Windows usando WSL.
#  - Prepara Node >= 22.13 y jq en el HOME de WSL si faltan (sin sudo, sin tocar el repo).
#  - Detiene el hub/frps locales de Windows (usan el puerto 7500 que la prueba necesita) y los
#    vuelve a arrancar al terminar, pase lo que pase.
# Uso:  powershell -ExecutionPolicy Bypass -File .\test\e2e-wsl.ps1 [-Distro Ubuntu-24.04] [-NoRestaurar]
param(
  [string]$Distro = "Ubuntu-24.04",
  [switch]$NoRestaurar,
  [switch]$SinRoot,          # por defecto corre como root: habilita SSH y SNMP (requiere openssh-server, snmpd y snmpsim en WSL)
  [string]$NodeVersion = "24.11.0"
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

# Los comandos van en un archivo temporal: pasar comillas dobles como argumento a wsl.exe falla segun la version de PowerShell
function Wsl([string]$cmd, [string]$user = "") {
  $u = if ($user) { @("-u", $user) } else { @() }
  $tmp = Join-Path $env:TEMP ("iit-e2e-" + [guid]::NewGuid().ToString("N") + ".sh")
  [IO.File]::WriteAllText($tmp, ($cmd -replace "`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
  try {
    $w = (& wsl.exe -d $Distro -- wslpath -a ($tmp.Replace('\', '/'))).Trim()
    & wsl.exe -d $Distro @u -- bash $w | Out-Host   # Out-Host: la salida no debe mezclarse con el valor devuelto
    return $LASTEXITCODE
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

# 1. WSL disponible
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw "WSL no esta instalado." }
# WSL puede tardar en arrancar systemd (avisa por stderr y a veces falla el primer intento): se reintenta
for ($i = 0; $i -lt 5; $i++) {
  $ErrorActionPreference = "Continue"
  $null = & wsl.exe -d $Distro -- true 2>&1
  $ErrorActionPreference = "Stop"
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep 3
}
if ($LASTEXITCODE -ne 0) { throw "La distribucion '$Distro' no responde. Distribuciones: wsl -l -v" }
$rootWsl = (& wsl.exe -d $Distro -- wslpath -a ($root -replace '\\', '/')).Trim()

# 2. Node y jq en WSL
$sqlite = 'export PATH="$HOME/.iit-node/bin:$PATH"; node -e "require(\"node:sqlite\")" 2>/dev/null'
if ((Wsl $sqlite) -ne 0) {
  Write-Host "Instalando Node $NodeVersion en ~/.iit-node (WSL)..."
  $inst = 'mkdir -p "$HOME/.iit-node" && curl -fsSL https://nodejs.org/dist/v' + $NodeVersion + '/node-v' + $NodeVersion + '-linux-x64.tar.xz | tar xJ -C "$HOME/.iit-node" --strip-components=1'
  if ((Wsl $inst) -ne 0) { throw "No se pudo instalar Node en WSL." }
}
if ((Wsl 'export PATH="$HOME/bin:$PATH"; command -v jq >/dev/null') -ne 0) {
  Write-Host "Instalando jq en ~/bin (WSL)..."
  $jq = 'mkdir -p "$HOME/bin" && curl -fsSL -o "$HOME/bin/jq" https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64 && chmod +x "$HOME/bin/jq"'
  if ((Wsl $jq) -ne 0) { throw "No se pudo instalar jq en WSL." }
}

# 3. Liberar los puertos del hub/frps locales de Windows (solo 7500, 8090 y 9100)
$estabaCorriendo = $false
foreach ($p in 7500, 8090, 9100) {
  Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | ForEach-Object {
    $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "Deteniendo $($proc.ProcessName) (pid $($proc.Id)) en el puerto $p"
      $estabaCorriendo = $true
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }
}
Start-Sleep 2

# 4. Pruebas
$codigo = 1
try {
  $homeWsl = (& wsl.exe -d $Distro -- bash -c 'echo $HOME').Trim()
  $run = 'export PATH="' + $homeWsl + '/.iit-node/bin:' + $homeWsl + '/bin:/usr/local/bin:/usr/bin:/bin"; cd ''' + $rootWsl + ''' && bash test/e2e.sh'
  $codigo = if ($SinRoot) { Wsl $run } else { Wsl $run "root" }
}
finally {
  # 5. Restaurar el hub local si estaba corriendo
  if ($estabaCorriendo -and -not $NoRestaurar) {
    Write-Host "Reiniciando hub y frps locales..."
    Start-Process powershell -ArgumentList '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'iniciar-local.ps1'), '-SinNavegador' -WorkingDirectory $root -WindowStyle Hidden
  }
}
exit $codigo
