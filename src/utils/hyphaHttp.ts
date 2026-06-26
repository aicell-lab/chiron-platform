// HTTP transport for Hypha RPC calls.
//
// Replaces the per-service WebSocket connections we used to open via
// `server.getService(serviceId)` followed by `.someMethod(args)`. Each call
// becomes one stateless POST: no per-service connection state, no stale-
// connection failure modes, no "Connect" button. The user is already
// authenticated through the main hypha-rpc websocket (login flow); we mirror
// that bearer token in `useHyphaStore.hyphaToken` and reuse it here.
//
// The Hypha server treats the JSON body as Python kwargs automatically, so we
// drop the `_rkwargs: true` flag that the WebSocket SDK required. Positional
// argument lists from the old JS code (e.g. `add_trainer(svcId, orchId)`) are
// rewritten as kwarg objects at the call site.

import { useHyphaStore } from '../store/hyphaStore';

const HYPHA_BASE = 'https://hypha.aicell.io';

export interface HyphaCallOptions {
  /** Hard timeout (ms). Defaults to 15s — well under the UI's 10s polling cadence + a bit of slack. */
  timeoutMs?: number;
  /** External AbortSignal — chained with the internal timeout signal. */
  signal?: AbortSignal;
  /** Override the token; falls back to `useHyphaStore.hyphaToken`. */
  token?: string;
  /** Override the API base URL. Defaults to `https://hypha.aicell.io`. */
  serverUrl?: string;
}

export class HyphaHttpError extends Error {
  status: number;
  serviceId: string;
  method: string;
  bodyText?: string;
  constructor(serviceId: string, method: string, status: number, bodyText: string) {
    super(`HTTP ${status} calling ${serviceId}/${method}: ${bodyText.slice(0, 240)}`);
    this.name = 'HyphaHttpError';
    this.status = status;
    this.serviceId = serviceId;
    this.method = method;
    this.bodyText = bodyText;
  }
}

/**
 * Split a fully-qualified Hypha service id ("workspace/client-id:service-name")
 * into the workspace and the path component used in the HTTP URL.
 */
function splitServiceId(serviceId: string): { workspace: string; rest: string } {
  const slash = serviceId.indexOf('/');
  if (slash < 0) {
    throw new Error(`Invalid Hypha service id (missing workspace): ${serviceId}`);
  }
  return { workspace: serviceId.slice(0, slash), rest: serviceId.slice(slash + 1) };
}

/**
 * Call a Hypha service method over HTTP. Returns the parsed JSON response.
 *
 * Example:
 *   const info = await callHyphaService(managerServiceId, 'get_worker_info');
 *   await callHyphaService(orchServiceId, 'add_trainer', {
 *     service_id: trainerSvcId,
 *     orchestrator_service_id: orchServiceId,
 *   });
 */
export async function callHyphaService<T = any>(
  serviceId: string,
  method: string,
  kwargs: Record<string, any> = {},
  opts: HyphaCallOptions = {},
): Promise<T> {
  const { workspace, rest } = splitServiceId(serviceId);
  const baseUrl = opts.serverUrl ?? HYPHA_BASE;
  // When the service id contains a wildcard (e.g. the chiron-manager wildcard
  // form `<workerClientId>-*:chiron-manager`), Hypha's default resolution
  // picks the first matching registration. After a Ray Serve replica
  // rotation the OLD client's Hypha service registration lingers (its
  // websocket still looks open, its RPC handler is dead), so "first" lands
  // on the stale replica and every call hangs. `_mode=last` instead picks
  // the most recently registered service — always the live replica.
  // Targeting only wildcard ids keeps the rest of the call sites
  // unchanged (the Hypha HTTP layer would ignore _mode anyway when there's
  // no ambiguity, but we keep the URL minimal).
  const modeQuery = rest.includes('*') ? '?_mode=last' : '';
  const url = `${baseUrl}/${workspace}/services/${rest}/${method}${modeQuery}`;

  const token = opts.token ?? useHyphaStore.getState().hyphaToken ?? undefined;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Chain external + timeout abort signals.
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 15000;
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal!.reason), { once: true });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(kwargs),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HyphaHttpError(serviceId, method, res.status, text);
    }
    // Most Chiron methods return JSON; a few return None (Python) → null.
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List services in a workspace via HTTP. Returns the raw service metadata list.
 * Equivalent to `await server.listServices()` but stateless / HTTP-only.
 */
export async function listHyphaServices(
  workspace: string,
  opts: HyphaCallOptions = {},
): Promise<any[]> {
  const baseUrl = opts.serverUrl ?? HYPHA_BASE;
  const url = `${baseUrl}/${workspace}/services/`;
  const token = opts.token ?? useHyphaStore.getState().hyphaToken ?? undefined;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')),
    opts.timeoutMs ?? 15000);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal!.reason), { once: true });
  }
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new HyphaHttpError(`${workspace}/<list>`, 'list_services', res.status, text);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
