/**
 * Browser routes for the settings card.
 *
 * The card cannot import Host code, so it talks to this module over the Web
 * server's own origin. Every route answers JSON and never throws: a handler
 * failure becomes `{ ok: false, error }` so the card can show a message instead
 * of a dead panel.
 *
 * Sign-in and consent changes are reachable ONLY here. The agent tools never
 * expose them, which keeps "who may widen my read scope" a user decision.
 */
import { describeFailure, OneNoteError } from './service.js';

const PREFIX = '/api/onenote';
const MAX_BODY_BYTES = 64 * 1024;

/**
 * A route table entry: method, path, and the body it accepts.
 *
 * Each path appears once: the Web server rejects a duplicate `(kind, path)`
 * pair, so a second method on the same path needs its own path segment.
 */
const ROUTES = [
  { method: 'GET', path: `${PREFIX}/state`, run: (service) => stateOf(service) },
  { method: 'POST', path: `${PREFIX}/device-code/start`, run: (service) => beginSignIn(service) },
  { method: 'GET', path: `${PREFIX}/device-code`, run: (service) => pollSignIn(service) },
  { method: 'POST', path: `${PREFIX}/notebooks`, run: (service, body) => saveNotebooks(service, body) },
  { method: 'POST', path: `${PREFIX}/sign-out`, run: (service) => signOut(service) },
];

function send(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new OneNoteError('The request body is too large.', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new OneNoteError('The request body is not valid JSON.', 'INVALID_BODY');
  }
}

/** The settings card's whole view of the plugin, in one request. */
async function stateOf(service) {
  const status = service.status();
  const base = {
    ok: true,
    signedIn: status.signedIn,
    renewsAutomatically: status.renewsAutomatically,
    expiresAt: status.expiresAt,
    account: status.account,
    allowedCount: status.allowedCount,
    allowedNotebooks: status.allowedNotebooks,
    pendingSignIn: status.pendingSignIn,
    notebooks: [],
    notebooksError: undefined,
  };
  // The notebook list needs a live token; signed out, the card still renders.
  if (!status.signedIn) return base;
  try {
    base.notebooks = await service.listNotebooks();
  } catch (error) {
    base.notebooksError = describeFailure(error);
  }
  return base;
}

async function beginSignIn(service) {
  const started = await service.beginSignIn();
  return { ok: true, ...started };
}

async function pollSignIn(service) {
  const outcome = await service.pollSignIn();
  if (outcome.status === 'signed-in') {
    return { ...(await stateOf(service)), status: 'signed-in', account: outcome.account };
  }
  return { ok: true, status: outcome.status, expiresInSeconds: outcome.expiresInSeconds };
}

async function saveNotebooks(service, body) {
  if (body.action === 'clear') {
    service.clearAllowedNotebooks();
    return { ...(await stateOf(service)), allowedCount: 0 };
  }
  const ids = Array.isArray(body.allowedIds) ? body.allowedIds : [];
  const stored = await service.setAllowedNotebooks(ids);
  return { ...(await stateOf(service)), allowedCount: stored.length };
}

function signOut(service) {
  service.signOut();
  return {
    ok: true,
    signedIn: false,
    allowedCount: service.allowedNotebooks().length,
  };
}

/**
 * Register every route on the Web server.
 *
 * Call this from inside `ctx.inject(['webServer'], ...)`, never directly from
 * `apply`. The Loader starts every row concurrently and the webServer row is
 * still LOADING while it binds its socket, so `ctx.get('webServer')` at apply
 * time answers `undefined` and every route is skipped. The card then falls
 * through to Connection's `/api` prefix, which answers a plain-text 401 that is
 * not JSON, and the card shows an error instead of the sign-in form.
 *
 * @param {object} ctx - the plugin context, whose `webServer` may be absent.
 * @param {object} service - the shared OneNote service.
 * @returns {boolean} whether the routes were registered.
 */
export function installRoutes(ctx, service) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    ctx.logger?.warn?.('onenote: no web server in this composition, so the settings card has no data source; the tools still work.');
    return false;
  }

  for (const route of ROUTES) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: route.path,
      handler: async (req, res) => {
        if (req.method !== route.method) {
          send(res, 405, { ok: false, error: `Use ${route.method} for this endpoint.` });
          return;
        }
        try {
          const body = route.method === 'POST' ? await readJsonBody(req) : {};
          const payload = await route.run(service, body);
          // `ok: true` is authoritative even when a spread carried `ok: false`.
          send(res, 200, { ...payload, ok: true });
        } catch (error) {
          send(res, 200, { ok: false, error: describeFailure(error), code: error?.code });
        }
      },
    }), `onenote route ${route.method} ${route.path}`);
  }
  return true;
}

/** The endpoint paths, exported so tests and the client share one source. */
export const ENDPOINTS = {
  state: `${PREFIX}/state`,
  startDeviceCode: `${PREFIX}/device-code/start`,
  pollDeviceCode: `${PREFIX}/device-code`,
  notebooks: `${PREFIX}/notebooks`,
  signOut: `${PREFIX}/sign-out`,
};
