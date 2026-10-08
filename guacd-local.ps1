# guacd-local.ps1 — inicia guacd (Apache Guacamole) en Docker Desktop para el escritorio remoto (RDP) del hub
# Uso (desde la carpeta iit-tunnel-hub), una vez; después se inicia solo junto con Docker Desktop:
#   powershell -ExecutionPolicy Bypass -File .\guacd-local.ps1
# Para quitarlo:  docker rm -f iit-guacd

$imagen = "guacamole/guacd:1.5.5"
$nombre = "iit-guacd"

function Ok($t)    { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }

Write-Host "guacd para el escritorio remoto de IIT Tunnel Hub" -ForegroundColor Cyan

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Aviso "No se encontró Docker. Instale Docker Desktop (https://www.docker.com/products/docker-desktop/), ábralo y vuelva a ejecutar este script."
  return
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Aviso "Docker Desktop no está corriendo: ábralo, espere a que diga 'Engine running' y vuelva a ejecutar este script."
  return
}

$estado = docker ps -a --filter "name=^$nombre$" --format "{{.Status}}"
if (-not $estado) {
  Write-Host "  Descargando e iniciando $imagen ..."
  # Solo en 127.0.0.1: guacd no debe quedar expuesto en la red
  docker run -d --name $nombre --restart unless-stopped -p 127.0.0.1:4822:4822 $imagen | Out-Null
  if ($LASTEXITCODE -ne 0) { Aviso "No se pudo crear el contenedor (revise el mensaje de Docker)."; return }
} elseif ($estado -notmatch "^Up") {
  docker start $nombre | Out-Null
}

Start-Sleep -Seconds 2
if (Test-NetConnection 127.0.0.1 -Port 4822 -InformationLevel Quiet -WarningAction SilentlyContinue) {
  Ok "guacd responde en 127.0.0.1:4822"
} else {
  Aviso "guacd no responde en 127.0.0.1:4822. Revise: docker logs $nombre"
  return
}

# guacd entra a los puertos locales del frpc del hub (solo 127.0.0.1) como host.docker.internal.
# Se prueba con un puerto que también escucha solo en 127.0.0.1: el dashboard de frps (7500).
if (Test-NetConnection 127.0.0.1 -Port 7500 -InformationLevel Quiet -WarningAction SilentlyContinue) {
  docker run --rm alpine:3.20 nc -z -w 3 host.docker.internal 7500 *> $null
  if ($LASTEXITCODE -eq 0) {
    Ok "desde Docker se llega a los puertos locales de este equipo (host.docker.internal)"
  } else {
    Aviso "desde Docker NO se llega a 127.0.0.1 de este equipo por host.docker.internal."
    Aviso "El escritorio remoto no podrá conectar así: copie este mensaje para ajustar GUACD_TARGET_HOST."
  }
} else {
  Aviso "frps no está corriendo: inicie el hub (iniciar-local.ps1) y vuelva a ejecutar este script para la prueba completa."
}

Write-Host ""
Write-Host "Listo. En el panel: Conectar por > Escritorio remoto (RDP) en una máquina Windows con servicio privado rdp :3389." -ForegroundColor Cyan
