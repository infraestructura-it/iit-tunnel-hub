'use strict';
// Servidor SMTP mínimo para pruebas: acepta EHLO/AUTH LOGIN/MAIL/RCPT/DATA y guarda cada
// correo recibido como una línea JSON en <outFile>. Soporta STARTTLS opcional no es necesario
// para las pruebas (se usa 'none' o AUTH LOGIN sin cifrar en 127.0.0.1).
//   Uso: node mock-smtp.js <puerto> <outFile>
const net = require('node:net');
const fs = require('node:fs');

const [port, outFile] = process.argv.slice(2);

net.createServer((sock) => {
  let buf = '';
  let state = 'greet';
  const mail = { from: '', to: [], data: '' };
  let inData = false;
  const w = (s) => sock.write(s + '\r\n');
  w('220 mock-smtp listo');
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          try { fs.appendFileSync(outFile, JSON.stringify({ from: mail.from, to: mail.to, data: mail.data }) + '\n'); } catch {}
          w('250 OK mensaje aceptado');
        } else {
          mail.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
        }
        continue;
      }
      const up = line.toUpperCase();
      if (up.startsWith('EHLO') || up.startsWith('HELO')) { w('250-mock-smtp'); w('250-AUTH LOGIN PLAIN'); w('250 OK'); }
      else if (up === 'AUTH LOGIN') { w('334 VXNlcm5hbWU6'); state = 'auth-user'; }
      else if (state === 'auth-user') { state = 'auth-pass'; w('334 UGFzc3dvcmQ6'); }
      else if (state === 'auth-pass') { state = 'greet'; w('235 autenticado'); }
      else if (up.startsWith('MAIL FROM')) { mail.from = line.replace(/^MAIL FROM:\s*/i, ''); w('250 OK'); }
      else if (up.startsWith('RCPT TO')) { mail.to.push(line.replace(/^RCPT TO:\s*/i, '')); w('250 OK'); }
      else if (up === 'DATA') { inData = true; mail.data = ''; w('354 fin con <CRLF>.<CRLF>'); }
      else if (up === 'QUIT') { w('221 adios'); sock.end(); }
      else if (up === 'RSET') { w('250 OK'); }
      else { w('250 OK'); }
    }
  });
  sock.on('error', () => {});
}).listen(Number(port), '127.0.0.1');
