'use strict';
// Fallas / incidencias de equipos. Hoy la fuente automática es "equipo fuera de línea" (lo abre/cierra
// el monitor de alertas). También admite fallas manuales. El objetivo es tener el listado en el hub y
// luego exportarlo a iit-ordenes-servicio (campo order_ref para la referencia externa).

const crypto = require('node:crypto');

const TYPES = ['equipo_fuera', 'manual', 'soporte'];
const STATUSES = ['abierta', 'en_proceso', 'resuelta', 'exportada'];
const OPEN = new Set(['abierta', 'en_proceso']);

const now = () => Math.floor(Date.now() / 1000);
const newId = () => 'f_' + crypto.randomBytes(9).toString('base64url');

/** Vista para la API (camelCase); machine opcional agrega nombre y cliente del equipo. */
function view(i, machine = null) {
  if (!i) return null;
  return {
    id: i.id,
    machineId: i.machine_id,
    machine: machine ? { id: machine.id, name: machine.name, client: machine.client } : null,
    type: i.type,
    title: i.title,
    description: i.description,
    status: i.status,
    source: i.source,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    resolvedAt: i.resolved_at,
    createdBy: i.created_by,
    orderRef: i.order_ref || '',
  };
}

/** Abre una falla automática de "equipo fuera de línea" si no hay ya una abierta para ese equipo. */
function autoOpenOffline(store, info, since) {
  if (store.findOpenIncident(info.id, 'equipo_fuera')) return null;
  const desc = `Sin conexión desde ${new Date((since || now()) * 1000).toISOString()}.`
    + (info.lastAddress ? ` Última IP conocida: ${info.lastAddress}.` : '');
  const inc = store.createIncident({
    id: newId(),
    machineId: info.id,
    type: 'equipo_fuera',
    source: 'auto',
    title: `Equipo fuera de línea: ${info.name}${info.client ? ` · ${info.client}` : ''}`,
    description: desc,
    status: 'abierta',
    createdBy: null,
  });
  store.event(info.id, 'falla_abierta', `equipo fuera de línea (${inc.id})`, 0);
  return inc;
}

/** Cierra (resuelta) la falla automática de "equipo fuera" cuando el equipo vuelve. */
function autoResolveOffline(store, machineId, t) {
  const open = store.findOpenIncident(machineId, 'equipo_fuera');
  if (!open) return null;
  store.updateIncident(open.id, { status: 'resuelta', resolved_at: t || now() });
  store.event(machineId, 'falla_resuelta', `equipo reconectado (${open.id})`, 0);
  return open.id;
}

module.exports = { TYPES, STATUSES, OPEN, newId, view, autoOpenOffline, autoResolveOffline };
