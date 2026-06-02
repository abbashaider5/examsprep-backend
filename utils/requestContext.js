import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

export const requestContext = new AsyncLocalStorage();

export function runWithRequestContext(initial, fn) {
  return requestContext.run(initial, fn);
}

export function getRequestContext() {
  return requestContext.getStore() || null;
}

export function patchRequestContext(patch) {
  const store = requestContext.getStore();
  if (!store) return;
  Object.assign(store, patch);
}

export function requestContextMiddleware(req, res, next) {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
  runWithRequestContext({ requestId }, next);
}
