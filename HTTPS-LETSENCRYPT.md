# HTTPS en el hub con Let's Encrypt (DNS-01 + Cloudflare)

Objetivo: servir el panel y la **videoatención** por `https://hubups.infraestructura-it.com:8443`
para que el navegador conceda **contexto seguro** (cámara y micrófono) a los clientes remotos por
ZeroTier/dominio. El chat ya funcionaba en http; el **video** necesita esto.

Por qué DNS-01: el hub solo es accesible por ZeroTier (no tiene IP pública), así que no se puede usar
el reto HTTP-01. **DNS-01 valida el dominio con un registro TXT en Cloudflare**, sin necesidad de que
nadie entre al hub desde Internet. Let's Encrypt emite el certificado aunque `hubups` apunte a una IP
privada (10.147.19.141): solo comprueba que controlas el dominio.

El hub ya está preparado: si existen `HUB_TLS_CERT` y `HUB_TLS_KEY`, además de http escucha en TLS en
`HUB_TLS_PORT` (8443 por defecto), con el mismo panel, API y WebSocket (la sala de citas por `wss://`).

---

## 1) Token de Cloudflare (una sola vez)

1. Cloudflare → **My Profile → API Tokens → Create Token → Edit zone DNS** (plantilla).
2. Permisos: **Zone · DNS · Edit**. Zone Resources: **Include · Specific zone · infraestructura-it.com**.
3. Crear y **copiar el token** (se muestra una vez).

## 2) Obtener el certificado con `lego` (un solo .exe, sin instalar nada)

`lego` es el cliente ACME de Go: un ejecutable único, ideal para Windows.

1. Descarga el binario de Windows desde las *releases* de `go-acme/lego` y descomprímelo, p. ej. en
   `C:\ITT\lego\lego.exe`.
2. En **PowerShell** (como tu usuario, no hace falta admin):

   ```powershell
   $env:CLOUDFLARE_DNS_API_TOKEN = "PEGUE_AQUI_EL_TOKEN"
   C:\ITT\lego\lego.exe `
     --email "tucorreo@infraestructura-it.com" `
     --dns cloudflare `
     --domains "hubups.infraestructura-it.com" `
     --domains "*.hubups.infraestructura-it.com" `
     --path "C:\ITT\certs" `
     --accept-tos run
   ```

   El comodín `*.hubups` es opcional (sirve para los servicios http por subdominio); para el panel y la
   videoatención basta `hubups.infraestructura-it.com`.

3. Quedan los archivos (certificado = cadena completa, y la clave):

   ```
   C:\ITT\certs\certificates\hubups.infraestructura-it.com.crt
   C:\ITT\certs\certificates\hubups.infraestructura-it.com.key
   ```

## 3) Cablear el hub (en `iniciar-local.mio.ps1`)

Agrega estas líneas en la zona de variables de tu `iniciar-local.mio.ps1`:

```powershell
$env:HUB_TLS_CERT   = "C:\ITT\certs\certificates\hubups.infraestructura-it.com.crt"
$env:HUB_TLS_KEY    = "C:\ITT\certs\certificates\hubups.infraestructura-it.com.key"
$env:HUB_TLS_PORT   = "8443"
# Para que los links (citas, instalación con código) salgan en https:
$env:HUB_PUBLIC_URL = "https://hubups.infraestructura-it.com:8443"
```

Relanza el hub. En el log verás además:
`Panel y API (HTTPS) en https://0.0.0.0:8443`.

## 4) Firewall (abrir el 8443 en ZeroTier)

```powershell
New-NetFirewallRule -DisplayName "IIT Hub HTTPS 8443" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443
```

## 5) Probar

- Abre `https://hubups.infraestructura-it.com:8443` → candado válido (sin advertencia).
- Crea una cita, envía el link por correo; el cliente abrirá `https://hubups.infraestructura-it.com:8443/cita.html?code=...`
  y el navegador **ya permite cámara y micrófono**.

> El `http://…:8090` sigue funcionando en paralelo (ZeroTier/LAN y las máquinas ya instaladas). No hace
> falta migrar nada de golpe.

---

## Renovación automática (cada 90 días)

El certificado dura 90 días. Crea una **tarea programada** que renueve y, si cambió, relance el hub:

```powershell
# renovar-cert.ps1
$env:CLOUDFLARE_DNS_API_TOKEN = "PEGUE_AQUI_EL_TOKEN"
C:\ITT\lego\lego.exe --email "tucorreo@infraestructura-it.com" --dns cloudflare `
  --domains "hubups.infraestructura-it.com" --domains "*.hubups.infraestructura-it.com" `
  --path "C:\ITT\certs" renew --days 30
# El hub lee el certificado al arrancar: relánzalo para tomar el nuevo
# (detén el hub del 8090 y vuelve a correr iniciar-local.mio.ps1, o tu flujo de reinicio)
```

Programa `renovar-cert.ps1` mensualmente (Task Scheduler). `renew --days 30` solo renueva si faltan
menos de 30 días, así que es seguro correrlo seguido.

### Alternativa: win-acme
Si prefieres un asistente interactivo, `win-acme` (wacs.exe) también hace DNS-01 con Cloudflare y
programa la renovación solo; apunta el "script de instalación" a copiar el .crt/.key a `C:\ITT\certs`
y a reiniciar el hub. `lego` es más simple de automatizar en este caso.

---

## Notas

- Cloudflare para `hubups` debe seguir en **"solo DNS" (nube gris)**: no se puede *proxyear* una IP de
  ZeroTier, y DNS-01 no lo necesita.
- Node cachea el certificado al arrancar: una renovación requiere **relanzar el hub** para tomarlo.
- Si algún día el hub pasa a un VPS con IP pública, se puede usar HTTP-01 (sin token de Cloudflare) y
  el puerto 443 estándar; el mecanismo del hub (`HUB_TLS_CERT`/`HUB_TLS_KEY`) es el mismo.
