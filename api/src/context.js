'use strict';
// Contexto por petición (AsyncLocalStorage): permite que store.event() sepa quién hizo el cambio
// sin pasar el usuario por todas las funciones. Fuera de una petición (plugin de frps, monitor) no hay actor.

const { AsyncLocalStorage } = require('node:async_hooks');

const requestContext = new AsyncLocalStorage();
const currentActor = () => requestContext.getStore()?.actor ?? null;

module.exports = { requestContext, currentActor };
