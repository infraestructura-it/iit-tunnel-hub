# iit-agente

Agente de IIT Tunnel Hub para **compartir pantalla por WebRTC directo** (como Raspberry Pi Connect).

- Corre en el equipo junto a `frpc` (lo instala el instalador Linux del hub como servicio `iit-agente`).
- Se conecta al hub por WebSocket (`/api/agent/ws`) con el id y el token de la máquina (`/etc/iit-frpc/agente.json`).
- Cuando un técnico abre "Pantalla" en el panel, responde la oferta WebRTC del navegador y une el canal de datos
  `rfb` con el servidor VNC local (wayvnc en la Raspberry). La imagen va directo navegador ⇄ equipo.

## Compilar

```bash
./agente/compilar.sh            # genera agente/dist/iit-agente-linux-{arm,arm64,amd64} y SHA256SUMS
# sin acceso a proxy.golang.org:
GOPROXY=direct GOSUMDB=off ./agente/compilar.sh
```

Dependencias: [pion/webrtc](https://github.com/pion/webrtc) v4 (MIT) y [gorilla/websocket](https://github.com/gorilla/websocket) (BSD-2).
`go.mod` toma `golang.org/x/*` de sus espejos oficiales en GitHub.

## Uso manual

```bash
iit-agente -config /etc/iit-frpc/agente.json   # {"hub":"http://hub:8090","machine":"id","token":"…"}
iit-agente version
iit-agente probar 'ws://hub:8090/api/remote/ws?t=<ticket>'   # prueba: hace de navegador (test/e2e.sh)
journalctl -u iit-agente -f
```
