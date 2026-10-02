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
export ANTHROPIC_BASE_URL=http://127.0.0.1:19900 TELEGRAM_API_BASE=http://127.0.0.1:19800

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

# Simuladores de la API de Claude y de Telegram, y API de una "máquina" que registra lo que recibe
node "$ROOT/test/mock-claude.js" 19900 "$WORK/claude.log" & PIDS+=($!)
node "$ROOT/test/mock-telegram.js" 19800 & PIDS+=($!)
cat > "$WORK/machine_api.py" <<'PY'
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers.get('content-length') or 0)).decode()
        open(sys.argv[2], 'a').write(json.dumps({'path': self.path, 'auth': self.headers.get('authorization'), 'body': b}) + '\n')
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
touch "$WORK/machine.log"
python3 "$WORK/machine_api.py" 19700 "$WORK/machine.log" & PIDS+=($!)

# sshd de la "máquina" (solo si hay sshd y se ejecuta como root)
SSHD=0
if [ "$(id -u)" = 0 ] && [ -x /usr/sbin/sshd ] && command -v ssh >/dev/null; then
  mkdir -p /run/sshd
  ssh-keygen -q -t ed25519 -N '' -f "$WORK/hostkey"
  touch "$WORK/authorized_keys"; chmod 600 "$WORK/authorized_keys"
  /usr/sbin/sshd -D -p 18022 -h "$WORK/hostkey" -o AuthorizedKeysFile="$WORK/authorized_keys" -o StrictModes=no \
    -o ListenAddress=127.0.0.1 -o PidFile="$WORK/sshd.pid" -E "$WORK/sshd.log" & PIDS+=($!)
  SSHD=1
fi

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
check "incluye el archivo de accesos con ruta absoluta" 'grep -q "^includes = \[./etc/iit-frpc/accesos-$ID.toml.\]" "$WORK/inst.toml"'
# /etc/iit-frpc no existe en este equipo: se apunta el include a una carpeta que sí existe para validar
sed -i "s|/etc/iit-frpc/|$WORK/|" "$WORK/inst.toml"
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
( cd "$WORK/m1" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc6.log 2>&1 ) & FRPC6=$!; PIDS+=($FRPC6)
wait_for_long "[ \"\$(api GET /machines/$ID | jq -r .online)\" = true ]"

echo "9. IA (Claude API simulada)"
TG=http://127.0.0.1:19800
say() { jq -n --arg t "$2" '{text:$t}' | api POST "/ai/conversations/$1/messages" --data @- ; }
tool() { jq -nc --arg n "$1" --argjson i "$2" '"@tool " + $n + " " + ($i|tojson)' | jq -r .; }
check "sin configurar, el chat responde 409" '[ "$(api POST /ai/conversations/general/messages -o /dev/null -w "%{http_code}" -d "{\"text\":\"hola\"}")" = "409" ]'
check "clave de API inválida → 400" '[ "$(api PUT /ai/settings -o /dev/null -w "%{http_code}" -d "{\"apiKey\":\"abc\"}")" = "400" ]'
api PUT /ai/settings -d '{"enabled":true,"apiKey":"sk-ant-api03-PRUEBA-0123456789abcdefghij","analyzeAlerts":true}' >/dev/null
check "la clave se devuelve enmascarada" '[ "$(api GET /ai/settings | jq -r .apiKeyMasked)" = "sk-ant-…ghij" ]'

# servicios para la IA: ssh y una API de la máquina; nueva configuración de frpc con el token vigente
api POST /machines/$ID/services -d '{"name":"ssh","type":"tcp","localPort":18022}' >/dev/null
api POST /machines/$ID/services -d '{"name":"api","type":"tcp","localPort":19700}' >/dev/null
api POST /machines/$ID/installer -d "{\"platform\":\"toml\",\"token\":\"$NEW\"}" > "$WORK/m1/frpc.toml"
kill $FRPC6 2>/dev/null; sleep 0.5
( cd "$WORK/m1" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc7.log 2>&1 ) & FRPC7=$!; PIDS+=($FRPC7)
wait_for "[ \"\$(api GET /machines/$ID | jq \"[.services[]|select(.status==\\\"online\\\")]|length\")\" -ge 5 ]"
api GET /ai/ssh-key | jq -r .publicKey > "$WORK/authorized_keys"
check "el hub genera su clave SSH" 'grep -q "^ssh-ed25519 " "$WORK/authorized_keys"'

check "alcance: servicio inexistente → 400" '[ "$(api PUT /machines/$ID/ai-scope -o /dev/null -w "%{http_code}" -d "{\"enabled\":true,\"http\":[{\"id\":\"x\",\"service\":\"nada\",\"path\":\"/\"}]}")" = "400" ]'
check "alcance: comandos sin SSH → 400" '[ "$(api PUT /machines/$ID/ai-scope -o /dev/null -w "%{http_code}" -d "{\"enabled\":true,\"commands\":[{\"id\":\"u\",\"command\":\"uptime\"}]}")" = "400" ]'
jq -n --arg u "$(whoami)" --arg f "$WORK/ssh-accion" '{enabled:true, context:"Equipo de pruebas", ssh:{service:"ssh",user:$u},
  http:[{id:"inicio",service:"web",method:"GET",path:"/",mode:"read"},
        {id:"encender",service:"api",method:"POST",path:"/luz",headers:{"Authorization":"Bearer SECRETO-123"},body:"{\"entity_id\":\"{entidad}\"}",mode:"read"}],
  commands:[{id:"uptime",command:"uptime",mode:"read"},{id:"marcar",command:("touch " + $f),mode:"action"}]}' > "$WORK/scope.json"
api PUT /machines/$ID/ai-scope --data @"$WORK/scope.json" > "$WORK/scope.out"
check "un POST declarado lectura queda como acción" '[ "$(jq -r ".http[1].mode" "$WORK/scope.out")" = "action" ]'
check "las cabeceras secretas se devuelven enmascaradas" '[ "$(jq -r ".http[1].headers.Authorization" "$WORK/scope.out")" = "********" ]'

check "chat general usa listar_maquinas" 'say general "$(tool listar_maquinas "{}")" | jq -r .reply | grep -q "$ID"'
check "lectura HTTP por el túnel" 'say m-$ID "$(tool consultar_http "{\"maquina_id\":\"$ID\",\"consulta_id\":\"inicio\",\"motivo\":\"ver\"}")" | jq -r .reply | grep -q "hola-desde-la-maquina"'
say m-$ID "$(tool consultar_http "{\"maquina_id\":\"$ID\",\"consulta_id\":\"encender\",\"parametros\":{\"entidad\":\"light.sala\"},\"motivo\":\"prueba\"}")" > "$WORK/r.json"
AID=$(jq -r '.actions[-1].id' "$WORK/r.json")
check "una acción queda pendiente y NO se ejecuta" '[ "$(jq -r ".actions[-1].status" "$WORK/r.json")" = "pendiente" ] && [ ! -s "$WORK/machine.log" ]'
check "parámetro con inyección rechazado" 'say m-$ID "$(tool consultar_http "{\"maquina_id\":\"$ID\",\"consulta_id\":\"encender\",\"parametros\":{\"entidad\":\"x\\\"; rm -rf /\"},\"motivo\":\"x\"}")" | jq -r .reply | grep -q "ERROR el parámetro"'
check "chat de máquina no opera sobre otra" 'say m-$ID "$(tool estado_maquina "{\"maquina_id\":\"otra\"}")" | jq -r .reply | grep -q "solo puede operar"'
check "comando fuera del alcance rechazado" 'say m-$ID "$(tool ejecutar_comando "{\"maquina_id\":\"$ID\",\"comando_id\":\"rm\",\"motivo\":\"x\"}")" | jq -r .reply | grep -q "no está en el alcance"'
check "aprobar ejecuta la acción en la máquina" '[ "$(api POST /ai/actions/$AID/approve | jq -r .action.status)" = "ejecutada" ] && grep -q "light.sala" "$WORK/machine.log"'
check "la máquina recibió la cabecera secreta" 'grep -q "Bearer SECRETO-123" "$WORK/machine.log"'
check "el secreto nunca llegó a Claude" '! grep -q "SECRETO-123" "$WORK/claude.log"'
check "doble aprobación → 409" '[ "$(api POST /ai/actions/$AID/approve -o /dev/null -w "%{http_code}")" = "409" ]'
check "la IA recibe el resultado aprobado" 'api GET /ai/conversations/m-$ID | jq -r ".messages[-1].text" | grep -q "ENTENDIDO"'
say m-$ID "$(tool consultar_http "{\"maquina_id\":\"$ID\",\"consulta_id\":\"encender\",\"parametros\":{\"entidad\":\"light.patio\"},\"motivo\":\"prueba\"}")" > "$WORK/r.json"
RID=$(jq -r '.actions[-1].id' "$WORK/r.json")
check "rechazar no ejecuta" '[ "$(api POST /ai/actions/$RID/reject | jq -r .action.status)" = "rechazada" ] && ! grep -q "light.patio" "$WORK/machine.log"'
if [ $SSHD = 1 ]; then
  check "SSH de lectura por el túnel" 'say m-$ID "$(tool ejecutar_comando "{\"maquina_id\":\"$ID\",\"comando_id\":\"uptime\",\"motivo\":\"carga\"}")" | jq -r .reply | grep -q "load average"'
  say m-$ID "$(tool ejecutar_comando "{\"maquina_id\":\"$ID\",\"comando_id\":\"marcar\",\"motivo\":\"prueba\"}")" > "$WORK/r.json"
  SID=$(jq -r '.actions[-1].id' "$WORK/r.json")
  check "acción SSH pendiente no se ejecuta" '[ ! -e "$WORK/ssh-accion" ]'
  check "acción SSH aprobada se ejecuta" '[ "$(api POST /ai/actions/$SID/approve | jq -r .action.status)" = "ejecutada" ] && [ -e "$WORK/ssh-accion" ]'
else
  echo "  - (pruebas SSH omitidas: requieren sshd y root)"
fi
api PUT /machines/$ID/ai-scope -d '{"enabled":false}' >/dev/null
check "alcance desactivado bloquea consultas" 'say m-$ID "$(tool consultar_http "{\"maquina_id\":\"$ID\",\"consulta_id\":\"inicio\",\"motivo\":\"ver\"}")" | jq -r .reply | grep -q "no está habilitada"'
check "las peticiones a Claude fueron válidas (sin 400)" '! grep -q "\"error\"" "$WORK/claude.log"'

# diagnóstico automático de alertas
: > "$WORK/hooks.log"
kill $FRPC7 2>/dev/null
check "caída → alerta + diagnóstico de la IA" 'wait_for_long "grep -q ai_analysis \"$WORK/hooks.log\""'
( cd "$WORK/m1" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc8.log 2>&1 ) & PIDS+=($!)
wait_for_long "[ \"\$(api GET /machines/$ID | jq -r .online)\" = true ]"

# bot de Telegram (simulado)
api PUT /alerts/settings -d '{"telegram":{"botToken":"123456789:AAEhBOweik6ad6PsVkwxyz0123456789ABCD","chatId":"4242"}}' >/dev/null
api PUT /ai/settings -d '{"telegramBot":true}' >/dev/null
tg_sent() { curl -s $TG/__sent | jq -r '.[] | select(.method=="sendMessage") | .text'; }
curl -s -X POST $TG/__push -d '{"message":{"message_id":1,"chat":{"id":4242},"text":"/estado"}}' >/dev/null
check "Telegram /estado responde" 'wait_for_long "tg_sent | grep -q \"en línea\""'
N=$(curl -s $TG/__sent | jq length)
curl -s -X POST $TG/__push -d '{"message":{"message_id":2,"chat":{"id":999},"text":"hola"}}' >/dev/null
sleep 3
check "Telegram ignora chats no autorizados" '[ "$(curl -s $TG/__sent | jq length)" = "$N" ] && api GET "/events?limit=40" | jq -r ".[].kind" | grep -q telegram_no_autorizado'
T=$(tool consultar_http "{\"maquina_id\":\"$ID\",\"consulta_id\":\"encender\",\"parametros\":{\"entidad\":\"light.tg\"},\"motivo\":\"tg\"}")
api PUT /machines/$ID/ai-scope --data @"$WORK/scope.json" >/dev/null
jq -n --arg t "$T" '{message:{message_id:3,chat:{id:4242},text:$t}}' | curl -s -X POST $TG/__push --data @- >/dev/null
check "Telegram envía botones para aprobar" 'wait_for_long "curl -s $TG/__sent | jq -e \".[] | select(.reply_markup.inline_keyboard[0][0].callback_data? // \\\"\\\" | startswith(\\\"ap:\\\"))\" >/dev/null"'
TID=$(curl -s $TG/__sent | jq -r '[.[] | .reply_markup.inline_keyboard[0][0].callback_data? // empty][-1]' | cut -d: -f2)
curl -s -X POST $TG/__push -d "{\"callback_query\":{\"id\":\"cb1\",\"data\":\"ap:$TID\",\"message\":{\"message_id\":9,\"chat\":{\"id\":4242}}}}" >/dev/null
check "aprobar desde Telegram ejecuta la acción" 'wait_for_long "grep -q light.tg \"$WORK/machine.log\""'
api PUT /ai/settings -d '{"telegramBot":false}' >/dev/null

echo "10. Servicios privados (stcp): SSH/RDP sin puerto público"
# Base con el esquema anterior (sin stcp): la migración conserva los datos y admite el tipo nuevo
cat > "$WORK/migra.js" <<'JS'
const { DatabaseSync } = require('node:sqlite');
const old = new DatabaseSync(process.argv[2]);
old.exec(`CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login_at INTEGER,
  last_client_address TEXT, last_hostname TEXT, last_os TEXT, last_arch TEXT, last_version TEXT);
CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('http','https','tcp')), local_ip TEXT NOT NULL DEFAULT '127.0.0.1', local_port INTEGER NOT NULL,
  subdomain TEXT UNIQUE, remote_port INTEGER UNIQUE, tls_mode TEXT, created_at INTEGER NOT NULL, UNIQUE (machine_id, name));
INSERT INTO machines (id, name, token_hash, created_at, updated_at) VALUES ('vieja', 'Vieja', 'x', 1, 1);
INSERT INTO services (machine_id, name, type, local_port, subdomain, created_at) VALUES ('vieja', 'web', 'http', 80, 'web-vieja', 1);`);
old.close();
const s = require(process.argv[3]).open(process.argv[2]);
s.createService('vieja', { name: 'ssh', type: 'stcp', localIp: '127.0.0.1', localPort: 22, secret: 'k' });
const svcs = s.servicesOf('vieja');
if (svcs.length !== 2 || svcs.find((x) => x.name === 'web').subdomain !== 'web-vieja') throw new Error('servicios perdidos');
s.createAccess(svcs.find((x) => x.type === 'stcp').id, 'vieja', 6022);
s.deleteMachine('vieja');
if (s.listAccess().length) throw new Error('accesos huérfanos');
require(process.argv[3]).open(process.argv[2]); // segunda apertura: la migración no se repite
JS
node --disable-warning=ExperimentalWarning "$WORK/migra.js" "$WORK/vieja.db" "$ROOT/api/src/db.js" 2>"$WORK/migra.log"; MIG=$?
check "migración de una base anterior conserva los servicios y admite stcp" '[ $MIG = 0 ] || { cat "$WORK/migra.log"; false; }'
frps_ports() { lsof -nP -a -p "$FRPS_PID" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sort -u | paste -sd' '; }
PORTS_BEFORE=$(frps_ports)

api POST /machines -d '{"name":"Servidor privado","services":[{"name":"ssh","type":"stcp","localPort":18999}]}' > "$WORK/own.json"
OWN=$(jq -r .machine.id "$WORK/own.json")
check "servicio privado sin dirección pública" '[ "$(jq -r ".machine.services[0].publicUrl" "$WORK/own.json")" = "null" ] && [ "$(jq -r ".machine.services[0].private" "$WORK/own.json")" = "true" ]'
check "el frpc.toml del dueño no lleva la clave" '! jq -r .frpcToml "$WORK/own.json" | grep -qi secretkey'
mkdir -p "$WORK/own" "$WORK/vis" "$WORK/int"
jq -r .frpcToml "$WORK/own.json" > "$WORK/own/frpc.toml"
( cd "$WORK/own" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc.log 2>&1 ) & OWNPID=$!; PIDS+=($OWNPID)

api POST /machines -d '{"name":"Puesto tecnico"}' > "$WORK/vis.json"
VIS=$(jq -r .machine.id "$WORK/vis.json")
jq -r .frpcToml "$WORK/vis.json" > "$WORK/vis/frpc.toml"
( cd "$WORK/vis" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc.log 2>&1 ) & VISPID=$!; PIDS+=($VISPID)
check "frpc arranca aunque aún no exista el archivo de accesos" 'wait_for "[ \"\$(api GET /machines/$VIS | jq -r .online)\" = true ]"'
check "el servicio privado queda activo en frps" 'wait_for "[ \"\$(api GET /machines/$OWN | jq -r .services[0].status)\" = online ]"'

check "acceso a la misma máquina → 400" '[ "$(api POST /access -o /dev/null -w "%{http_code}" -d "{\"machine\":\"$OWN\",\"service\":\"ssh\",\"visitor\":\"$OWN\"}")" = "400" ]'
check "acceso a un servicio no privado → 400" '[ "$(api POST /access -o /dev/null -w "%{http_code}" -d "{\"machine\":\"$ID\",\"service\":\"web\",\"visitor\":\"$VIS\"}")" = "400" ]'
api POST /access -d "{\"machine\":\"$OWN\",\"service\":\"ssh\",\"visitor\":\"$VIS\"}" > "$WORK/acc.json"
ACC=$(jq -r .id "$WORK/acc.json"); BP=$(jq -r .bindPort "$WORK/acc.json")
check "acceso otorgado con puerto local sugerido" '[ "$BP" = "6100" ]'
check "acceso duplicado → 409" '[ "$(api POST /access -o /dev/null -w "%{http_code}" -d "{\"machine\":\"$OWN\",\"service\":\"ssh\",\"visitor\":\"$VIS\"}")" = "409" ]'
check "el panel muestra quién tiene acceso y a qué" '[ "$(api GET /machines/$OWN | jq -r ".services[0].access[0].visitor")" = "$VIS" ] && [ "$(api GET /machines/$VIS | jq -r ".visits[0].bindPort")" = "6100" ]'

api GET /machines/$VIS/accesos.toml > "$WORK/vis/accesos-$VIS.toml"
check "archivo de accesos válido con la clave" 'grep -q "^secretKey = " "$WORK/vis/accesos-$VIS.toml" && "$FRP_DIR/frpc" verify -c "$WORK/vis/frpc.toml" >/dev/null'
kill $VISPID 2>/dev/null; sleep 0.5
( cd "$WORK/vis" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc2.log 2>&1 ) & VISPID=$!; PIDS+=($VISPID)
through() { curl -s -m 3 "http://127.0.0.1:$1/"; }
check "el dueño se reconecta solo para aplicar el acceso" 'wait_for_long "api GET \"/events?machine=$OWN\" | jq -r \".[].kind\" | grep -q reconexion"'
check "el visitante autorizado llega al servicio privado" 'wait_for_long "[ \"\$(through 6100)\" = hola-desde-la-maquina ]"'
check "frps no abrió ningún puerto nuevo para el servicio privado" '[ -n "$PORTS_BEFORE" ] && [ "$(frps_ports)" = "$PORTS_BEFORE" ]'

# Otra máquina registrada que consiguió la clave pero no tiene acceso
api POST /machines -d '{"name":"Intruso"}' > "$WORK/int.json"
INT=$(jq -r .machine.id "$WORK/int.json")
jq -r .frpcToml "$WORK/int.json" > "$WORK/int/frpc.toml"
sed "s/^bindPort = .*/bindPort = 6200/" "$WORK/vis/accesos-$VIS.toml" > "$WORK/int/accesos-$INT.toml"
( cd "$WORK/int" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc.log 2>&1 ) & INTPID=$!; PIDS+=($INTPID)
wait_for "grep -q \"start visitor success\" $WORK/int/frpc.log"
check "una máquina sin acceso no entra aunque tenga la clave" 'sleep 1; [ "$(through 6200)" != hola-desde-la-maquina ]'
kill $INTPID 2>/dev/null

api GET /machines/$VIS/accesos/linux > "$WORK/accesos.sh"
check "script de accesos Linux con sintaxis válida" 'bash -n "$WORK/accesos.sh" && grep -q "bindPort = 6100" "$WORK/accesos.sh"'
check "script de accesos Windows con BOM" '[ "$(api GET /machines/$VIS/accesos/windows | head -c 3 | od -An -tx1 | tr -d " ")" = "efbbbf" ]'
check "archivo .rdp apunta al puerto local" 'api GET "/access/$ACC/rdp?user=admin" | grep -q "full address:s:127.0.0.1:6100"'
VTOKEN=$(jq -r .token "$WORK/vis.json")
api POST /machines/$VIS/installer -d "{\"platform\":\"linux\",\"token\":\"$VTOKEN\"}" > "$WORK/vis-inst.sh"
check "el instalador del visitante trae sus accesos" 'bash -n "$WORK/vis-inst.sh" && grep -q "IIT_ACCESOS" "$WORK/vis-inst.sh" && grep -q "serverUser = \"$OWN\"" "$WORK/vis-inst.sh"'

api POST /machines/$OWN/services/ssh/rotate-secret >/dev/null
check "rotar la clave corta el acceso con el archivo viejo" 'wait_for_long "[ \"\$(through 6100)\" != hola-desde-la-maquina ]"'
api GET /machines/$VIS/accesos.toml > "$WORK/vis/accesos-$VIS.toml"
kill $VISPID 2>/dev/null; sleep 0.5
( cd "$WORK/vis" && exec "$FRP_DIR/frpc" -c frpc.toml > frpc3.log 2>&1 ) & VISPID=$!; PIDS+=($VISPID)
check "con el archivo nuevo vuelve a entrar" 'wait_for_long "[ \"\$(through 6100)\" = hola-desde-la-maquina ]"'

api DELETE /access/$ACC >/dev/null
check "revocar el acceso lo corta" 'wait_for_long "[ \"\$(through 6100)\" != hola-desde-la-maquina ]"'
check "eventos de acceso registrados" '[ "$(api GET "/events?machine=$OWN" | jq "[.[]|select(.kind|test(\"acceso_|clave_rotada\"))]|length")" -ge 3 ]'

kill $OWNPID $VISPID 2>/dev/null
for m in $OWN $VIS $INT; do api DELETE /machines/$m >/dev/null; done
check "eliminar máquinas borra sus accesos" '[ "$(api GET /access | jq length)" = 0 ]'

echo "11. Usuarios, roles y clientes"
# sapi <usuario> <método> <ruta> [curl args]: petición con la cookie de sesión de ese usuario
sapi() { local jar="$WORK/$1.jar" m="$2" p="$3"; shift 3; curl -s -b "$jar" -c "$jar" -X "$m" -H "Content-Type: application/json" -H "X-Requested-With: iit-panel" "$API$p" "$@"; }
scode() { local jar="$WORK/$1.jar" m="$2" p="$3"; shift 3; curl -s -o /dev/null -w "%{http_code}" -b "$jar" -c "$jar" -X "$m" -H "Content-Type: application/json" -H "X-Requested-With: iit-panel" "$API$p" "$@"; }
login() { jq -n --arg u "$2" --arg p "$3" --arg c "${4:-}" '{username:$u,password:$p} + (if $c != "" then {code:$c} else {} end)' | sapi "$1" POST /auth/login --data @-; }
totp() { node -e "console.log(require('$ROOT/api/src/auth.js').totpCode(process.argv[1], Date.now() + Number(process.argv[2] || 0)))" "$1" "${2:-0}"; }

api POST /machines -d '{"name":"Recepcion","client":"Hotel Sur"}' > "$WORK/hotel.json"
HOT=$(jq -r .machine.id "$WORK/hotel.json")
check "el cliente nuevo se crea al registrar la máquina" '[ "$(api GET /clients | jq -r ".[] | select(.name==\"Hotel Sur\") | .machines")" = 1 ]'
check "las máquinas existentes quedaron enlazadas a su cliente" '[ "$(api GET /machines/$ID | jq -r .clientId)" = "clinica-norte" ]'

check "sin usuarios, el panel pide crear el administrador" '[ "$(curl -s $API/auth/state | jq -r .needsSetup)" = true ]'
check "crear administrador con token incorrecto → 403" '[ "$(scode admin POST /auth/setup -d "{\"adminToken\":\"malo\",\"username\":\"jairo\",\"password\":\"clave-admin-segura-1\"}")" = 403 ]'
check "primer administrador creado con el ADMIN_TOKEN" '[ "$(sapi admin POST /auth/setup -d "{\"adminToken\":\"$ADMIN_TOKEN\",\"username\":\"jairo\",\"name\":\"Jairo\",\"password\":\"clave-admin-segura-1\"}" | jq -r .user.role)" = admin ]'
check "no se puede repetir la creación inicial" '[ "$(scode otro POST /auth/setup -d "{\"adminToken\":\"$ADMIN_TOKEN\",\"username\":\"x\",\"password\":\"clave-admin-segura-1\"}")" = 409 ]'
check "la cookie de sesión es HttpOnly y SameSite=Strict" 'curl -s -i -X POST -H "Content-Type: application/json" $API/auth/login -d "{\"username\":\"jairo\",\"password\":\"clave-admin-segura-1\"}" | grep -i "^set-cookie" | grep -qi "httponly.*samesite=strict"'
check "con sesión, cambios sin X-Requested-With → 403 (CSRF)" '[ "$(curl -s -o /dev/null -w "%{http_code}" -b "$WORK/admin.jar" -X POST -H "Content-Type: application/json" $API/clients -d "{\"name\":\"X\"}")" = 403 ]'

sapi admin POST /users -d '{"username":"tec1","name":"Técnico Uno","role":"tecnico","clients":["clinica-norte"]}' > "$WORK/tec.json"
TECPW=$(jq -r .tempPassword "$WORK/tec.json")
check "técnico creado con contraseña temporal" '[ ${#TECPW} -ge 14 ]'
check "contraseña corta rechazada" '[ "$(scode admin POST /users -d "{\"username\":\"corta\",\"role\":\"admin\",\"password\":\"123\"}")" = 400 ]'
sapi admin POST /users -d '{"username":"hotel","name":"Gerencia Hotel","role":"cliente","client":"hotel-sur","password":"clave-hotel-inicial"}' >/dev/null

check "primer ingreso del técnico exige cambiar la contraseña" '[ "$(login tec1 tec1 "$TECPW" | jq -r .user.mustChangePassword)" = true ] && [ "$(scode tec1 GET /machines)" = 403 ]'
sapi tec1 POST /auth/password -d "{\"current\":\"$TECPW\",\"password\":\"clave-tecnico-nueva-1\"}" >/dev/null
check "tras cambiarla, el técnico entra" '[ "$(scode tec1 GET /machines)" = 200 ]'
check "el técnico solo ve las máquinas de sus clientes" '[ "$(sapi tec1 GET /machines | jq -r "[.[].id] | join(\",\")")" = "$ID" ]'
check "máquina de otro cliente → 404 (no sabe que existe)" '[ "$(scode tec1 GET /machines/$HOT)" = 404 ] && [ "$(scode tec1 PATCH /machines/$HOT -d "{\"enabled\":false}")" = 404 ]'
check "el técnico no administra alertas, IA ni usuarios" '[ "$(scode tec1 GET /alerts/settings)" = 403 ] && [ "$(scode tec1 GET /ai/settings)" = 403 ] && [ "$(scode tec1 GET /users)" = 403 ]'
check "el técnico no registra máquinas en clientes ajenos" '[ "$(scode tec1 POST /machines -d "{\"name\":\"x\",\"client\":\"Hotel Sur\"}")" = 403 ] && [ "$(scode tec1 POST /machines -d "{\"name\":\"x\"}")" = 400 ]'
sapi tec1 POST /machines -d '{"name":"Camaras","client":"Clínica Norte"}' > "$WORK/tecm.json"
TM=$(jq -r .machine.id "$WORK/tecm.json")
check "el técnico registra en su cliente y queda auditado" '[ "$(api GET "/events?machine=$TM" | jq -r ".[] | select(.kind==\"registrada\") | .actor")" = tec1 ]'
check "el técnico solo ve eventos de sus máquinas" '[ "$(sapi tec1 GET "/events?limit=200" | jq "[.[] | select(.machine_id != \"$ID\" and .machine_id != \"$TM\")] | length")" = 0 ]'

# IA: el chat general del técnico solo ve sus máquinas; las aprobaciones quedan a su nombre
api PUT /machines/$ID/ai-scope --data @"$WORK/scope.json" >/dev/null
tsay() { jq -n --arg t "$3" '{text:$t}' | sapi "$1" POST "/ai/conversations/$2/messages" --data @- ; }
tsay tec1 general "$(tool listar_maquinas "{}")" > "$WORK/tai.json"
check "la IA del técnico no lista máquinas de otros clientes" 'jq -r .reply "$WORK/tai.json" | grep -q "$ID" && ! jq -r .reply "$WORK/tai.json" | grep -q "$HOT"'
check "la IA del técnico no consulta máquinas de otros clientes" 'tsay tec1 general "$(tool estado_maquina "{\"maquina_id\":\"$HOT\"}")" | jq -r .reply | grep -q "no existe la máquina"'
tsay tec1 m-$ID "$(tool consultar_http "{\"maquina_id\":\"$ID\",\"consulta_id\":\"encender\",\"parametros\":{\"entidad\":\"light.tec\"},\"motivo\":\"rol\"}")" > "$WORK/tr.json"
TAID=$(jq -r '.actions[-1].id' "$WORK/tr.json")
check "la aprobación queda a nombre del técnico" '[ "$(sapi tec1 POST /ai/actions/$TAID/approve | jq -r .action.decided_by)" = tec1 ] && grep -q light.tec "$WORK/machine.log"'

check "el cliente entra y ve solo sus equipos" '[ "$(login hotel hotel clave-hotel-inicial | jq -r .user.role)" = cliente ] && sapi hotel POST /auth/password -d "{\"current\":\"clave-hotel-inicial\",\"password\":\"clave-hotel-nueva-1\"}" >/dev/null && [ "$(sapi hotel GET /machines | jq -r "[.[].id] | join(\",\")")" = "$HOT" ]'
check "el cliente no ve datos internos (IA, accesos)" '[ "$(sapi hotel GET /machines/$HOT | jq "has(\"ai\")")" = false ] && [ "$(sapi hotel GET /summary | jq "has(\"ai\")")" = false ]'
check "el cliente es solo lectura" '[ "$(scode hotel PATCH /machines/$HOT -d "{\"enabled\":false}")" = 403 ] && [ "$(scode hotel POST /machines -d "{\"name\":\"y\",\"client\":\"Hotel Sur\"}")" = 403 ] && [ "$(scode hotel GET /ai/actions)" = 403 ]'
check "el cliente no ve máquinas de otros clientes" '[ "$(scode hotel GET /machines/$ID)" = 404 ]'

SECRET=$(sapi tec1 POST /auth/totp/setup | jq -r .secret)
check "activar 2FA exige un código válido" '[ "$(scode tec1 POST /auth/totp/enable -d "{\"code\":\"000000\"}")" = 400 ] && [ "$(sapi tec1 POST /auth/totp/enable -d "{\"code\":\"$(totp $SECRET)\"}" | jq -r .user.totp)" = true ]'
cp "$WORK/tec1.jar" "$WORK/vieja.jar"
sapi tec1 POST /auth/logout >/dev/null
check "cerrar sesión invalida la cookie" '[ "$(scode vieja GET /machines)" = 401 ]'
check "con 2FA, la contraseña sola no basta" '[ "$(login tec1 tec1 clave-tecnico-nueva-1 | jq -r .needCode)" = true ] && [ "$(scode tec1 GET /machines)" = 401 ]'
check "con contraseña y código, entra" '[ "$(login tec1 tec1 clave-tecnico-nueva-1 "$(totp $SECRET 30000)" | jq -r .user.username)" = tec1 ]'
check "un código ya usado no se acepta otra vez" '[ "$(login t2 tec1 clave-tecnico-nueva-1 "$(totp $SECRET 30000)" | jq -r .error)" != null ]'

for i in 1 2 3 4 5; do login h2 hotel malamala-clave >/dev/null; done
check "5 intentos fallidos bloquean el usuario" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" $API/auth/login -d "{\"username\":\"hotel\",\"password\":\"clave-hotel-nueva-1\"}")" = 423 ]'
HID=$(sapi admin GET /users | jq -r '.[] | select(.username=="hotel") | .id')
sapi admin PATCH /users/$HID -d '{"enabled":true}' >/dev/null
check "el administrador desbloquea" '[ "$(login h3 hotel clave-hotel-nueva-1 | jq -r .user.username)" = hotel ]'
check "eventos de seguridad con su autor" '[ "$(api GET "/events?limit=200" | jq "[.[] | select(.kind==\"login_fallido\" and .actor==\"hotel\")] | length")" -ge 5 ]'

JID=$(sapi admin GET /users | jq -r '.[] | select(.username=="jairo") | .id')
check "el único administrador no puede quitarse el rol" '[ "$(scode admin PATCH /users/$JID -d "{\"role\":\"tecnico\",\"clients\":[]}")" = 400 ]'
check "no se elimina un cliente con máquinas" '[ "$(scode admin DELETE /clients/hotel-sur)" = 409 ]'
sapi admin PATCH /clients/hotel-sur -d '{"name":"Hotel Sur Plaza"}' >/dev/null
check "renombrar el cliente actualiza sus máquinas" '[ "$(api GET /machines/$HOT | jq -r .client)" = "Hotel Sur Plaza" ]'
TID=$(sapi admin GET /users | jq -r '.[] | select(.username=="tec1") | .id')
sapi admin PATCH /users/$TID -d '{"enabled":false}' >/dev/null
check "deshabilitar un usuario cierra su sesión" '[ "$(scode tec1 GET /machines)" = 401 ]'
for m in $HOT $TM; do api DELETE /machines/$m >/dev/null; done

echo "12. Configuración y limpieza"
check "frpc.toml descargable sin exponer el token" 'api GET /machines/$ID/frpc.toml | grep -q PEGUE_AQUI_EL_TOKEN'
check "agregar servicio" '[ "$(api POST /machines/$ID/services -o /dev/null -w "%{http_code}" -d "{\"name\":\"extra\",\"type\":\"http\",\"localPort\":3000}")" = "201" ]'
check "eliminar servicio" '[ "$(api DELETE /machines/$ID/services/extra | jq -r .deleted)" = "extra" ]'
check "eliminar máquina" '[ "$(api DELETE /machines/$ID | jq -r .deleted)" = "$ID" ]'
check "máquina eliminada ya no recibe tráfico" 'http_blocked'
check "máquina eliminada es expulsada de frps" 'wait_for_long "[ \"\$(curl -s -u admin:$FRPS_API_PASSWORD http://127.0.0.1:7500/api/clients | jq length)\" = 0 ]"'

echo "13. Servidor frps caído"
: > "$WORK/hooks.log"
kill $FRPS_PID 2>/dev/null
check "frps sin respuesta → alerta server_down" 'wait_for_long "grep -q server_down \"$WORK/hooks.log\""'

echo
echo "Resultado: $PASS correctas, $FAIL fallidas"
if [ $FAIL -gt 0 ]; then echo "--- api.log ---"; tail -20 "$WORK/api.log"; echo "--- frps.log ---"; tail -20 "$WORK/frps.log"; exit 1; fi
