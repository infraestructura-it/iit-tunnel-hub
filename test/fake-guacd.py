# guacd simulado para test/e2e.sh: hace el saludo de Guacamole como guacd, guarda los parámetros
# de "connect" (JSON en argv[2]) y después devuelve cada instrucción que recibe.
import json, socket, sys, threading

ARGS = ['VERSION_1_5_0', 'hostname', 'port', 'domain', 'username', 'password', 'security', 'ignore-cert', 'server-layout', 'resize-method', 'enable-drive']

def enc(*els):
    return ','.join(f'{len(str(e))}.{e}' for e in els) + ';'

def parse(buf):
    """Devuelve (instrucciones [[opcode, args...]], crudas [texto], resto). Largos en puntos de código."""
    out, raw, i = [], [], 0
    while True:
        start, els, j = i, [], i
        while True:
            dot = buf.find('.', j)
            if dot == -1: return out, raw, buf[start:]
            n = int(buf[j:dot]); end = dot + 1 + n
            if end >= len(buf): return out, raw, buf[start:]
            els.append(buf[dot + 1:end])
            if buf[end] == ';':
                out.append(els); raw.append(buf[start:end + 1]); i = end + 1; break
            j = end + 1

def handle(c, logfile):
    buf, stage = '', 'select'
    dec = __import__('codecs').getincrementaldecoder('utf-8')()
    while True:
        d = c.recv(65536)
        if not d: break
        buf += dec.decode(d)
        ins, raw, buf = parse(buf)
        for el, r in zip(ins, raw):
            if stage == 'select' and el[0] == 'select':
                if el[1:] != ['rdp']:
                    c.sendall(enc('error', 'protocolo no soportado', '768').encode()); return c.close()
                c.sendall(enc('args', *ARGS).encode()); stage = 'connect'
            elif stage == 'connect' and el[0] == 'connect':
                json.dump(dict(zip(ARGS, el[1:])), open(logfile, 'w'))
                c.sendall((enc('ready', '$falso-123') + enc('size', '0', '1024', '768')).encode()); stage = 'run'
            elif stage == 'run':
                if el[0] == 'disconnect': return c.close()
                c.sendall(r.encode())
    c.close()

s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(5)
while True:
    c, _ = s.accept(); threading.Thread(target=handle, args=(c, sys.argv[2]), daemon=True).start()
