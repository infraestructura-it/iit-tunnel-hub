#!/usr/bin/env node
'use strict';
// Herramienta de línea de comandos para los respaldos de hub.db.
//
//   node api/src/respaldo.js verificar  <respaldo>                 revisa que el respaldo sea íntegro
//   node api/src/respaldo.js descifrar  <respaldo.enc> <salida.db>  descifra con BACKUP_KEY
//   node api/src/respaldo.js restaurar  <respaldo> --hub-detenido   reemplaza hub.db (guarda la actual)
//
// La base de destino es DB_PATH (por defecto ./data/hub.db). Los .enc se descifran con la variable BACKUP_KEY.

// Silencia el aviso "SQLite is an experimental feature" de Node 22 (ruido en una herramienta de consola)
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w?.message ?? w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...a));

const fs = require('node:fs');
const path = require('node:path');
const { decrypt, inspect } = require('./backup');

const [cmd, ...args] = process.argv.slice(2);
const dbPath = path.resolve(process.env.DB_PATH || './data/hub.db');
const out = (m) => process.stdout.write(m + '\n');
const fail = (m) => { process.stderr.write(`✘ ${m}\n`); process.exit(1); };

/** Devuelve la ruta de un .db en claro (descifra a un temporal si hace falta). */
function plainCopy(file) {
  if (!fs.existsSync(file)) fail(`no existe ${file}`);
  if (!file.endsWith('.enc')) return { file, cleanup: () => {} };
  if (!process.env.BACKUP_KEY) fail('el respaldo está cifrado: defina BACKUP_KEY con la clave usada al crearlo');
  const tmp = path.join(path.dirname(path.resolve(file)), `.verificar-${process.pid}.db`);
  try { fs.writeFileSync(tmp, decrypt(fs.readFileSync(file), process.env.BACKUP_KEY), { mode: 0o600 }); }
  catch (e) { fail(e.message); }
  return { file: tmp, cleanup: () => { try { fs.unlinkSync(tmp); } catch {} } };
}

function summary(i) {
  return `${i.ok ? '✔ íntegro' : '✘ DAÑADO (' + i.check + ')'} · ${i.machines ?? '?'} máquinas · ${i.services ?? '?'} servicios · ${i.users ?? '?'} usuarios · ${i.events ?? '?'} eventos`;
}

if (cmd === 'verificar') {
  if (!args[0]) fail('uso: respaldo.js verificar <respaldo>');
  const p = plainCopy(args[0]);
  try { const i = inspect(p.file); out(summary(i)); process.exitCode = i.ok ? 0 : 1; } finally { p.cleanup(); }
} else if (cmd === 'descifrar') {
  if (!args[0] || !args[1]) fail('uso: respaldo.js descifrar <respaldo.enc> <salida.db>');
  if (!process.env.BACKUP_KEY) fail('defina BACKUP_KEY');
  if (fs.existsSync(args[1])) fail(`ya existe ${args[1]}`);
  try { fs.writeFileSync(args[1], decrypt(fs.readFileSync(args[0]), process.env.BACKUP_KEY), { mode: 0o600 }); }
  catch (e) { fail(e.message); }
  out(`✔ ${args[1]} · ${summary(inspect(args[1]))}`);
} else if (cmd === 'restaurar') {
  if (!args[0]) fail('uso: respaldo.js restaurar <respaldo> --hub-detenido');
  if (!args.includes('--hub-detenido')) {
    fail('detenga primero el hub (y frps) y confirme agregando --hub-detenido');
  }
  const p = plainCopy(args[0]);
  try {
    const i = inspect(p.file);
    if (!i.ok) fail(`el respaldo no está íntegro (${i.check}); no se restauró nada`);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    if (fs.existsSync(dbPath)) {
      const saved = `${dbPath}.antes-de-restaurar-${stamp}`;
      fs.copyFileSync(dbPath, saved);
      out(`✔ base actual guardada en ${saved}`);
    }
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch {} }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.copyFileSync(p.file, dbPath);
    out(`✔ restaurado en ${dbPath} · ${summary(i)}`);
    out('  Arranque el hub. Las sesiones del panel no se respaldan: todos deben ingresar de nuevo.');
  } finally { p.cleanup(); }
} else {
  out('Uso:');
  out('  node api/src/respaldo.js verificar  <respaldo>');
  out('  node api/src/respaldo.js descifrar  <respaldo.enc> <salida.db>   (con BACKUP_KEY)');
  out('  node api/src/respaldo.js restaurar  <respaldo> --hub-detenido    (destino: DB_PATH o ./data/hub.db)');
  process.exitCode = cmd ? 1 : 0;
}
