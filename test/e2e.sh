#!/usr/bin/env bash
# Prueba de punta a punta: frps real + hub + frpc real, todo en localhost.
# Uso:  ./test/e2e.sh            (descarga frp si no está en ./.frp)
# Requiere: node >= 22.13, curl, jq, openssl, python3
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRP_VERSION="${FRP_VERSION:-0.71.0}"
FRP_DIR="$ROOT/.frp/frp_${FRP_VERSION}_linux_amd64"
WORK="$(mktemp -d)"
PIDS=()

cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()   { echo "  ✔ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✘ $1"; FAIL=$((FAIL+1)); }
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }

if [ ! -x "$FRP_DIR/frps" ]; then
  echo "Descargando frp v$FRP_VERSION…"
  mkdir -p "$ROOT/.frp"
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" | tar xz -C "$ROOT/.frp"
fi

# ---------- entorno ----------
export ADMIN_TOKEN="e2e-admin-token-0123456789"
export HOST=127.0.0.1 PORT=18088 PLUGIN_HOST=127.0.0.1 PLUGIN_PORT=19000
export DB_PATH="$WORK/hub.db"
export FRPS_PUBLIC_ADDR=127.0.0.1 FRPS_BIND_PORT=17000
export FRPS_VHOST_HTTP_PORT=18080 FRPS_VHOST_HTTPS_PORT=18443
export FRPS_SUBDOMAIN_HOST=test.local FRP_AUTH_TOKEN="token-global-e2e"
export FRPS_TCP_PORT_MIN=21000 FRPS_TCP_PORT_MAX=21010
export FRPS_API_URL=http://127.0.0.1:7500 FRPS_API_PASSWORD="dash-e2e"
export ALERT_CHECK_SECONDS=1

API="http://127.0.0.1:$PORT/api"
AUTH=(-H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json")
api() { local m="$1" p="$2"; shift 2; curl -s -X "$m" "${AUTH[@]}" "$API$p" "$@"; }

# Servicio local de prueba (lo que sería el Node-RED del cliente)
mkdir -p "$WORK/www" && echo "hola-desde-la-maquina" > "$WORK/www/index.html"
python3 -m http.server 18999 --bind 127.0.0.1 --directory "$WORK/www" >/dev/null 2>&1 & PIDS+=($!)

# Receptor de webhooks de alertas: guarda cada POST como una línea JSON
cat > "$WORK/recv.py" <<'PY'
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers['content-length']))
        open(sys.argv[2], 'a').write(b.decode() + '\n')
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
touch "$WORK/hooks.log"
python3 "$WORK/recv.py" 19600 "$WORK/hooks.log" & PIDS+=($!)

node --disable-warning=ExperimentalWarning "$ROOT/api/src/server.js" > "$WORK/api.log" 2>&1 & PIDS+=($!)
"$FRP_DIR/frps" -c "$ROOT/frps/frps.toml" > "$WORK/frps.log" 2>&1 & FRPS_PID=$!; PIDS+=($FRPS_PID)
sleep 1.5

wait_for() { local cond="$1" n=0; while [ $n -lt 40 ]; do eval "$cond" && return 0; sleep 0.25; n=$((n+1)); done; return 1; }
wait_for_long() { local cond="$1" n=0; while [ $n -lt 70 ]; do eval "$cond" && return 0; sleep 1; n=$((n+1)); done; return 1; }
start_frpc() { "$FRP_DIR/frpc" -c "$1" > "$1.log" 2>&1 & echo $!; }

echo "1. API y frps"
check "health responde" '[ "$(api GET /health | jq -r .ok)" = "true" ]'
check "sin token → 401" '[ "$(curl -s -o /dev/null -w "%{http_code}" $API/machines)" = "401" ]'
check "frps alcanzable desde el hub" 'wait_for "[ \"\$(api GET /summary | jq -r .frps.reachable)\" = true ]"'

echo "2. Registro de máquina"
api POST /machines -d '{"name":"Node-RED Planta","client":"Clínica Norte","services":[
  {"name":"web","type":"http","localPort":18999},
  {"name":"shell","type":"tcp","localPort":18999},
  {"name":"panel","type":"https","tlsMode":"local","localPort":18999,"subdomain":"panel-clinica"}]}' > "$WORK/create.json"
ID=$(jq -r .machine.id "$WORK/create.json")
TOKEN=$(jq -r .token "$WORK/create.json")
check "id generado a partir de cliente + nombre" '[ "$ID" = "clinica-norte-node-red-planta" ]'
check "token entregado" '[ ${#TOKEN} -ge 40 ]'
check "puerto TCP asignado del rango" '[ "$(jq -r ".machine.services[] | select(.name==\"shell\") | .remotePort" $WORK/create.json)" = "21000" ]'
check "subdominio duplicado → 409" '[ "$(api POST /machines -o /dev/null -w "%{http_code}" -d "{\"name\":\"otra\",\"services\":[{\"name\":\"x\",\"type\":\"http\",\"localPort\":80,\"subdomain\":\"panel-clinica\"}]}")" = "409" ]'
check "la máquina fallida no quedó registrada (transacción)" '[ "$(api GET /machines | jq length)" = "1" ]'

# Certificado autofirmado para el modo https "local" (el TLS termina en la máquina)
mkdir -p "$WORK/m1/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=panel-clinica.test.local" \
  -keyout "$WORK/m1/certs/privkey.pem" -out "$WORK/m1/certs/fullchain.pem" >/dev/null 2>&1
jq -r .frpcToml "$WORK/create.json" > "$WORK/m1/frpc.toml"
( cd "$WORK/m1" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc.log 2>&1 ) & FRPC1=$!; PIDS+=($FRPC1)

echo "3. Conexión y tráfico"
check "la máquina aparece en línea" 'wait_for "[ \"\$(api GET /machines/$ID | jq -r .online)\" = true ]"'
online_services() { api GET "/machines/$ID" | jq '[.services[]|select(.status=="online")]|length'; }
check "sus 3 servicios en línea" 'wait_for "[ \$(online_services) = 3 ]"'
check "HTTP por subdominio llega al servicio local" '[ "$(curl -s -H "Host: web-$ID.test.local" http://127.0.0.1:18080/)" = "hola-desde-la-maquina" ]'
check "TCP por puerto remoto llega al servicio local" '[ "$(curl -s http://127.0.0.1:21000/)" = "hola-desde-la-maquina" ]'
check "HTTPS por SNI llega al servicio local" '[ "$(curl -sk --noproxy "*" --resolve panel-clinica.test.local:18443:127.0.0.1 https://panel-clinica.test.local:18443/)" = "hola-desde-la-maquina" ]'
check "el certificado lo presenta la máquina, no frps" 'echo | openssl s_client -connect 127.0.0.1:18443 -servername panel-clinica.test.local 2>/dev/null | grep -q "CN *= *panel-clinica.test.local"'
check "se registró el login con hostname y versión" '[ "$(api GET /machines/$ID | jq -r .lastLogin.version)" = "$FRP_VERSION" ]'

echo "4. Intentos no autorizados"
cat > "$WORK/bad.toml" <<EOF
serverAddr = "127.0.0.1"
serverPort = 17000
user = "$ID"
auth.token = "$FRP_AUTH_TOKEN"
metadatas.token = "token-falso"
[[proxies]]
name = "web2"
type = "http"
localPort = 18999
subdomain = "robado"
EOF
BAD=$(start_frpc "$WORK/bad.toml"); PIDS+=($BAD)
check "token falso rechazado por el hub" 'wait_for "grep -q \"token inválido\" $WORK/bad.toml.log"'
kill $BAD 2>/dev/null

cat > "$WORK/rogue.toml" <<EOF
serverAddr = "127.0.0.1"
serverPort = 17000
user = "$ID"
auth.token = "$FRP_AUTH_TOKEN"
metadatas.token = "$TOKEN"
[[proxies]]
name = "intruso"
type = "http"
localPort = 18999
subdomain = "banco"
EOF
ROGUE=$(start_frpc "$WORK/rogue.toml"); PIDS+=($ROGUE)
check "servicio no registrado rechazado" 'wait_for "grep -q \"no está registrado\" $WORK/rogue.toml.log"'
check "el subdominio no autorizado no responde" '[ "$(curl -s -o /dev/null -w "%{http_code}" -H "Host: banco.test.local" http://127.0.0.1:18080/)" = "404" ]'
kill $ROGUE 2>/dev/null
check "eventos de rechazo registrados" '[ "$(api GET "/events?machine=$ID" | jq "[.[]|select(.kind|test(\"rechaz\"))]|length")" -ge 2 ]'

echo "5. Deshabilitar corta el tráfico al instante"
api PATCH /machines/$ID -d '{"enabled":false}' >/dev/null
http_blocked() { for i in 1 2 3; do r=$(curl -s -m 3 -H "Host: web-$ID.test.local" http://127.0.0.1:18080/); done; [ "$r" != "hola-desde-la-maquina" ]; }
check "tráfico HTTP bloqueado" 'http_blocked'
check "tráfico HTTPS bloqueado" '[ "$(curl -sk -m 3 --noproxy "*" --resolve panel-clinica.test.local:18443:127.0.0.1 https://panel-clinica.test.local:18443/)" != "hola-desde-la-maquina" ]'
check "la máquina deshabilitada es expulsada (latido rechazado)" 'wait_for_long "[ \"\$(api GET /machines/$ID | jq -r .online)\" = false ]"'
check "tráfico TCP bloqueado" '[ "$(curl -s -m 3 http://127.0.0.1:21000/)" != "hola-desde-la-maquina" ]'
api PATCH /machines/$ID -d '{"enabled":true}' >/dev/null
check "rehabilitada, frpc reconecta solo" 'wait_for_long "[ \"\$(api GET /machines/$ID | jq -r .online)\" = true ]"'
check "rehabilitada, el tráfico vuelve" 'wait_for "[ \"\$(curl -s -H \"Host: web-$ID.test.local\" http://127.0.0.1:18080/)\" = hola-desde-la-maquina ]"'

echo "6. Rotación de token"
NEW=$(api POST /machines/$ID/rotate-token | jq -r .token)
check "token nuevo distinto" '[ -n "$NEW" ] && [ "$NEW" != "$TOKEN" ]'
kill $FRPC1 2>/dev/null; sleep 1
( cd "$WORK/m1" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc2.log 2>&1 ) & OLD=$!; PIDS+=($OLD)
check "el token viejo ya no entra" 'wait_for "grep -q \"token inválido\" $WORK/m1/frpc2.log"'
kill $OLD 2>/dev/null
sed -i "s|^metadatas.token = .*|metadatas.token = \"$NEW\"|" "$WORK/m1/frpc.toml"
( cd "$WORK/m1" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc3.log 2>&1 ) & FRPC3=$!; PIDS+=($FRPC3)
check "el token nuevo conecta" 'wait_for "[ \"\$(api GET /machines/$ID | jq -r .online)\" = true ]"'

echo "7. Instaladores"
inst() { api POST /machines/$ID/installer -d "{\"platform\":\"$1\",\"token\":\"$2\",\"serverAddr\":\"${3:-127.0.0.1}\"}"; }
check "instalador con token incorrecto → 403" '[ "$(api POST /machines/$ID/installer -o /dev/null -w "%{http_code}" -d "{\"platform\":\"linux\",\"token\":\"falso\"}")" = "403" ]'
check "serverAddr inválido → 400" '[ "$(api POST /machines/$ID/installer -o /dev/null -w "%{http_code}" -d "{\"platform\":\"linux\",\"token\":\"$NEW\",\"serverAddr\":\"a;b\"}")" = "400" ]'
inst linux "$NEW" 10.1.2.3 > "$WORK/instalar.sh"
check "instalador Linux con sintaxis bash válida" 'bash -n "$WORK/instalar.sh"'
awk "/^cat > .*<<'IIT_FRPC_TOML'/{f=1;next} /^IIT_FRPC_TOML/{f=0} f" "$WORK/instalar.sh" > "$WORK/inst.toml"
check "la configuración incrustada es válida para frpc" '"$FRP_DIR/frpc" verify -c "$WORK/inst.toml" >/dev/null'
check "usa la dirección de servidor indicada" 'grep -q "serverAddr = \"10.1.2.3\"" "$WORK/inst.toml"'
check "lleva el token de la máquina y el token global" 'grep -q "$NEW" "$WORK/inst.toml" && grep -q "auth.token" "$WORK/inst.toml"'
inst windows "$NEW" > "$WORK/instalar.ps1"
check "instalador Windows generado" 'grep -q "Register-ScheduledTask" "$WORK/instalar.ps1"'

echo "8. Alertas"
hooks() { jq -r 'select(.machine.id == "'"$ID"'" or .machine == null) | .type' "$WORK/hooks.log" 2>/dev/null | paste -sd' '; }
api PUT /alerts/settings -d '{"graceSeconds":2,"webhooks":["http://127.0.0.1:19600/alertas"]}' >/dev/null
check "webhook ftp:// rechazado" '[ "$(api PUT /alerts/settings -o /dev/null -w "%{http_code}" -d "{\"webhooks\":[\"ftp://x\"]}")" = "400" ]'
check "prueba de alertas llega al webhook" '[ "$(api POST /alerts/test | jq -r ".results[0].ok")" = "true" ] && grep -q "\"type\":\"test\"" "$WORK/hooks.log"'
: > "$WORK/hooks.log"
kill $FRPC3 2>/dev/null
check "caída de la máquina → alerta machine_offline" 'wait_for_long "hooks | grep -q machine_offline"'
check "la alerta trae el texto en español" 'jq -r "select(.type==\"machine_offline\") | .text" "$WORK/hooks.log" | grep -q "sin conexión"'
( cd "$WORK/m1" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc4.log 2>&1 ) & FRPC4=$!; PIDS+=($FRPC4)
check "reconexión → alerta machine_online con tiempo caída" 'wait_for_long "hooks | grep -q machine_online" && [ "$(jq -r "select(.type==\"machine_online\") | .downtimeSeconds" "$WORK/hooks.log")" -ge 2 ]'
: > "$WORK/hooks.log"
kill $FRPC4 2>/dev/null; sleep 0.5
( cd "$WORK/m1" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc5.log 2>&1 ) & FRPC5=$!; PIDS+=($FRPC5)
wait_for "[ \"\$(api GET /machines/$ID | jq -r .online)\" = true ]"; sleep 3
check "corte breve (menor que la gracia) no alerta" '[ -z "$(hooks)" ]'
api PATCH /machines/$ID -d '{"alerts":false}' >/dev/null
kill $FRPC5 2>/dev/null; sleep 5
check "máquina con alertas apagadas no alerta" '[ -z "$(hooks)" ]'
api PATCH /machines/$ID -d '{"alerts":true}' >/dev/null
( cd "$WORK/m1" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc6.log 2>&1 ) & PIDS+=($!)
wait_for_long "[ \"\$(api GET /machines/$ID | jq -r .online)\" = true ]"

echo "9. Configuración y limpieza"
check "frpc.toml descargable sin exponer el token" 'api GET /machines/$ID/frpc.toml | grep -q PEGUE_AQUI_EL_TOKEN'
check "agregar servicio" '[ "$(api POST /machines/$ID/services -o /dev/null -w "%{http_code}" -d "{\"name\":\"api\",\"type\":\"http\",\"localPort\":3000}")" = "201" ]'
check "eliminar servicio" '[ "$(api DELETE /machines/$ID/services/api | jq -r .deleted)" = "api" ]'
check "eliminar máquina" '[ "$(api DELETE /machines/$ID | jq -r .deleted)" = "$ID" ]'
check "máquina eliminada ya no recibe tráfico" 'http_blocked'
check "máquina eliminada es expulsada de frps" 'wait_for_long "[ \"\$(curl -s -u admin:$FRPS_API_PASSWORD http://127.0.0.1:7500/api/clients | jq length)\" = 0 ]"'

echo "10. Servidor frps caído"
: > "$WORK/hooks.log"
kill $FRPS_PID 2>/dev/null
check "frps sin respuesta → alerta server_down" 'wait_for_long "grep -q server_down \"$WORK/hooks.log\""'

echo
echo "Resultado: $PASS correctas, $FAIL fallidas"
if [ $FAIL -gt 0 ]; then echo "--- api.log ---"; tail -20 "$WORK/api.log"; echo "--- frps.log ---"; tail -20 "$WORK/frps.log"; exit 1; fi
