# IIT Tunnel Hub

Registro y monitoreo de máquinas conectadas por túneles **frp**, con el mismo modelo de Home Assistant Cloud: cada equipo abre un túnel saliente hacia el servidor, sin abrir puertos ni necesitar IP pública, y queda publicado en un subdominio propio.

- **API REST + panel web** para registrar máquinas, publicar sus servicios y verlas en línea.
- **Token único por máquina** (solo se guarda su hash) y `frpc.toml` generado listo para instalar.
- **frps solo acepta lo registrado**: el hub actúa como *server plugin* y autoriza cada login, cada servicio, cada conexión y cada latido.
- **Deshabilitar o eliminar una máquina corta su tráfico** y la expulsa del servidor.
- **HTTPS de extremo a extremo** por SNI: el servidor enruta sin descifrar, el certificado vive en la máquina.
- Sin dependencias: Node.js 22 (con `node:sqlite`) y HTML/CSS/JS vanilla.

```
                       VPS o servidor local
                ┌──────────────────────────────────────┐
 Navegador ────▶│ frps :80 / :443 (SNI) / :20000-20100 │
                │   │  ▲ pregunta antes de aceptar     │
                │   │  └── hub :9000 (plugin) ─┐       │
                │   │                          │SQLite │
 Técnico   ────▶│   │      hub :8080 (panel/API)┘      │
                └───┼──────────────────────────────────┘
                    │ túnel saliente (frpc → :7000)
           ┌────────┴────────┐
           │ Máquina cliente │  frpc + Node-RED, UPS, NVR, SSH…
           └─────────────────┘
```

## Contenido

| Ruta | Qué es |
|---|---|
| `api/` | Hub: API, plugin de frps y panel (`api/public`) |
| `frps/frps.toml` | Configuración de frps (lee las variables del `.env`) |
| `docker-compose.yml` | Despliegue con Docker |
| `deploy/install.sh` | Despliegue sin Docker (systemd) |
| `deploy/frpc-install.sh` | Instala frpc como servicio en una máquina Linux |
| `test/e2e.sh` | Prueba de punta a punta con frps y frpc reales |

## 1. Preparar el DNS

Con el dominio en Cloudflare, cree dos registros **A** apuntando a la IP del servidor, ambos en modo **solo DNS (nube gris)**:

| Nombre | Para qué |
|---|---|
| `tuneles` | Donde se conectan las máquinas (`FRPS_PUBLIC_ADDR`) |
| `*.clientes` | Comodín de los servicios publicados (`FRPS_SUBDOMAIN_HOST`) |

> El proxy de Cloudflare (nube naranja) debe quedar apagado: terminaría el TLS en Cloudflare y no deja pasar el puerto 7000 ni el rango TCP.

En un servidor local de su red, use la IP de LAN o de ZeroTier en lugar de DNS público. Si quiere acceso desde Internet, redirija en el router los puertos 7000, 80, 443 y el rango TCP.

## 2. Instalar el servidor

### Opción A — Docker (recomendada en VPS)

```bash
git clone <repo> iit-tunnel-hub && cd iit-tunnel-hub
cp .env.example .env
nano .env        # ADMIN_TOKEN, FRPS_PUBLIC_ADDR, FRPS_SUBDOMAIN_HOST, FRPS_API_PASSWORD
docker compose up -d --build
```

Ambos contenedores usan la red del host (requiere Linux).

### Opción B — systemd (VPS o servidor local sin Docker)

Requiere Node.js 22.13 o superior.

```bash
sudo ./deploy/install.sh                 # crea /opt/iit-tunnel-hub/.env con tokens aleatorios
sudo nano /opt/iit-tunnel-hub/.env       # FRPS_PUBLIC_ADDR y FRPS_SUBDOMAIN_HOST
sudo systemctl start iit-hub iit-frps
```

### Firewall

| Puerto | Uso |
|---|---|
| 7000/tcp | Conexión de las máquinas (frpc) |
| 80/tcp, 443/tcp | Visitantes de servicios http / https |
| 20000–20100/tcp | Servicios tcp (SSH, RDP, Modbus TCP…) |
| 8080/tcp | Panel: **no lo abra a Internet** (ver abajo) |

### Acceso al panel

Por defecto el panel escucha en `127.0.0.1:8080`. Ábralo con un túnel SSH:

```bash
ssh -L 8080:127.0.0.1:8080 usuario@servidor     # luego http://localhost:8080
```

O ponga `HOST` con la IP de ZeroTier del servidor para abrirlo desde su red privada. Si lo publica en Internet, hágalo detrás de un proxy con HTTPS.

### Si el servidor ya tiene Nginx en el puerto 443

Ponga frps en otro puerto (`FRPS_VHOST_HTTPS_PORT=8443`, `PUBLIC_HTTPS_PORT=443`) y reparta el 443 por SNI sin descifrar:

```nginx
stream {
    map $ssl_preread_server_name $destino {
        ~\.clientes\.infraestructura-it\.com$  127.0.0.1:8443;   # frps
        default                                127.0.0.1:4443;   # sus sitios (mueva sus server{} a 4443)
    }
    server {
        listen 443;
        ssl_preread on;
        proxy_pass $destino;
    }
}
```

## 3. Registrar una máquina

En el panel: **+ Registrar máquina**, nombre, cliente y servicios. Al guardar aparecen el **token** (se muestra una sola vez) y el **frpc.toml** listo para descargar.

Tipos de servicio:

| Tipo | URL pública | Notas |
|---|---|---|
| `http` | `http://<servicio>-<maquina>.clientes…` | Simple. El tráfico viaja sin cifrar entre visitante y frps. |
| `https` · TLS en la máquina | `https://…` | frpc termina el TLS con el plugin `https2http`. Requiere certificado en la máquina. **El servidor no puede leer el tráfico.** |
| `https` · TLS del servicio | `https://…` | El servicio local ya habla HTTPS (NVR, UPS con panel HTTPS…). |
| `tcp` | `servidor:20000` | Puerto público asignado del rango. |

### Instalar frpc en la máquina

**Linux** (gateway, Raspberry Pi, mini PC):

```bash
sudo ./deploy/frpc-install.sh frpc-<maquina>.toml
```

**Windows**: descargue `frp_0.71.0_windows_amd64.zip` de [GitHub](https://github.com/fatedier/frp/releases), copie `frpc.exe` y el toml a `C:\frp\` y regístrelo como servicio con [NSSM](https://nssm.cc):

```powershell
nssm install frpc C:\frp\frpc.exe -c C:\frp\frpc.toml
nssm set frpc AppDirectory C:\frp
nssm start frpc
```

### Certificados para HTTPS con TLS en la máquina

El `frpc.toml` espera `./certs/fullchain.pem` y `./certs/privkey.pem` (en Linux: `/etc/frp/certs/`). Como el servicio no está expuesto por HTTP, use el reto **DNS-01** con la API de Cloudflare, por ejemplo con [lego](https://go-acme.github.io/lego/):

```bash
CLOUDFLARE_DNS_API_TOKEN=xxxx lego --email soporte@infraestructura-it.com --dns cloudflare \
  -d panel-maquina.clientes.infraestructura-it.com --path /etc/frp/lego run
```

lego guarda el par en `/etc/frp/lego/certificates/`; enlácelo a `/etc/frp/certs/fullchain.pem` y `privkey.pem` y programe la renovación con `lego … renew`.

Para pruebas sirve un certificado comodín `*.clientes.infraestructura-it.com` distribuido a las máquinas, a costa de que todas compartan la misma llave.

## API

Todas las rutas requieren `Authorization: Bearer <ADMIN_TOKEN>`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/summary` | Totales y estado de frps |
| GET | `/api/machines` | Máquinas con servicios y estado en vivo |
| POST | `/api/machines` | Registrar (devuelve token y frpc.toml) |
| GET | `/api/machines/:id` | Detalle |
| PATCH | `/api/machines/:id` | Cambiar `name`, `client`, `description`, `enabled` |
| DELETE | `/api/machines/:id` | Eliminar (corta su tráfico) |
| POST | `/api/machines/:id/rotate-token` | Nuevo token y frpc.toml |
| GET | `/api/machines/:id/frpc.toml` | Configuración actual, sin el token |
| POST | `/api/machines/:id/services` | Agregar servicio |
| DELETE | `/api/machines/:id/services/:nombre` | Quitar servicio |
| GET | `/api/events?machine=:id&limit=100` | Actividad (logins, rechazos, servicios) |

Ejemplo:

```bash
curl -X POST http://127.0.0.1:8080/api/machines \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Node-RED Planta",
    "client": "Clínica Norte",
    "services": [
      { "name": "nodered", "type": "https", "tlsMode": "local", "localPort": 1880 },
      { "name": "ssh",     "type": "tcp",   "localPort": 22 }
    ]
  }'
```

Campos de un servicio: `name` (a-z, 0-9, guiones), `type` (`http`, `https`, `tcp`), `localIp` (por defecto `127.0.0.1`), `localPort`, y según el tipo `subdomain`, `tlsMode` (`local` o `passthrough`) o `remotePort` (se asigna solo si no se envía).

## Cómo se aplica la seguridad

| Momento | Qué verifica el hub |
|---|---|
| **Login** de frpc | Que `user` sea una máquina registrada y habilitada, y que `metadatas.token` coincida con el hash guardado |
| **NewProxy** | Que el servicio exista para esa máquina con el mismo tipo, subdominio o puerto. No se aceptan `customDomains` |
| **NewUserConn** | En cada visitante tcp/https: que la máquina siga habilitada (corte inmediato) |
| **NewWorkConn** | En cada conexión de trabajo (cubre el tipo http) |
| **Ping** (cada 15 s) | Si la máquina fue deshabilitada o eliminada, frpc cierra la sesión y ya no puede volver a entrar |

Si el hub no responde, frps rechaza: el sistema falla cerrado. Por eso, al reiniciar o actualizar el hub, las máquinas se desconectan unos segundos y vuelven a entrar solas cuando el hub regresa.

## Pruebas

```bash
./test/e2e.sh
```

Levanta frps, el hub y frpc reales en localhost y verifica 34 casos: registro, tráfico http/tcp/https por SNI, certificado presentado por la máquina, rechazo de tokens falsos y de servicios no registrados, deshabilitar y eliminar, y rotación de token.

## Límites conocidos

- Un solo token de administración; no hay usuarios ni roles.
- `node:sqlite` aún está marcado como experimental en Node 22 (estable en uso, se oculta el aviso).
- La expulsión por latido depende de que frpc cierre la sesión; un frpc modificado podría mantener la conexión, pero no recibiría tráfico tcp ni https (NewUserConn) ni nuevas conexiones de trabajo.
- El tipo `http` no cifra entre el visitante y frps: para paneles con contraseña use `https`.
