#!/usr/bin/env python3
# Ejemplo de "edge" del módulo Datacenter: lee sensores en sitio y ENVÍA las lecturas al hub por HTTP.
# Agnóstico al medio: reemplace leer_sensores() por su lectura real (pyserial/RS232, pymodbus/Modbus, GPIO...).
# Córralo por cron cada 1-5 min. Solo usa la librería estándar.
#
#   HUB=https://hubups.infraestructura-it.com:8443 MACHINE=sede-norte TOKEN=... python3 dc-push-ejemplo.py
#
import json
import os
import ssl
import urllib.request

HUB = os.environ.get("HUB", "https://hubups.infraestructura-it.com:8443").rstrip("/")
MACHINE = os.environ.get("MACHINE", "")
TOKEN = os.environ.get("TOKEN", "")


def leer_sensores():
    """Devuelve la lista de lecturas. Reemplace por la lectura real de sus sensores.
    Las 'key' deben coincidir con las claves registradas en el panel (🏢 Datacenter → + Sensor)."""
    return [
        {"key": "temp-rack", "value": 24.2},
        {"key": "humedad-rack", "value": 47},
        {"key": "co-sala", "value": 6},
        # apertura biométrica (evento):
        # {"key": "puerta-rack", "event": {"state": "abierto", "user": "jairo", "result": "ok"}},
        # energía trifásica:
        {"key": "tablero", "phases": {"v": [121, 120, 122], "i": [5.1, 6.0, 4.8], "f": 60, "pf": 0.98}},
    ]


def enviar(readings):
    if not MACHINE or not TOKEN:
        raise SystemExit("Defina MACHINE y TOKEN (el id y el token de la máquina en el hub).")
    data = json.dumps({"readings": readings}).encode("utf-8")
    req = urllib.request.Request(
        f"{HUB}/api/dc/ingest",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-IIT-Machine": MACHINE,
            "Authorization": f"Bearer {TOKEN}",
        },
    )
    # El hub usa un certificado válido de Let's Encrypt; la verificación TLS normal basta.
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, data, timeout=15, context=ctx) as r:
        print(r.status, r.read().decode("utf-8"))


if __name__ == "__main__":
    enviar(leer_sensores())
