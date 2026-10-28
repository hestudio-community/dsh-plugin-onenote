import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const CONFIG = {
  clientId: '11111111-2222-3333-4444-555555555555',
  tenant: 'common',
  maxPagesPerList: 100,
  maxPageChars: 60000,
};

const NOTEBOOKS = [{ id: 'NB-WORK', displayName: 'Work', isDefault: true }];
const PAGE = {
  id: 'P-WORK',
  title: 'Sprint plan',
  lastModifiedDateTime: '2026-10-01T00:00:00Z',
  parentNotebook: { id: 'NB-WORK', displayName: 'Work' },
  parentSection: { id: 'S-WORK', displayName: 'Planning' },
};

function installFetch() {
  globalThis.fetch = async (rawUrl) => {
    const url = new URL(String(rawUrl));
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/devicecode')) {
      return json({ device_code: 'DEV', user_code: 'WXYZ-9876', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    }
    if (url.pathname.endsWith('/token')) return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
    if (url.pathname.endsWith('/me')) return json({ id: 'U1', displayName: 'Alice' });
    if (url.pathname.endsWith('/me/onenote/notebooks')) return json({ value: NOTEBOOKS });
    if (url.pathname.includes('/me/onenote/pages/')) return json(PAGE);
    if (url.pathname.includes('/sections')) return json({ value: [{ id: 'S-WORK', displayName: 'Planning' }] });
    return json({ value: [PAGE] });
  };
}

/** A response recorder with just the surface the routes use. */
function fakeResponse() {
  const chunks = [];
  const headers = {};
  let status = 0;
  return {
    writeHead(code, extra) {
      status = code;
      Object.assign(headers, extra ?? {});
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)));
    },
    get statusCode() { return status; },
    get headers() { return headers; },
    get body() {
      const text = Buffer.concat(chunks).toString('utf8');
      return text.length === 0 ? undefined : JSON.parse(text);
    },
  };
}

function fakeRequest(method, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  return stream;
}

/** Register the routes against a fake web server and return a caller. */
async function harness() {
  const { createOneNoteService } = await import('../src/service.js');
  const { installRoutes } = await import('../src/routes.js');
  const service = createOneNoteService(CONFIG);
  const routes = new Map();
  const ctx = {
    get: (name) => (name === 'webServer'
      ? { register: (route) => { routes.set(`${route.kind}:${route.path}`, route); return () => {}; } }
      : undefined),
    effect: (fn) => { fn(); return () => {}; },
    logger: { warn: () => {} },
  };
  const installed = installRoutes(ctx, service);
  return {
    installed,
    service,
    routes,
    async call(method, path, body) {
      const route = routes.get(`exact:${path}`);
      assert.ok(route !== undefined, `no route registered for ${method} ${path}`);
      const res = fakeResponse();
      await route.handler(fakeRequest(method, body), res);
      return { status: res.statusCode, headers: res.headers, body: res.body };
    },
  };
}

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'onenote-routes-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    });
}

test('routes install on a web server and are skipped without one', async () => {
  const app = await harness();
  assert.equal(app.installed, true);
  assert.equal(app.routes.size, 5);

  const { installRoutes } = await import('../src/routes.js');
  const warnings = [];
  const skipped = installRoutes({
    get: () => undefined,
    effect: () => () => {},
    logger: { warn: (m) => warnings.push(m) },
  }, {});
  assert.equal(skipped, false);
  assert.equal(warnings.length, 1);
});

test('state answers ok with signedIn false before sign-in', () => withHome(async () => {
  installFetch();
  const app = await harness();
  const result = await app.call('GET', '/api/onenote/state');
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body.ok, true);
  assert.equal(result.body.signedIn, false);
  assert.deepEqual(result.body.notebooks, []);
}));

test('device-code start returns a code the card can show', () => withHome(async () => {
  installFetch();
  const app = await harness();
  const result = await app.call('POST', '/api/onenote/device-code/start', {});
  assert.equal(result.body.ok, true);
  assert.equal(result.body.userCode, 'WXYZ-9876');
  assert.match(result.body.verificationUri, /devicelogin/);
  assert.ok(result.body.expiresInSeconds > 0);
}));

test('polling completes the sign-in and includes the notebook list', () => withHome(async () => {
  installFetch();
  const app = await harness();
  await app.call('POST', '/api/onenote/device-code/start', {});
  const result = await app.call('GET', '/api/onenote/device-code');
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, 'signed-in');
  assert.equal(result.body.signedIn, true);
  assert.equal(result.body.account.displayName, 'Alice');
  assert.equal(result.body.notebooks.length, 1);
  assert.equal(result.body.notebooks[0].allowed, false);
}));

test('saving notebooks returns the new state in one round trip', () => withHome(async () => {
  installFetch();
  const app = await harness();
  await app.call('POST', '/api/onenote/device-code/start', {});
  await app.call('GET', '/api/onenote/device-code');

  const saved = await app.call('POST', '/api/onenote/notebooks', { allowedIds: ['NB-WORK'] });
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.allowedCount, 1);
  assert.equal(saved.body.notebooks[0].allowed, true);

  const cleared = await app.call('POST', '/api/onenote/notebooks', { action: 'clear' });
  assert.equal(cleared.body.ok, true);
  assert.equal(cleared.body.allowedCount, 0);
  assert.equal(cleared.body.notebooks[0].allowed, false);
}));

test('an unknown notebook id answers ok:false instead of throwing', () => withHome(async () => {
  installFetch();
  const app = await harness();
  await app.call('POST', '/api/onenote/device-code/start', {});
  await app.call('GET', '/api/onenote/device-code');
  const result = await app.call('POST', '/api/onenote/notebooks', { allowedIds: ['NB-GHOST'] });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /not visible/);
}));

test('sign-out clears the session and keeps the allow-list', () => withHome(async () => {
  installFetch();
  const app = await harness();
  await app.call('POST', '/api/onenote/device-code/start', {});
  await app.call('GET', '/api/onenote/device-code');
  await app.call('POST', '/api/onenote/notebooks', { allowedIds: ['NB-WORK'] });

  const out = await app.call('POST', '/api/onenote/sign-out', {});
  assert.equal(out.body.ok, true);
  assert.equal(out.body.signedIn, false);
  assert.equal(out.body.allowedCount, 1);
}));

test('a wrong method answers 405 with JSON', () => withHome(async () => {
  installFetch();
  const app = await harness();
  const result = await app.call('GET', '/api/onenote/notebooks');
  assert.equal(result.status, 405);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /POST/);
}));

test('a malformed JSON body answers ok:false', () => withHome(async () => {
  installFetch();
  const app = await harness();
  const route = app.routes.get('exact:/api/onenote/notebooks');
  const res = fakeResponse();
  const stream = Readable.from([Buffer.from('{not json')]);
  stream.method = 'POST';
  await route.handler(stream, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /not valid JSON/);
}));

/**
 * The bug this pins: the Loader starts every row concurrently and the
 * webServer row stays LOADING while it binds, so a strict `ctx.get` at apply
 * time answers `undefined`. The five routes were then dropped without a trace,
 * the card fell through to Connection's `/api` prefix, and its plain-text 401
 * surfaced as an opaque error instead of the sign-in form.
 *
 * This drives the real `apply` with a webServer that is absent at apply time
 * and arrives afterwards, which is the ordering that broke the card. It fails
 * if `apply` reverts to a one-shot `ctx.get`.
 */
test('apply waits for a webServer that arrives after activation', async () => {
  const { apply } = await import('../index.js');
  const routes = new Map();
  let pending = null;
  let applied = false;

  const ctx = {
    logger: { warn: () => {} },
    // Absent at apply time, exactly like a row whose fiber is still LOADING.
    get: () => undefined,
    effect: (fn) => { fn(); return () => {}; },
    tools: { register: () => () => {} },
    inject: (deps, callback) => { pending = { deps, callback }; return () => {}; },
  };

  apply(ctx, CONFIG);
  applied = true;
  assert.equal(applied, true, 'apply must not throw when webServer is missing');
  assert.ok(pending !== null, 'apply must defer the route mount to a dependency callback');
  assert.deepEqual(pending.deps, ['webServer']);
  assert.equal(routes.size, 0, 'nothing registers before webServer is ACTIVE');

  // The service arrives late: the callback runs and all five routes mount.
  pending.callback({
    get: () => ({ register: (route) => { routes.set(`${route.kind}:${route.path}`, route); return () => {}; } }),
    effect: (fn) => { fn(); return () => {}; },
    logger: { warn: () => {} },
  });
  assert.equal(routes.size, 5, 'all five routes register once webServer is ACTIVE');
});

test('installRoutes reports that it skipped a composition without a web server', async () => {
  const { installRoutes } = await import('../src/routes.js');
  const warnings = [];
  const installed = installRoutes({
    get: () => undefined,
    effect: () => () => {},
    logger: { warn: (message) => warnings.push(message) },
  }, {});
  assert.equal(installed, false);
  assert.equal(warnings.length, 1);
});
