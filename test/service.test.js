import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG = {
  clientId: '11111111-2222-3333-4444-555555555555',
  tenant: 'common',
  maxPagesPerList: 100,
  maxPageChars: 60000,
};

const NOTEBOOKS = [
  { id: 'NB-WORK', displayName: 'Work', isDefault: true },
  { id: 'NB-PRIVATE', displayName: 'Private', isShared: true },
];
const PAGE_WORK = {
  id: 'P-WORK',
  title: 'Sprint plan',
  lastModifiedDateTime: '2026-10-01T00:00:00Z',
  parentNotebook: { id: 'NB-WORK', displayName: 'Work' },
  parentSection: { id: 'S-WORK', displayName: 'Planning' },
  links: { oneNoteWebUrl: { href: 'https://onenote/p-work' } },
};
const PAGE_PRIVATE = {
  id: 'P-PRIVATE',
  title: 'Diary',
  lastModifiedDateTime: '2026-10-02T00:00:00Z',
  parentNotebook: { id: 'NB-PRIVATE', displayName: 'Private' },
  parentSection: { id: 'S-PRIV', displayName: 'Journal' },
};
const SECTIONS = {
  'NB-WORK': [{ id: 'S-WORK', displayName: 'Planning' }],
  'NB-PRIVATE': [{ id: 'S-PRIV', displayName: 'Journal' }],
};

/** One fake Graph that routes on the parsed URL, so query strings are real. */
function installFetch({ onDeviceCode, onToken } = {}) {
  const calls = [];
  globalThis.fetch = async (rawUrl, init) => {
    const url = new URL(String(rawUrl));
    const target = url.pathname + url.search;
    calls.push({ url: target, method: init?.method ?? 'GET' });

    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

    if (url.host === 'login.microsoftonline.com') {
      if (url.pathname.endsWith('/devicecode')) {
        return json(onDeviceCode ?? {
          device_code: 'DEV',
          user_code: 'ABCD-1234',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.pathname.endsWith('/token')) {
        return onToken === undefined
          ? json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'Notes.Read' })
          : onToken();
      }
    }

    if (target.includes('/content')) {
      return new Response('<h1>Sprint</h1><p>Ship <strong>it</strong></p>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    let match = url.pathname.match(/\/me\/onenote\/sections\/([^/]+)$/);
    if (match !== null) {
      const sectionId = match[1];
      const owner = sectionId === 'S-PRIV' ? 'NB-PRIVATE' : 'NB-WORK';
      return json({
        id: sectionId,
        displayName: owner === 'NB-WORK' ? 'Planning' : 'Journal',
        parentNotebook: { id: owner, displayName: owner === 'NB-WORK' ? 'Work' : 'Private' },
      });
    }
    match = url.pathname.match(/\/me\/onenote\/pages\/([^/]+)$/);
    if (match !== null) {
      return json(match[1] === 'P-PRIVATE' ? PAGE_PRIVATE : PAGE_WORK);
    }
    match = url.pathname.match(/notebooks\/([^/]+)\/sections$/);
    if (match !== null) return json({ value: SECTIONS[match[1]] ?? [] });
    if (url.pathname.endsWith('/me/onenote/pages')) {
      const filter = url.searchParams.get('$filter') ?? '';
      const notebook = filter.match(/parentNotebook\/id eq '([^']+)'/)?.[1];
      const value = notebook === 'NB-WORK' ? [PAGE_WORK] : notebook === 'NB-PRIVATE' ? [PAGE_PRIVATE] : [];
      return json({ value });
    }
    match = url.pathname.match(/sections\/([^/]+)\/pages$/);
    if (match !== null) {
      const value = match[1] === 'S-WORK' ? [PAGE_WORK] : [PAGE_PRIVATE];
      return json({ value });
    }
    if (url.pathname.endsWith('/me/onenote/notebooks')) return json({ value: NOTEBOOKS });
    if (url.pathname.endsWith('/me')) return json({ id: 'U1', displayName: 'Alice', userPrincipalName: 'alice@example.com' });
    return json({ value: [] });
  };
  return calls;
}

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'onenote-svc-'));
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

/** Load a fresh service over the test home, signed in with a long-lived token. */
async function readyService() {
  const { writeTokens } = await import('../src/state.js');
  writeTokens({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000, scope: 'Notes.Read' });
  const { createOneNoteService } = await import('../src/service.js');
  return createOneNoteService(CONFIG);
}

test('status reports signed out before any token exists', () => withHome(async () => {
  installFetch();
  const { createOneNoteService } = await import('../src/service.js');
  const service = createOneNoteService(CONFIG);
  const status = service.status();
  assert.equal(status.signedIn, false);
  assert.equal(status.allowedCount, 0);
  assert.equal(status.pendingSignIn, false);
}));

test('beginSignIn persists the attempt so the next request can poll it', () => withHome(async () => {
  installFetch();
  const { createOneNoteService } = await import('../src/service.js');
  const service = createOneNoteService(CONFIG);
  const started = await service.beginSignIn();
  assert.equal(started.userCode, 'ABCD-1234');
  assert.match(started.verificationUri, /devicelogin/);
  assert.ok(started.expiresInSeconds > 0);

  const { readPendingSignIn } = await import('../src/state.js');
  assert.equal(readPendingSignIn()?.deviceCode, 'DEV');

  // A second call continues the same code instead of invalidating it.
  const again = await service.beginSignIn();
  assert.equal(again.userCode, 'ABCD-1234');
}));

test('pollSignIn signs in and records the account', () => withHome(async () => {
  installFetch();
  const { createOneNoteService } = await import('../src/service.js');
  const service = createOneNoteService(CONFIG);
  await service.beginSignIn();
  const outcome = await service.pollSignIn();
  assert.equal(outcome.status, 'signed-in');
  assert.equal(outcome.account.displayName, 'Alice');
  assert.equal(service.status().signedIn, true);
}));

test('a declined sign-in clears the pending attempt', () => withHome(async () => {
  installFetch({
    onToken: () => new Response(JSON.stringify({ error: 'authorization_declined', error_description: 'declined' }), { status: 400 }),
  });
  const { createOneNoteService } = await import('../src/service.js');
  const service = createOneNoteService(CONFIG);
  await service.beginSignIn();
  await assert.rejects(() => service.pollSignIn(), /declined/);
  const { readPendingSignIn } = await import('../src/state.js');
  assert.equal(readPendingSignIn(), undefined);
}));

test('listNotebooks marks the allow-list without hiding the rest', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);
  const notebooks = await service.listNotebooks();
  assert.equal(notebooks.length, 2);
  assert.equal(notebooks.find((n) => n.id === 'NB-WORK').allowed, true);
  assert.equal(notebooks.find((n) => n.id === 'NB-PRIVATE').allowed, false);
  assert.equal(notebooks.find((n) => n.id === 'NB-PRIVATE').isShared, true);
}));

test('setAllowedNotebooks refuses ids the account cannot see', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await assert.rejects(() => service.setAllowedNotebooks(['NB-NOPE']), /not visible to the signed-in account/);
  assert.equal(service.status().allowedCount, 0);
}));

test('setAllowedNotebooks with no ids clears consent', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);
  assert.equal(service.status().allowedCount, 1);
  await service.setAllowedNotebooks([]);
  assert.equal(service.status().allowedCount, 0);
}));

test('listPages with no consent reads nothing', () => withHome(async () => {
  const calls = installFetch();
  const service = await readyService();
  const result = await service.listPages({});
  assert.match(result.message, /No notebooks are allowed/);
  assert.equal(calls.some((call) => call.url.includes('/onenote/sections')), false);
}));

test('listPages browses an allowed notebook and refuses another', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);

  const listed = await service.listPages({ notebookId: 'NB-WORK' });
  assert.equal(listed.notebooks[0].sections[0].name, 'Planning');
  assert.equal(listed.pages[0].id, 'P-WORK');

  await assert.rejects(() => service.listPages({ notebookId: 'NB-PRIVATE' }), /not in the allowed list/);
}));

test('a section id cannot be used to reach an unapproved notebook', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);
  await assert.rejects(() => service.listPages({ sectionId: 'S-PRIV' }), /not in the allowed list/);
}));

test('readPage returns Markdown for an allowed page', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);
  const page = await service.readPage({ pageId: 'P-WORK' });
  assert.equal(page.title, 'Sprint plan');
  assert.match(page.content, /# Sprint/);
  assert.match(page.content, /Ship \*\*it\*\*/);
  assert.equal(page.notebookName, 'Work');
  assert.equal(page.truncated, false);
}));

test('readPage refuses a page in an unapproved notebook', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);
  await assert.rejects(() => service.readPage({ pageId: 'P-PRIVATE' }), /not in the allowed list/);
}));

test('search matches titles first and then page bodies', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);

  const byTitle = await service.search({ query: 'sprint' });
  assert.equal(byTitle.results.length, 1);
  assert.equal(byTitle.results[0].matchedIn, 'title');

  const byBody = await service.search({ query: 'ship' });
  assert.equal(byBody.results.length, 1);
  assert.equal(byBody.results[0].matchedIn, 'body');
  assert.match(byBody.results[0].snippet, /Ship/);

  const none = await service.search({ query: 'absent-token' });
  assert.equal(none.results, undefined);
  assert.match(none.message, /No page/);
}));

test('search never leaves the allowed set', () => withHome(async () => {
  const calls = installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);
  await service.search({ query: 'anything' });
  const pageQueries = calls.filter((call) => call.url.includes('/me/onenote/pages?'));
  assert.ok(pageQueries.length > 0);
  for (const call of pageQueries) {
    assert.match(call.url, /NB-WORK/);
    assert.doesNotMatch(call.url, /NB-PRIVATE/);
  }
}));

test('an empty query is rejected', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);
  await assert.rejects(() => service.search({ query: '   ' }), /non-empty query/);
}));

test('signOut forgets the session but keeps the allow-list', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);
  service.signOut();
  const status = service.status();
  assert.equal(status.signedIn, false);
  assert.equal(status.allowedCount, 1);
}));

test('a 401 during a read reports that sign-in is needed', () => withHome(async () => {
  installFetch();
  const service = await readyService();
  await service.setAllowedNotebooks(['NB-WORK']);
  // Replace fetch so only the page read fails, with a 401 from Graph.
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('graph.microsoft.com') && String(url).includes('/pages/')) {
      return new Response('{}', { status: 401 });
    }
    return base(url, init);
  };
  await assert.rejects(() => service.readPage({ pageId: 'P-WORK' }), /sign-in|sign in/i);
}));
