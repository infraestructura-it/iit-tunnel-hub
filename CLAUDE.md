# CLAUDE.md — IIT Tunnel Hub

Guía para trabajar en este repositorio con Claude Code. Responder y documentar en **español**.

## Qué es

Panel + API para **registrar y monitorear máquinas conectadas por túneles frp** (modelo tipo Home Assistant Cloud / SniTun).
Cada equipo de cliente corre `frpc`, abre un túnel saliente hacia `frps` y queda publicado en `<servicio>-<maquina>.<dominio>`
o en un puerto TCP. El hub decide qué entra: funciona como **server plugin de frps**.

Proyecto de Infraestructura-IT (IIT), org GitHub `infraestructura-it`.

## Arquitectura

```
Navegador ─▶ frps :80/:443(SNI)/rango TCP ─┐
                    │  pregunta antes de aceptar
                    └─▶ hub :9000 (plugin, solo 127.0.0.1) ── SQLite
Técnico ───▶ hub :8080 (panel + API REST, ADMIN_TOKEN)
                    └─▶ lee estado en vivo de frps :7500 (dashboard API)
Máquina cliente: frpc ──túnel saliente──▶ frps :7000
```

- **Dos servidores HTTP en un solo proceso Node** (`api/src/server.js`): panel/API (`PORT`) y plugin de frps (`PLUGIN_PORT`).
- **frps falla cerrado**: si el hub no responde, rechaza logins. Reiniciar el hub desconecta las máquinas unos segundos.

## Stack y convenciones

- **Node.js ≥ 22.13 sin dependencias npm.** SQLite con el módulo nativo `node:sqlite` (`DatabaseSync`). No agregar paquetes sin necesidad clara.
- **Frontend vanilla** HTML/CSS/JS en `api/public/` (sin frameworks, sin build). Estética oscura IIT: fondo `#080b10`, cian/verde/morado, fuentes Syne / Space Mono / DM Mono.
- Todo el texto de UI, errores de API, eventos y comentarios en **español**.
- frp **v0.71.0**, configuración en **TOML** (el formato INI está obsoleto). Fijar la versión en `frp.ps1`, `frps/Dockerfile`, `deploy/*.sh` y `test/e2e.sh` a la vez.

## Archivos

| Ruta | Qué hace |
|---|---|
| `api/src/server.js` | Rutas REST, servidor del plugin, estáticos, arranque |
| `api/src/plugin.js` | Lógica del server plugin (Login, NewProxy, CloseProxy, NewUserConn, NewWorkConn, Ping) |
| `api/src/machines.js` | Validación, tokens (SHA-256, comparación en tiempo constante), slugs, generación de `frpc.toml` |
| `api/src/db.js` | Esquema SQLite (`machines`, `services`, `events`) y consultas |
| `api/src/alerts.js` | Monitor de estado (cada `ALERT_CHECK_SECONDS`) y envío de alertas por Telegram y webhooks; configuración en la tabla `settings` |
| `api/src/ai.js` | Agente Claude: herramientas, bucle tool_use, conversaciones, aprobaciones, diagnóstico de alertas, uso |
| `api/src/ai-scope.js` | Alcance de IA por máquina: validación, vistas sin secretos, ejecución HTTP por frps y SSH con clave del hub |
| `api/src/telegram.js` | Bot de Telegram (long polling): solo el chat de Alertas, botones aprobar/rechazar |
| `api/public/ai.js` | Panel: chat, pendientes, ajustes de IA y editor de alcance |
| `test/mock-claude.js`, `test/mock-telegram.js` | Simuladores para las pruebas (validan el formato de la API como lo haría la real) |
| `api/src/installers.js` | Instaladores autocontenidos por máquina (Linux `.sh`, Windows `.ps1`) con el toml y el token incrustados |
| `api/src/frps.js` | Cliente de la API del dashboard de frps (caché 3 s) |
| `api/src/config.js` | Variables de entorno |
| `frps/frps.toml` | Config de frps; toma valores con `{{ .Envs.X }}` |
| `iniciar-local.ps1` | Arranque local en Windows (hub + frps) |
| `frp.ps1` | Descarga `frpc.exe`/`frps.exe` a `frp/` |
| `actualizar.ps1` | Aplica un zip de actualización: detiene hub (solo puerto 8090)/frps/frpc, copia sin tocar `frp/`, `data/`, `.git`, `.env`, `frpc-*.toml`, rearranca y relanza los frpc previos |
| `deploy/install.sh` | Instalación en Linux con systemd |
| `deploy/frpc-install.sh` | Instala frpc como servicio en una máquina Linux |
| `deploy/node-red-alertas-whatsapp.json` | Flujo Node-RED: webhook de alertas → WhatsApp (CallMeBot) |
| `test/e2e.sh` | Prueba de punta a punta con frps/frpc reales (79 casos) |

## Comandos

```bash
# Pruebas (Linux/WSL; descarga frp en .frp/ si falta)
./test/e2e.sh

# Hub en desarrollo (Linux)
ADMIN_TOKEN=... node --disable-warning=ExperimentalWarning api/src/server.js
```

```powershell
# Windows local
powershell -ExecutionPolicy Bypass -File .\frp.ps1            # una vez
powershell -ExecutionPolicy Bypass -File .\iniciar-local.ps1  # hub + frps, abre http://127.0.0.1:8090
cd frp; .\frpc.exe -c .\frpc-<maquina>.toml                   # conectar una máquina
powershell -ExecutionPolicy Bypass -File .\actualizar.ps1     # aplica el iit-tunnel-hub*.zip más reciente de C:\descargas o Descargas
```

Panel local: `http://127.0.0.1:8090`, token `prueba-local-1234567890`. Servicios http: `http://<servicio>-<maquina>.localhost:8081` (Chrome/Edge resuelven `*.localhost`).

## Reglas de seguridad (no romper)

- El hub guarda **solo el hash** del token de máquina; el token se muestra una vez (registro o rotación).
- `GET /api/machines/:id/frpc.toml` **nunca** incluye el token (pone `PEGUE_AQUI_EL_TOKEN...`).
- `POST /api/machines/:id/installer` solo genera si recibe el token vigente (403 si no). El hub no puede regenerar un instalador sin token: "Generar instalador" en la UI rota el token.
- El `.ps1` debe llevar BOM UTF-8 (Windows PowerShell 5.1 lee sin BOM como ANSI y los caracteres como ✔ rompen el parseo). `fetch().text()` quita el BOM: la UI lo vuelve a agregar.
- `NewProxy` exige que el servicio exista con el mismo tipo y subdominio/puerto; `customDomains` siempre se rechaza.
- `NewUserConn`, `NewWorkConn` y `Ping` revisan que la máquina siga habilitada: deshabilitar/eliminar corta tráfico y expulsa.
- Ante error interno el plugin **rechaza** (falla cerrado). Mantenerlo así.
- El plugin y el dashboard de frps escuchan solo en `127.0.0.1`.
- **Nunca commitear**: `.env`, `frp/`, `*.exe`, `frpc-*.toml` (llevan tokens), `data/`, `*.db`. Ya están en `.gitignore`.

## IA: reglas (no romper)

- La IA solo usa ids de consultas/comandos del alcance; **nunca** URLs ni comandos libres. Parámetros validados con `PARAM_VALUE_RE`.
- Modo `action` ⇒ se crea `ai_actions` en `pendiente` y **no** se ejecuta; solo `approve()` ejecuta (transición atómica `pendiente → ejecutando`). Todo método ≠ GET es `action`.
- Cabeceras de consultas HTTP = secretos: no van en `scopeForAI`, ni en resúmenes, ni al panel (`********`). Hay prueba que verifica que no llegan a Claude.
- Conversación por máquina: herramientas restringidas a esa máquina. Diagnóstico de alertas: solo herramientas del hub.
- Alternancia de roles: usar `pushUserText` para agregar texto de usuario (une con el último si también es del usuario).
- API: `POST {ANTHROPIC_BASE_URL}/v1/messages`, cabeceras `x-api-key` y `anthropic-version: 2023-06-01`; modelo por defecto `claude-sonnet-5-5` (configurable). Sin clave real en desarrollo: las pruebas usan `test/mock-claude.js`.
- El hub alcanza los servicios de las máquinas a través de frps en `FRPS_LOCAL_ADDR` (vhost http con cabecera Host, o puerto remoto tcp). Servicios `https` no se admiten en el alcance.

## Alertas: reglas (no romper)

- Estado persistido por máquina: `state` (unknown/online/offline), `state_since`, `offline_alerted` (0 pendiente · 1 avisada · 2 sin aviso).
- Solo se avisa de máquinas que estuvieron **en línea** y siguen caídas tras `graceSeconds`. Nunca vistas, deshabilitadas o con `alerts = 0` → 2, sin aviso.
- La recuperación se envía solo si se avisó la caída (`offline_alerted = 1`).
- Si frps no responde, se alerta `server_down` y **no** se tocan los estados de las máquinas.
- La gracia evita falsas alarmas al reiniciar el hub (fail-closed desconecta a todos unos segundos).
- Telegram no se pudo probar en el entorno de desarrollo (salida bloqueada); webhooks sí, en `test/e2e.sh`.

## frp v0.71: detalles verificados

- Plugin: `POST /frp/handler?op=<Op>`; respuesta `{reject, reject_reason}` o `{reject:false, unchange:true}`.
- frps antepone el usuario al nombre del proxy: `"<maquina>.<servicio>"`.
- El tipo `http` **no** pasa por `NewUserConn`; por eso se intercepta también `NewWorkConn`.
- Dashboard API usada: `/api/serverinfo`, `/api/clients` (incluye `online`), `/api/proxy/{http,https,tcp}`. No hay endpoint para expulsar un cliente: se hace rechazando `Ping`.
- `transport.heartbeatTimeout` debe ser > 0 en frps para que el rechazo de `Ping` expulse.
- `https` con `tlsMode: "local"` usa el plugin `https2http` de frpc: el TLS termina en la máquina, frps solo enruta por SNI.
- frpc 0.71 escribe `login to server success` (sin "the"); los instaladores buscan esa frase.
- Error `token in login doesn't match token from configuration` = no coincide el **token global** (`auth.token`) entre frps y frpc; no tiene que ver con el token de máquina (ese error sería "token inválido" desde el hub).

## Problemas conocidos en Windows (equipos de desarrollo)

- **PowerShell: `$env:X = ""` BORRA la variable** en vez de dejarla vacía. Por eso `iniciar-local.ps1` usa `FRP_AUTH_TOKEN = "iit-local-frp"`, y los `frpc.toml` locales deben llevar `auth.token = "iit-local-frp"`.
- **Windows Defender marca frp como HackTool** y borra `frps.exe`/`frpc.exe`. Sin admin no se puede agregar exclusión; alternativa: binarios Linux de frp dentro de WSL.
- **WSL 2 sin `networkingMode=mirrored`**: Windows llega a `localhost` de WSL, pero WSL **no** llega al `localhost` de Windows. Si frps corre en WSL y el hub en Windows, hace falta modo espejo (Windows 11 22H2+).
- **Puertos ocupados en el PC de oficina**: 8080 (iit-monitor-ups, node) y 9000 (puente RUNT 2.0, no detener). Por eso el entorno local usa 8090 (panel) y 9100 (plugin).
- **El proyecto vive en OneDrive** y se usa desde dos perfiles (`Infraestructura02` y `User01`). `data/hub.db` se sincroniza: **no correr el hub en ambos PC a la vez**. Opción: `DB_PATH` en `%LOCALAPPDATA%`.
- `*.sh`, `*.service` y `*.toml` deben quedar con LF (`.gitattributes`); con CRLF fallan en Linux.

## Producción (pendiente)

- Destino: VPS o VM Linux propia. `docker compose up -d --build` (red del host) o `deploy/install.sh`.
- DNS en Cloudflare **solo DNS (nube gris)**: `tuneles.<dominio>` y `*.clientes.<dominio>`.
- Si Nginx ya usa el 443: `stream` + `ssl_preread` hacia frps (ver README).
- Las imágenes Docker aún **no se han construido** en un daemon real; validar en el primer despliegue.

## Pendientes / ideas

- Usuarios y roles (hoy un solo `ADMIN_TOKEN`); las aprobaciones de IA registran "panel" o "telegram", no la persona.
- Probar la IA con una clave real (en desarrollo solo se probó con el simulador) y SSH desde Windows.
- Emisión automática de certificados por máquina (DNS-01 con Cloudflare) para `https` con TLS local.
- Probar el instalador Windows en un equipo real (solo se validó el parseo con PowerShell 7 en Linux) y el camino systemd del instalador Linux en una Raspberry.
- Tipo `stcp` para SSH sin puerto público.
- Instalación con una línea (`curl … | sudo bash`) mediante código de un solo uso.
