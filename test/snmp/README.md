# Equipos SNMP simulados (pruebas)

Archivos `.snmprec` para [snmpsim](https://github.com/lextudio/snmpsim): cada archivo es una comunidad SNMP v2c
(`ups`, `ups-bateria`, `apc`, `printer`, `switch`). `test/e2e.sh` los usa para probar los perfiles por el túnel real.

    pip install snmpsim-lextudio
    snmpsim-command-responder --data-dir=test/snmp --agent-udpv4-endpoint=127.0.0.1:16162
    snmpwalk -v2c -c ups 127.0.0.1:16162 1.3.6.1.2.1.33
