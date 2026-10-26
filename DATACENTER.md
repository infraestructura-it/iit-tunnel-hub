# Módulo Datacenter

Monitoreo de sitio en una ventana propia: sensores de **temperatura, humedad, monóxido (CO),
aperturas con validación biométrica** y **energía (3 fases: voltajes y corrientes)**, más **cámaras IP
(RTSP)**, con gráficas históricas (12 h / 24 h / 48 h / 72 h / semana / mes) y alertas por umbral
(reusa Telegram/webhooks del hub).

Se abre desde el panel con el botón **🏢 Datacenter** (o `/datacenter.html`).

## Cómo llegan las lecturas: push por HTTP

Las lecturas se **envían** al hub (no las consulta el hub). Así es agnóstico al medio físico: lo que lea
el sensor en sitio (RS232, Modbus, Ethernet, 4G, 5G) se manda por HTTP. El emisor se autentica con el
**token de la máquina** (el mismo de `frpc`/el instalador), así que cada sitio solo puede reportar sus
sensores.

### Registrar el sensor (una vez, en el panel)
🏢 Datacenter → **+ Sensor** → tipo, nombre, equipo/sede, medio de conexión y umbrales. Cada sensor
tiene una **clave** (slug, p. ej. `temp-rack`) que es la que usa el emisor para identificarlo.

### Enviar lecturas

```
POST /api/dc/ingest
X-IIT-Machine: <id-de-la-maquina>
Authorization: Bearer <token-de-la-maquina>
Content-Type: application/json

{ "readings": [
    { "key": "temp-rack", "value": 23.6 },
    { "key": "humedad-rack", "value": 48 },
    { "key": "co-sala", "value": 7 },
    { "key": "puerta-rack", "event": { "state": "abierto", "user": "jairo", "result": "ok" } },
    { "key": "tablero", "phases": { "v": [121,120,122], "i": [5.1,6.0,4.8], "f": 60, "pf": 0.98 } }
] }
```

- **temperatura / humedad / monóxido:** `value` numérico.
- **apertura (biométrica):** `event: { state: "abierto"|"cerrado", user, result: "ok"|"denegado" }`.
  Un `denegado` deja el sensor en **crítico** y queda en el registro de eventos.
- **energía:** `phases: { v:[L1,L2,L3], i:[L1,L2,L3], f, pf }`.
- `ts` opcional (epoch en segundos); por defecto la hora del hub.

Respuesta: `{ "accepted": N, "results": [ { "key", "status" } | { "key", "error" } ] }`.

### Ejemplo con curl
```bash
curl -s https://hubups.infraestructura-it.com:8443/api/dc/ingest \
  -H "X-IIT-Machine: sede-norte" \
  -H "Authorization: Bearer EL_TOKEN_DE_LA_MAQUINA" \
  -H "Content-Type: application/json" \
  -d '{"readings":[{"key":"temp-rack","value":24.2},{"key":"humedad-rack","value":47}]}'
```

### Ejemplo en Python (plantilla)
Ver `deploy/dc-push-ejemplo.py`: estructura el envío; reemplace `leer_sensores()` por su lectura real
(pyserial para RS232, pymodbus para Modbus, GPIO, etc.). Córralo por cron cada 1–5 min.

## Umbrales y alertas
Para temp/humedad/CO se definen `aviso ≤ / ≥` y `crítico ≤ / ≥`. Al entrar en **crítico** el hub envía
alerta (Telegram/webhook) y al normalizarse envía el aviso de vuelta. El estado se ve por color en la
tarjeta.

## Cámaras (RTSP)
🏢 Datacenter → **+ Cámara** → nombre, URL RTSP y, si la cámara la expone, una **URL de instantánea JPEG**
(p. ej. `http://IP/snapshot.jpg` o el endpoint ONVIF de snapshot). El panel muestra la instantánea
(el hub la trae por proxy, así que **el hub debe poder alcanzar la cámara** por red/ZeroTier) y un botón
para **copiar el RTSP** y abrirlo en VLC. El **streaming en vivo en el navegador** llega en una segunda
fase con un gateway RTSP→WebRTC (go2rtc/MediaMTX).

## Notas
- Las lecturas se guardan ~35 días (cubre el rango "mes"); se podan solas.
- Si un sensor no reporta en 15 min, la tarjeta lo marca "sin datos recientes".
- Permisos: un técnico solo ve los sensores/cámaras de sus clientes; el admin, todos.
