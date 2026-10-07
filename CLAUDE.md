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
| `api/src/auth.js` | Contraseñas (scrypt), TOTP (RFC 6238), sesiones/cookies y la clase `Access` (rol + clientes visibles) |
| `api/src/context.js` | `AsyncLocalStorage` con el actor de la petición: `store.event()` lo guarda en `events.actor` |
| `api/public/users.js` | Panel: mi cuenta (contraseña, 2FA con QR) y administración de usuarios y clientes |
| `api/public/vendor/qrcode.js` | qrcode-generator 1.4.4 (MIT), servido localmente para el QR del 2FA |
| `api/src/backup.js` | Respaldos: `VACUUM INTO`, sin sesiones, `quick_check`, cifrado AES-256-GCM opcional, programación diaria por zona horaria, retención |
| `api/src/respaldo.js` | CLI: `verificar`, `descifrar`, `restaurar --hub-detenido` |
| `api/src/status.js` | `/api/status` (estado y advertencias) y `/api/health` (200/503 para monitores) |
| `api/public/estado.js` | Panel: modal 🩺 Estado y respaldos |
| `api/src/snmp.js` | Cliente SNMP sin dependencias: BER, GET/GETNEXT/GETBULK/walk, v2c y v3 (USM: MD5/SHA/SHA-2, AES-128, DES con legacy provider) |
| `api/src/snmp-profiles.js` | Perfiles (ups, ups-apc, network, printer, host, generic): detección, lectura, metadatos y reglas de alerta |
| `api/src/snmp-monitor.js` | Sondeo, historial (~5 min, 30 días), alertas con gracia y normalización, explorador |
| `api/src/snmp-devices.js` | Validación de equipos y vistas sin secretos |
| `api/src/hubfrpc.js` | frpc interno del hub (usuario `_hub`): visitante sudp en 127.0.0.1, recarga por API de admin |
| `api/public/snmp.js` | Panel: equipos SNMP por sede, ficha con gráficas SVG, formulario, explorador |
| `test/snmp/*.snmprec` | Equipos simulados para snmpsim (comunidad = nombre del archivo) |
| `api/src/plugin.js` | Lógica del server plugin (Login, NewProxy, CloseProxy, NewUserConn, NewWorkConn, Ping) |
| `api/src/machines.js` | Validación, tokens (SHA-256, comparación en tiempo constante), slugs, generación de `frpc.toml`, accesos stcp (`normalizeAccess`, `accessToml`, `rdpFile`) |
| `api/src/db.js` | Esquema SQLite (`machines`, `services`, `service_access`, `clients`, `users`, `user_clients`, `sessions`, `events`, `settings`, `ai_*`, `snmp_*`, `enrollments`), migraciones y consultas |
| `api/src/alerts.js` | Monitor de estado (cada `ALERT_CHECK_SECONDS`) y envío de alertas por Telegram y webhooks; configuración en la tabla `settings` |
| `api/src/ai.js` | Agente Claude: herramientas, bucle tool_use, conversaciones, aprobaciones, diagnóstico de alertas, uso |
| `api/src/ai-scope.js` | Alcance de IA por máquina: validación, vistas sin secretos, ejecución HTTP por frps y SSH con clave del hub |
| `api/src/telegram.js` | Bot de Telegram (long polling): solo el chat de Alertas, botones aprobar/rechazar |
| `api/public/ai.js` | Panel: chat, pendientes, ajustes de IA y editor de alcance |
| `test/mock-claude.js`, `test/mock-telegram.js` | Simuladores para las pruebas (validan el formato de la API como lo haría la real) |
| `api/src/installers.js` | Instaladores autocontenidos por máquina (Linux `.sh`, Windows `.ps1`) con el toml, el token y los accesos incrustados; scripts de accesos (`ACCESS_PLATFORMS`) |
| `api/src/enroll.js` | Instalación con código de un solo uso: códigos, URL pública del hub y arranques (`irm … \| iex`, `curl … \| sudo bash`) |
| `api/public/enroll.js` | Panel: modal "Instalar con código" (máquina nueva por cliente o reinstalar una máquina), lista y revocación |
| `api/src/frps.js` | Cliente de la API del dashboard de frps (caché 3 s) |
| `api/src/config.js` | Variables de entorno |
| `frps/frps.toml` | Config de frps; toma valores con `{{ .Envs.X }}` |
| `iniciar-local.ps1` | Arranque local en Windows (hub + frps) |
| `frp.ps1` | Descarga `frpc.exe`/`frps.exe` a `frp/` |
| `actualizar.ps1` | Aplica un zip de actualización: detiene hub (solo puerto 8090)/frps/frpc, copia sin tocar `frp/`, `data/`, `.git`, `.env`, `frpc-*.toml`, rearranca y relanza los frpc previos |
| `deploy/install.sh` | Instalación en Linux con systemd |
| `deploy/frpc-install.sh` | Instala frpc como servicio en una máquina Linux |
| `deploy/node-red-alertas-whatsapp.json` | Flujo Node-RED: webhook de alertas → WhatsApp (CallMeBot) |
| `test/e2e.sh` | Prueba de punta a punta con frps/frpc reales (205 casos; SNMP requiere root, `snmpd` y `snmpsim-command-responder`) |

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

Panel local: `http://127.0.0.1:8090`. Primera vez: crear el administrador con el token `prueba-local-1234567890`; después, usuario y contraseña. Servicios http: `http://<servicio>-<maquina>.localhost:8081` (Chrome/Edge resuelven `*.localhost`).

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

## SNMP: reglas (no romper)

- Transporte: la sede publica cada equipo como `sudp` llamado `snmp-<id>-r<rev>` (en su `accesos-<id>.toml`, sin clave). `NewProxy` inyecta `sk = snmp_devices.secret` y `allow_users = ['_hub']`. `rev` sube al cambiar host/puerto: la configuración vieja se rechaza y el equipo queda "pendiente".
- frpc del hub: usuario `_hub` (los ids de máquina no admiten `_`), token aleatorio por arranque, comparado en `Login`; no puede publicar proxies. Config en `<dir de hub.db>/hub-frpc.toml` (600), recarga con `GET /api/reload` del webServer local; al arrancar mata un frpc del hub huérfano (pid en `hub-frpc.pid`). `actualizar.ps1` no lo relanza.
- Visitantes del hub: uno por equipo habilitado, `bindAddr 127.0.0.1`, `bind_port` único desde `SNMP_PORT_BASE`. Cualquier cambio de equipos ⇒ `hub.sync()`.
- Estados sin culpa del equipo (`pendiente`, `sede_desconectada`, `sin_transporte`, `deshabilitado`) **no alertan**. "Sin respuesta" alerta tras 2 fallos seguidos.
- Alertas: `alert_state` por equipo `{clave: {level, text, since, notified}}`; se avisa al superar `graceSeconds` de Alertas, se re-avisa si sube de aviso a crítico y se envía `snmp_ok` al resolverse.
- Solo lectura: no hay SET. Secretos (comunidad, contraseñas v3) nunca salen en la API (`********` conserva el valor al editar) ni a la IA.
- Historial: `snmp_samples` WITHOUT ROWID `(device_id, metric, ts)`; métricas `hist` del perfil + `if.<idx>.in/out` (vigiladas o físicas arriba, máx. 24) + `supply.<idx>` + `disk.<idx>` + `c.<clave>`; poda a 30 días.
- Detección: `ups-apc` → `ups` → `printer` → `host` (hrSystemUptime, salvo sysServices solo capa 2/3) → `network` → `generic`.

## Instalación con código: reglas (no romper)

- Solo admin genera (`POST /api/enrollments`). El código (12 caracteres de `ALPHABET`, 60 bits) se muestra **una vez**; en `enrollments` solo `code_hash` (sha256 con prefijo) y `hint` (últimos 4).
- `GET /i/:code/:platform` es público y **no lleva secretos**: solo el código que la persona ya tiene. Código inválido ⇒ 200 con un arranque que solo imprime el error (curl -f e irm no muestran nada útil con 4xx).
- `POST /api/enroll` es público: canje atómico (`useEnrollment` con `used_at IS NULL AND revoked_at IS NULL AND expires_at > now`) dentro de la transacción que rota el token o crea la máquina. Devuelve el instalador normal (`PLATFORMS[..].build`).
- Generar un código **no** toca el token; el token se rota al canjear (modo máquina). Modo nuevo: `normalizeMachine({name: hostname limpio, client})`.
- Límite: 10 códigos inexistentes por IP en 15 min ⇒ 429 (también en el arranque). Usados, vencidos o revocados no cuentan.
- Arranque Windows: todo dentro de `& { … }` y `return` (un `exit` en `irm | iex` cierra la ventana); solo ASCII (PS 5.1 puede decodificar mal acentos); escribe el instalador con BOM en `GetTempPath()`, lo ejecuta con `powershell -ExecutionPolicy Bypass -File` y lo borra.
- Arranque Linux: exige root, canjea con curl o wget, valida que la respuesta empiece con `#!/usr/bin/env bash`, ejecuta y borra el temporal (`umask 077`).
- URL: `HUB_PUBLIC_URL` o la del request (`x-forwarded-proto/host`, saneada). El panel avisa si es loopback o http.
- `effectiveServerAddr`: si el servidor frps es 127.0.0.1 pero el hub se abrió por una dirección de red, el código y el instalador usan el host del hub (en el equipo, 127.0.0.1 sería él mismo). El panel no propone 127.0.0.1 si conoce otra dirección.

## Respaldos y estado: reglas (no romper)

- Nombre `hub-AAAAMMDD-HHMMSSmmm-(auto|manual).db[.enc]` (UTC con milisegundos: dos seguidos no se pisan). Las rutas solo aceptan nombres que cumplan `NAME_RE` (sin rutas arbitrarias).
- El respaldo se hace con `VACUUM INTO ?` en un temporal, se borran `sessions`, se verifica y luego se renombra o cifra. Nunca copiar `hub.db` a mano con el hub corriendo (WAL).
- Programación: `lastSlot()` calcula la última hora programada en `TZ_ALERTS`; si `lastAutoAt` es anterior, toca respaldar (también al arrancar). La retención solo borra automáticos.
- Fallo ⇒ evento `respaldo_fallido` + alerta `backup_failed` (monitor.notify) + `POST /api/backups` responde 500.
- `/api/health` es público y no debe exponer datos: solo `ok`, `status`, `version` y `checks` booleanos. `/api/status` es solo admin.
- Contadores `stats` (plugin y API) viven en memoria desde el arranque.
- En pruebas, no usar `pkill -f`/`pgrep -f` con un patrón que aparezca en el propio comando: se mata la shell. Detener por puerto (`lsof -t -iTCP:<puerto>`) o `pidof`.

## Usuarios y permisos: reglas (no romper)

- Cada ruta declara su permiso en `route(método, ruta, handler, perm)`: `public`, `session` (permitida con cambio de contraseña pendiente), `any`, `staff` (por defecto) o `admin`. Los handlers reciben `ctx` (`Access`).
- Máquinas: siempre `mustMachine(id, ctx, { write })`: **404** si no la ve (no revelar que existe), 403 si la ve pero no puede operarla. Listas: `visibleMachines(ctx)`; eventos con `visible`.
- Visibilidad: admin y token de API → todo (`clientIds = null`); técnico → `user_clients`; cliente → su `client_id`. Máquinas sin cliente: solo admin.
- Rol cliente: vistas con `clientMachineView` (sin `ai`, accesos ni datos internos) y resumen sin `ai`/`alerts`.
- Sesión: cookie `iit_sesion` (`HttpOnly`, `SameSite=Strict`, `Secure` con `COOKIE_SECURE=1` o `X-Forwarded-Proto: https`); en la base solo el SHA-256 del token. Con cookie, todo método ≠ GET exige `X-Requested-With: iit-panel`.
- Login: mensaje genérico para usuario/contraseña; `verifyPassword` contra hash de relleno si el usuario no existe. 5 fallos → `locked_until` 15 min; 20 fallos por IP en 15 min → 429. TOTP con ±1 intervalo y `totp_last_step` contra reuso.
- Siempre debe quedar un admin habilitado; nadie se deshabilita, elimina ni quita el rol admin a sí mismo. Cambios de rol, deshabilitar o restablecer contraseña borran sus sesiones.
- IA: `ai.allowFor(conv)` filtra herramientas en `panel:general:u:<id>`; aprobar exige poder operar la máquina y la respuesta solo incluye la conversación si `convVisible`.
- Auditoría: no pasar el usuario a mano; `requestContext.run({ actor })` lo pone el servidor y `store.event` lo lee.

## Servicios privados (stcp): reglas (no romper)

- `stcp` no tiene `remote_port` ni `subdomain`; `services.secret` guarda la clave (la genera el hub). El `frpc.toml` del **dueño no lleva la clave**.
- `NewProxy` de un stcp responde `{reject:false, unchange:false, content:{...c, sk, allow_users}}`: la clave y los visitantes los fija el hub. Sin visitantes se usa `['!nadie']` (con lista vacía frps deja entrar al propio dueño).
- Visitantes = máquinas registradas (`service_access`: servicio, visitante, `bind_port` único por visitante). No hay op de plugin para visitantes: la seguridad es login del visitante + `allowUsers` + clave.
- Cambiar accesos, rotar clave, borrar un stcp o borrar una máquina visitante ⇒ `plugin.requestReload(dueño)`: se rechaza **un** Ping, frpc cierra la sesión y reconecta (~15 s) y frps vuelve a preguntar `NewProxy`. El Login limpia la marca.
- Todo `frpc.toml` lleva `includes = ['<dir>/accesos-<id>.toml']`. frp resuelve rutas relativas contra el **directorio de trabajo** (no el del toml) y falla si la **carpeta** no existe, pero ignora un archivo inexistente: por eso es un archivo en la misma carpeta y no una subcarpeta. Instaladores: `/etc/iit-frpc/` y `__IIT_DIR__\`.
- El archivo de accesos y los scripts `accesos-<id>.{sh,ps1}` llevan claves pero **no** el token de la máquina. `.ps1` con BOM.
- La IA no usa stcp (SSH de la IA sigue requiriendo `tcp`): haría falta que el hub sea visitante.

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
- Dashboard API usada: `/api/serverinfo`, `/api/clients` (incluye `online`), `/api/proxy/{http,https,tcp,stcp}`. No hay endpoint para expulsar un cliente: se hace rechazando `Ping`.
- `transport.heartbeatTimeout` debe ser > 0 en frps para que el rechazo de `Ping` expulse.
- `https` con `tlsMode: "local"` usa el plugin `https2http` de frpc: el TLS termina en la máquina, frps solo enruta por SNI.
- frpc 0.71 escribe `login to server success` (sin "the"); los instaladores buscan esa frase.
- Ping rechazado: frps responde `Pong{Error}` y frpc cierra la sesión al recibirlo (`handlePong` → `closeSession`), luego reconecta con backoff rápido.
- Visitante stcp: `NewVisitorConn` lleva el RunID de su sesión; frps toma el usuario de esa sesión y lo compara con `allowUsers` del proxy. Nombre destino = `serverUser.serverName`.
- `sudp` funciona igual que `stcp` (allowUsers + clave); el dashboard lo lista en `/api/proxy/sudp`. frpc admite `includes` con `[[proxies]]` además de `[[visitors]]`.
- frpc admin API (webServer): `GET /api/reload` recarga proxies y visitantes sin cortar la sesión.
- Plugin con contenido modificado: `NewProxy` acepta `unchange:false` + `content` y frps registra el proxy con ese contenido.
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

- Permisos finos por máquina o roles personalizados; usuarios de Telegram (hoy el chat configurado actúa como admin).
- Portal de cliente con alertas propias (Telegram/webhook por cliente).
- Probar la IA con una clave real (en desarrollo solo se probó con el simulador) y SSH desde Windows.
- Probar stcp con RDP real entre dos Windows (en desarrollo: SSH simulado e instalador Linux real del visitante, sin systemd).
- Que la IA use SSH privado: el frpc del hub ya existe; falta agregar visitantes stcp para los servicios SSH del alcance.
- SNMP: traps (hoy solo sondeo), AES-192/256, SET con aprobación, envío automático del archivo de accesos a la sede (API de admin del frpc de la sede).
- Emisión automática de certificados por máquina (DNS-01 con Cloudflare) para `https` con TLS local.
- Probar el instalador Windows en un equipo real (solo se validó el parseo con PowerShell 7 en Linux) y el camino systemd del instalador Linux en una Raspberry.
