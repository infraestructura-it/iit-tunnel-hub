'use strict';
// Perfiles SNMP: qué leer de cada tipo de equipo, cómo mostrarlo y qué condiciones generan alertas.
//   ups      UPS-MIB estándar (RFC 1628)          ups-apc   APC PowerNet-MIB
//   network  switches y routers (IF-MIB)          printer   Printer-MIB + HOST-RESOURCES (impresoras)
//   host     servidores y NAS (HOST-RESOURCES)    generic   solo datos del sistema + OIDs propios
// Todos agregan los OIDs personalizados del equipo.

const { display } = require('./snmp');

const SYS = {
  descr: '1.3.6.1.2.1.1.1.0', objectId: '1.3.6.1.2.1.1.2.0', uptime: '1.3.6.1.2.1.1.3.0',
  contact: '1.3.6.1.2.1.1.4.0', name: '1.3.6.1.2.1.1.5.0', location: '1.3.6.1.2.1.1.6.0', services: '1.3.6.1.2.1.1.7.0',
};

const isValue = (vb) => vb && vb.value !== null && vb.value !== undefined && !['noSuchObject', 'noSuchInstance', 'endOfMibView'].includes(vb.type);
const num = (vb) => (isValue(vb) && typeof vb.value === 'number' ? vb.value : null);
const txt = (vb) => (isValue(vb) ? String(display(vb)) : null);

/** GET de muchos OIDs en grupos (los equipos limitan el tamaño de la respuesta). Devuelve { oid: varbind }. */
async function getMap(s, oids) {
  const out = {};
  for (let i = 0; i < oids.length; i += 20) {
    const part = oids.slice(i, i + 20);
    try {
      for (const vb of await s.get(part)) out[vb.oid] = vb;
    } catch (e) {
      // v1/agentes viejos: un OID inexistente hace fallar todo el grupo → se piden de a uno
      if (e.code !== 'PDU') throw e;
      for (const o of part) { try { const [vb] = await s.get([o]); out[vb.oid] = vb; } catch {} }
    }
  }
  return out;
}

/** Recorre columnas de una tabla y arma filas por índice. cols = { nombre: oidColumna } */
async function table(s, cols, max = 512) {
  const rows = new Map();
  for (const [name, base] of Object.entries(cols)) {
    let vbs = [];
    try { vbs = await s.walk(base, { max }); } catch (e) { if (e.code === 'TIMEOUT') throw e; }
    for (const vb of vbs) {
      const idx = vb.oid.slice(base.length + 1);
      if (!rows.has(idx)) rows.set(idx, { index: idx });
      rows.get(idx)[name] = vb;
    }
  }
  return [...rows.values()];
}

// ---------- UPS (UPS-MIB, RFC 1628) ----------

const UPS = {
  manufacturer: '1.3.6.1.2.1.33.1.1.1.0', model: '1.3.6.1.2.1.33.1.1.2.0', firmware: '1.3.6.1.2.1.33.1.1.3.0',
  batteryStatus: '1.3.6.1.2.1.33.1.2.1.0', secondsOnBattery: '1.3.6.1.2.1.33.1.2.2.0', minutesRemaining: '1.3.6.1.2.1.33.1.2.3.0',
  charge: '1.3.6.1.2.1.33.1.2.4.0', batteryVoltage: '1.3.6.1.2.1.33.1.2.5.0', batteryTemp: '1.3.6.1.2.1.33.1.2.7.0',
  inputFrequency: '1.3.6.1.2.1.33.1.3.3.1.2.1', inputVoltage: '1.3.6.1.2.1.33.1.3.3.1.3.1',
  outputSource: '1.3.6.1.2.1.33.1.4.1.0', outputVoltage: '1.3.6.1.2.1.33.1.4.4.1.2.1', outputLoad: '1.3.6.1.2.1.33.1.4.4.1.5.1',
  alarms: '1.3.6.1.2.1.33.1.6.1.0',
};
const UPS_SOURCE = { 1: 'otra', 2: 'sin salida', 3: 'normal', 4: 'bypass', 5: 'batería', 6: 'elevador (boost)', 7: 'reductor (trim)' };
const UPS_BATTERY = { 1: 'desconocido', 2: 'normal', 3: 'baja', 4: 'agotada' };

const UPS_META = {
  source: { label: 'Alimentación', kind: 'state' },
  batteryStatus: { label: 'Batería', kind: 'state' },
  charge: { label: 'Carga de batería', unit: '%', hist: true, max: 100 },
  runtime: { label: 'Autonomía', unit: 'min', hist: true },
  onBattery: { label: 'Tiempo en batería', unit: 's' },
  load: { label: 'Carga de salida', unit: '%', hist: true, max: 100 },
  inputVoltage: { label: 'Voltaje de entrada', unit: 'V', hist: true },
  inputFrequency: { label: 'Frecuencia de entrada', unit: 'Hz' },
  outputVoltage: { label: 'Voltaje de salida', unit: 'V', hist: true },
  batteryVoltage: { label: 'Voltaje de batería', unit: 'V' },
  batteryTemp: { label: 'Temperatura de batería', unit: '°C', hist: true },
  alarms: { label: 'Alarmas activas' },
  replaceBattery: { label: 'Reemplazo de batería', kind: 'state' },
};

function upsRules(m, th) {
  const r = [];
  if (m.source === 'batería') r.push({ key: 'ups_bateria', level: 'crit', text: 'UPS funcionando con batería (sin energía de la red)' });
  if (m.source === 'bypass') r.push({ key: 'ups_bypass', level: 'warn', text: 'UPS en bypass: la carga no está protegida' });
  if (m.batteryStatus === 'baja' || m.batteryStatus === 'agotada') r.push({ key: 'ups_bateria_baja', level: 'crit', text: `Batería ${m.batteryStatus}` });
  if (m.batteryStatus === 'falla') r.push({ key: 'ups_bateria_falla', level: 'crit', text: 'Batería en falla' });
  if (m.replaceBattery === 'reemplazar') r.push({ key: 'ups_reemplazo', level: 'warn', text: 'La UPS indica que hay que reemplazar la batería' });
  if (m.charge != null && m.charge < th.chargeMin) r.push({ key: 'ups_carga', level: 'crit', text: `Carga de batería ${m.charge}% (mínimo ${th.chargeMin}%)` });
  if (m.runtime != null && m.runtime < th.runtimeMin) r.push({ key: 'ups_autonomia', level: 'crit', text: `Autonomía ${m.runtime} min (mínimo ${th.runtimeMin} min)` });
  if (m.load != null && m.load >= th.loadCrit) r.push({ key: 'ups_sobrecarga', level: 'crit', text: `Carga de salida ${m.load}% (crítico ${th.loadCrit}%)` });
  else if (m.load != null && m.load >= th.loadWarn) r.push({ key: 'ups_sobrecarga', level: 'warn', text: `Carga de salida ${m.load}% (aviso ${th.loadWarn}%)` });
  if (m.batteryTemp != null && m.batteryTemp >= th.tempMax) r.push({ key: 'ups_temperatura', level: 'warn', text: `Temperatura de batería ${m.batteryTemp} °C` });
  if (m.alarms > 0) r.push({ key: 'ups_alarmas', level: 'warn', text: `La UPS reporta ${m.alarms} alarma(s) activa(s)` });
  return r;
}
const UPS_TH = { chargeMin: 30, runtimeMin: 10, loadWarn: 80, loadCrit: 95, tempMax: 40 };

const ups = {
  id: 'ups', label: 'UPS (UPS-MIB)',
  async detect(s) { return isValue((await getMap(s, [UPS.manufacturer]))[UPS.manufacturer]) || isValue((await getMap(s, [UPS.charge]))[UPS.charge]); },
  async collect(s) {
    const v = await getMap(s, Object.values(UPS));
    const g = (k) => v[UPS[k]];
    const tenth = (x) => (x == null ? null : Math.round(x) / 10);
    return {
      info: { fabricante: txt(g('manufacturer')), modelo: txt(g('model')), firmware: txt(g('firmware')) },
      metrics: {
        source: UPS_SOURCE[num(g('outputSource'))] ?? null,
        batteryStatus: UPS_BATTERY[num(g('batteryStatus'))] ?? null,
        charge: num(g('charge')), runtime: num(g('minutesRemaining')), onBattery: num(g('secondsOnBattery')),
        load: num(g('outputLoad')), inputVoltage: num(g('inputVoltage')), inputFrequency: tenth(num(g('inputFrequency'))),
        outputVoltage: num(g('outputVoltage')), batteryVoltage: tenth(num(g('batteryVoltage'))), batteryTemp: num(g('batteryTemp')),
        alarms: num(g('alarms')),
      },
    };
  },
  meta: UPS_META, thresholds: UPS_TH, rules: upsRules,
};

// ---------- UPS APC (PowerNet-MIB) ----------

const APC = {
  model: '1.3.6.1.4.1.318.1.1.1.1.1.1.0', name: '1.3.6.1.4.1.318.1.1.1.1.1.2.0', firmware: '1.3.6.1.4.1.318.1.1.1.1.2.1.0',
  serial: '1.3.6.1.4.1.318.1.1.1.1.2.3.0',
  batteryStatus: '1.3.6.1.4.1.318.1.1.1.2.1.1.0', timeOnBattery: '1.3.6.1.4.1.318.1.1.1.2.1.2.0',
  capacity: '1.3.6.1.4.1.318.1.1.1.2.2.1.0', batteryTemp: '1.3.6.1.4.1.318.1.1.1.2.2.2.0', runtime: '1.3.6.1.4.1.318.1.1.1.2.2.3.0',
  replace: '1.3.6.1.4.1.318.1.1.1.2.2.4.0', batteryVoltage: '1.3.6.1.4.1.318.1.1.1.2.2.8.0',
  inputVoltage: '1.3.6.1.4.1.318.1.1.1.3.2.1.0', inputFrequency: '1.3.6.1.4.1.318.1.1.1.3.2.4.0',
  outputStatus: '1.3.6.1.4.1.318.1.1.1.4.1.1.0', outputVoltage: '1.3.6.1.4.1.318.1.1.1.4.2.1.0', outputLoad: '1.3.6.1.4.1.318.1.1.1.4.2.3.0',
};
const APC_OUTPUT = { 1: 'desconocida', 2: 'normal', 3: 'batería', 4: 'elevador (boost)', 5: 'en espera', 6: 'bypass', 7: 'apagada', 8: 'reiniciando', 9: 'bypass', 10: 'bypass', 11: 'en espera', 12: 'reductor (trim)' };
const APC_BATTERY = { 1: 'desconocido', 2: 'normal', 3: 'baja', 4: 'falla' };

const upsApc = {
  id: 'ups-apc', label: 'UPS APC (PowerNet)',
  async detect(s, sys) { return String(sys.objectId || '').startsWith('1.3.6.1.4.1.318.') && isValue((await getMap(s, [APC.capacity]))[APC.capacity]); },
  async collect(s) {
    const v = await getMap(s, Object.values(APC));
    const g = (k) => v[APC[k]];
    const ticksMin = (x) => (x == null ? null : Math.round(x / 6000));
    return {
      info: { fabricante: 'APC', modelo: txt(g('model')), nombre: txt(g('name')), firmware: txt(g('firmware')), serie: txt(g('serial')) },
      metrics: {
        source: APC_OUTPUT[num(g('outputStatus'))] ?? null,
        batteryStatus: APC_BATTERY[num(g('batteryStatus'))] ?? null,
        charge: num(g('capacity')), runtime: ticksMin(num(g('runtime'))), onBattery: num(g('timeOnBattery')) == null ? null : Math.round(num(g('timeOnBattery')) / 100),
        load: num(g('outputLoad')), inputVoltage: num(g('inputVoltage')), inputFrequency: num(g('inputFrequency')),
        outputVoltage: num(g('outputVoltage')), batteryVoltage: num(g('batteryVoltage')), batteryTemp: num(g('batteryTemp')),
        replaceBattery: num(g('replace')) === 2 ? 'reemplazar' : num(g('replace')) === 1 ? 'no' : null,
      },
    };
  },
  meta: UPS_META, thresholds: UPS_TH, rules: upsRules,
};

// ---------- Switches y routers (IF-MIB) ----------

const IF = {
  descr: '1.3.6.1.2.1.2.2.1.2', type: '1.3.6.1.2.1.2.2.1.3', speed: '1.3.6.1.2.1.2.2.1.5', admin: '1.3.6.1.2.1.2.2.1.7', oper: '1.3.6.1.2.1.2.2.1.8',
  inOctets: '1.3.6.1.2.1.2.2.1.10', inErrors: '1.3.6.1.2.1.2.2.1.14', outOctets: '1.3.6.1.2.1.2.2.1.16', outErrors: '1.3.6.1.2.1.2.2.1.20',
  name: '1.3.6.1.2.1.31.1.1.1.1', hcIn: '1.3.6.1.2.1.31.1.1.1.6', hcOut: '1.3.6.1.2.1.31.1.1.1.10', highSpeed: '1.3.6.1.2.1.31.1.1.1.15', alias: '1.3.6.1.2.1.31.1.1.1.18',
};
const OPER = { 1: 'arriba', 2: 'abajo', 3: 'prueba', 4: 'desconocido', 5: 'inactiva', 6: 'no presente', 7: 'capa inferior abajo' };

/** Diferencia de contadores con vuelta (32 o 64 bits). */
function delta(cur, prev, bits) {
  if (cur == null || prev == null) return null;
  const d = cur - prev;
  if (d >= 0) return d;
  return bits === 32 ? d + 2 ** 32 : null; // reinicio del equipo o del contador de 64 bits: se descarta
}

async function interfaces(s, prev, now) {
  const rows = await table(s, IF);
  const prevMap = new Map((prev?.tables?.interfaces || []).map((i) => [i.index, i]));
  const prevAt = prev?.at;
  return rows.filter((r) => isValue(r.descr) || isValue(r.name)).map((r) => {
    const hc = isValue(r.hcIn) && isValue(r.hcOut);
    const inO = num(hc ? r.hcIn : r.inOctets);
    const outO = num(hc ? r.hcOut : r.outOctets);
    const p = prevMap.get(r.index);
    const secs = prevAt ? now - prevAt : null;
    const rate = (c, pc) => { const d = delta(c, pc, hc ? 64 : 32); return d == null || !secs ? null : Math.round((d * 8) / secs); };
    const errs = (num(r.inErrors) || 0) + (num(r.outErrors) || 0);
    return {
      index: r.index,
      name: txt(r.name) || txt(r.descr),
      alias: txt(r.alias) || '',
      type: num(r.type),
      speedMbps: num(r.highSpeed) || (num(r.speed) ? Math.round(num(r.speed) / 1e6) : null),
      admin: num(r.admin) === 1 ? 'arriba' : 'abajo',
      oper: OPER[num(r.oper)] || 'desconocido',
      inOctets: inO, outOctets: outO, errors: errs,
      inBps: p ? rate(inO, p.inOctets) : null,
      outBps: p ? rate(outO, p.outOctets) : null,
      errorsDelta: p ? Math.max(0, errs - (p.errors || 0)) : 0,
    };
  });
}

const PHYSICAL = new Set([6, 62, 69, 117, 71, 161]); // ethernet, fast/gigabit, wifi, LAG

const network = {
  id: 'network', label: 'Switch / router (IF-MIB)',
  async detect(s) { const r = await getMap(s, ['1.3.6.1.2.1.2.1.0']); return (num(r['1.3.6.1.2.1.2.1.0']) || 0) >= 1; },
  async collect(s, { prev, now, watch }) {
    const ifs = await interfaces(s, prev, now);
    const metrics = {
      portsUp: ifs.filter((i) => i.oper === 'arriba' && PHYSICAL.has(i.type)).length,
      portsTotal: ifs.filter((i) => PHYSICAL.has(i.type)).length,
    };
    // Tráfico en el historial: interfaces vigiladas, o las físicas arriba (máx. 24)
    const hist = {};
    const chosen = ifs.filter((i) => (watch.length ? watch.includes(i.index) : i.oper === 'arriba' && PHYSICAL.has(i.type))).slice(0, 24);
    for (const i of chosen) {
      if (i.inBps != null) hist[`if.${i.index}.in`] = i.inBps;
      if (i.outBps != null) hist[`if.${i.index}.out`] = i.outBps;
    }
    return { info: {}, metrics, tables: { interfaces: ifs }, extraHistory: hist };
  },
  meta: {
    portsUp: { label: 'Puertos arriba' },
    portsTotal: { label: 'Puertos físicos' },
  },
  thresholds: { errorsPerPoll: 100 },
  rules(m, th, data, watch) {
    const r = [];
    for (const i of data.tables?.interfaces || []) {
      if (!watch.includes(i.index)) continue;
      if (i.admin === 'arriba' && i.oper !== 'arriba') r.push({ key: `if_${i.index}_abajo`, level: 'crit', text: `Interfaz ${i.name}${i.alias ? ` (${i.alias})` : ''} caída` });
      if (i.errorsDelta >= th.errorsPerPoll) r.push({ key: `if_${i.index}_errores`, level: 'warn', text: `Interfaz ${i.name}: ${i.errorsDelta} errores nuevos` });
    }
    return r;
  },
};

// ---------- Impresoras (Printer-MIB) ----------

const PRT = {
  status: '1.3.6.1.2.1.25.3.5.1.1.1', errors: '1.3.6.1.2.1.25.3.5.1.2.1', devStatus: '1.3.6.1.2.1.25.3.2.1.5.1',
  pages: '1.3.6.1.2.1.43.10.2.1.4.1.1', serial: '1.3.6.1.2.1.43.5.1.1.17.1', devDescr: '1.3.6.1.2.1.25.3.2.1.3.1',
};
const SUPPLY = { descr: '1.3.6.1.2.1.43.11.1.1.6.1', type: '1.3.6.1.2.1.43.11.1.1.5.1', max: '1.3.6.1.2.1.43.11.1.1.8.1', level: '1.3.6.1.2.1.43.11.1.1.9.1' };
const PRT_STATUS = { 1: 'otro', 2: 'desconocido', 3: 'en espera', 4: 'imprimiendo', 5: 'calentando' };
// hrPrinterDetectedErrorState: bits desde el más significativo del primer byte
const PRT_ERRORS = ['poco papel', 'sin papel', 'poco tóner', 'sin tóner', 'puerta abierta', 'atasco', 'fuera de línea', 'requiere servicio',
  'falta bandeja de entrada', 'falta bandeja de salida', 'falta consumible', 'bandeja de salida casi llena', 'bandeja de salida llena',
  'bandeja de entrada vacía', 'mantenimiento preventivo vencido'];
const PRT_CRIT = new Set(['sin papel', 'sin tóner', 'atasco', 'puerta abierta', 'requiere servicio', 'falta consumible']);

function errorBits(vb) {
  if (!vb || !Buffer.isBuffer(vb.value)) return [];
  const out = [];
  vb.value.forEach((byte, bi) => { for (let b = 0; b < 8; b++) if (byte & (0x80 >> b) && PRT_ERRORS[bi * 8 + b]) out.push(PRT_ERRORS[bi * 8 + b]); });
  return out;
}

const printer = {
  id: 'printer', label: 'Impresora (Printer-MIB)',
  async detect(s) {
    const r = await getMap(s, [PRT.status, PRT.pages]);
    if (isValue(r[PRT.status]) || isValue(r[PRT.pages])) return true;
    try { return (await s.walk(SUPPLY.descr, { max: 2 })).length > 0; } catch { return false; }
  },
  async collect(s) {
    const v = await getMap(s, Object.values(PRT));
    const rows = await table(s, SUPPLY, 64);
    const supplies = rows.map((r) => {
      const max = num(r.max); const lvl = num(r.level);
      const pct = max > 0 && lvl >= 0 ? Math.round((lvl / max) * 100) : null;
      return { index: r.index, name: txt(r.descr) || `Consumible ${r.index}`, level: lvl, max, percent: pct, state: lvl === -3 ? 'con contenido' : lvl === -2 ? 'desconocido' : null };
    });
    const errs = errorBits(v[PRT.errors]);
    const metrics = { status: PRT_STATUS[num(v[PRT.status])] ?? null, pages: num(v[PRT.pages]), errors: errs.join(', ') || 'ninguno' };
    const extraHistory = {};
    for (const sp of supplies) if (sp.percent != null) extraHistory[`supply.${sp.index}`] = sp.percent;
    return { info: { modelo: txt(v[PRT.devDescr]), serie: txt(v[PRT.serial]) }, metrics, tables: { supplies }, extraHistory, errorsList: errs };
  },
  meta: {
    status: { label: 'Estado', kind: 'state' },
    pages: { label: 'Páginas impresas', hist: true },
    errors: { label: 'Alertas de la impresora', kind: 'state' },
  },
  thresholds: { supplyWarn: 15, supplyCrit: 3 },
  rules(m, th, data) {
    const r = [];
    for (const sp of data.tables?.supplies || []) {
      if (sp.percent == null) continue;
      if (sp.percent <= th.supplyCrit) r.push({ key: `consumible_${sp.index}`, level: 'crit', text: `${sp.name}: ${sp.percent}%` });
      else if (sp.percent <= th.supplyWarn) r.push({ key: `consumible_${sp.index}`, level: 'warn', text: `${sp.name}: ${sp.percent}%` });
    }
    for (const e of data.errorsList || []) {
      r.push({ key: `impresora_${e.replace(/\W+/g, '_')}`, level: PRT_CRIT.has(e) ? 'crit' : 'warn', text: `Impresora: ${e}` });
    }
    return r;
  },
};

// ---------- Servidores y NAS (HOST-RESOURCES-MIB) ----------

const HR = { uptime: '1.3.6.1.2.1.25.1.1.0', processes: '1.3.6.1.2.1.25.1.6.0' };
const HR_CPU = '1.3.6.1.2.1.25.3.3.1.2';
const HR_STORAGE = { type: '1.3.6.1.2.1.25.2.3.1.2', descr: '1.3.6.1.2.1.25.2.3.1.3', units: '1.3.6.1.2.1.25.2.3.1.4', size: '1.3.6.1.2.1.25.2.3.1.5', used: '1.3.6.1.2.1.25.2.3.1.6' };
const ST_RAM = '1.3.6.1.2.1.25.2.1.2';
const ST_DISK = new Set(['1.3.6.1.2.1.25.2.1.4', '1.3.6.1.2.1.25.2.1.10']); // fixedDisk, networkDisk
const IGNORE_FS = /^(\/(dev|run|sys|proc|snap|boot\/efi)\b|\/var\/lib\/docker|tmpfs|overlay)/;

const host = {
  id: 'host', label: 'Servidor / NAS (HOST-RESOURCES)',
  // hrProcessorLoad puede venir vacío el primer minuto tras arrancar el agente: basta hrSystemUptime
  async detect(s, sys) {
    if (sys.services != null && !(sys.services & 72)) return false; // solo capas 2/3: switch o router
    if (isValue((await getMap(s, [HR.uptime]))[HR.uptime])) return true;
    try { return (await s.walk(HR_CPU, { max: 2 })).length > 0; } catch { return false; }
  },
  async collect(s) {
    const v = await getMap(s, Object.values(HR));
    const cpus = (await s.walk(HR_CPU, { max: 256 })).map(num).filter((x) => x != null);
    const st = await table(s, HR_STORAGE, 256);
    const storage = [];
    let ram = null;
    for (const r of st) {
      const units = num(r.units) || 1; const size = num(r.size); const used = num(r.used);
      if (!size) continue;
      const type = isValue(r.type) ? r.type.value : '';
      const pct = Math.round((used / size) * 1000) / 10;
      if (type === ST_RAM) ram = pct;
      else if (ST_DISK.has(type) && !IGNORE_FS.test(txt(r.descr) || '')) {
        storage.push({ index: r.index, name: txt(r.descr), sizeBytes: size * units, usedBytes: used * units, percent: pct });
      }
    }
    const extraHistory = {};
    for (const d of storage.slice(0, 16)) extraHistory[`disk.${d.index}`] = d.percent;
    return {
      info: {},
      metrics: {
        cpu: cpus.length ? Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length) : null,
        cpus: cpus.length || null, ram, processes: num(v[HR.processes]),
      },
      tables: { storage },
      extraHistory,
    };
  },
  meta: {
    cpu: { label: 'CPU', unit: '%', hist: true, max: 100 },
    cpus: { label: 'Núcleos' },
    ram: { label: 'Memoria RAM', unit: '%', hist: true, max: 100 },
    processes: { label: 'Procesos' },
  },
  thresholds: { cpuWarn: 90, ramWarn: 95, diskWarn: 90, diskCrit: 97 },
  rules(m, th, data) {
    const r = [];
    if (m.cpu != null && m.cpu >= th.cpuWarn) r.push({ key: 'cpu', level: 'warn', text: `CPU al ${m.cpu}%` });
    if (m.ram != null && m.ram >= th.ramWarn) r.push({ key: 'ram', level: 'warn', text: `Memoria RAM al ${m.ram}%` });
    for (const d of data.tables?.storage || []) {
      if (d.percent >= th.diskCrit) r.push({ key: `disco_${d.index}`, level: 'crit', text: `Disco ${d.name} al ${d.percent}%` });
      else if (d.percent >= th.diskWarn) r.push({ key: `disco_${d.index}`, level: 'warn', text: `Disco ${d.name} al ${d.percent}%` });
    }
    return r;
  },
};

// ---------- Genérico ----------

const generic = {
  id: 'generic', label: 'Genérico (solo OIDs propios)',
  async detect() { return true; },
  async collect() { return { info: {}, metrics: {} }; },
  meta: {}, thresholds: {}, rules: () => [],
};

const PROFILES = { ups, 'ups-apc': upsApc, network, printer, host, generic };
// Orden de detección: lo más específico primero (una impresora también tiene HOST-RESOURCES e IF-MIB)
const DETECT_ORDER = ['ups-apc', 'ups', 'printer', 'host', 'network', 'generic'];

async function readSystem(s) {
  const v = await getMap(s, Object.values(SYS));
  return {
    descr: txt(v[SYS.descr]), objectId: isValue(v[SYS.objectId]) ? v[SYS.objectId].value : null,
    uptimeTicks: num(v[SYS.uptime]), contact: txt(v[SYS.contact]), name: txt(v[SYS.name]), location: txt(v[SYS.location]),
    services: num(v[SYS.services]), // bits: 2 enlace (switch), 4 red (router), 8 extremo a extremo, 64 aplicaciones (servidor)
  };
}

async function detectProfile(s, sys) {
  for (const id of DETECT_ORDER) {
    try { if (await PROFILES[id].detect(s, sys)) return id; } catch (e) { if (e.code === 'TIMEOUT') throw e; }
  }
  return 'generic';
}

// ---------- OIDs personalizados ----------

const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '==': (a, b) => a == b, '!=': (a, b) => a != b }; // eslint-disable-line eqeqeq

async function readCustom(s, custom) {
  if (!custom.length) return {};
  const v = await getMap(s, custom.map((c) => c.oid));
  const out = {};
  for (const c of custom) {
    const vb = v[c.oid];
    let val = isValue(vb) ? (typeof vb.value === 'number' ? vb.value : display(vb)) : null;
    if (typeof val === 'number' && c.scale && c.scale !== 1) val = Math.round(val * c.scale * 1000) / 1000;
    out[`c.${c.key}`] = val;
  }
  return out;
}

function customRules(metrics, custom) {
  const r = [];
  for (const c of custom) {
    if (!c.op || c.limit === undefined || c.limit === '') continue;
    const v = metrics[`c.${c.key}`];
    if (v == null) continue;
    const a = typeof v === 'number' ? v : String(v);
    const b = typeof v === 'number' ? Number(c.limit) : String(c.limit);
    if (OPS[c.op]?.(a, b)) r.push({ key: `c_${c.key}`, level: c.level === 'crit' ? 'crit' : 'warn', text: `${c.name}: ${v}${c.unit ? ' ' + c.unit : ''} (${c.op} ${c.limit})` });
  }
  return r;
}

module.exports = { PROFILES, DETECT_ORDER, readSystem, detectProfile, readCustom, customRules, OPS, isValue, getMap, table };
