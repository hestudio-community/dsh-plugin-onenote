import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSchema, checkValue } from './support/schema.js';

const CONFIG = {
  clientId: '11111111-2222-3333-4444-555555555555',
  tenant: 'common',
  maxPagesPerList: 100,
  maxPageChars: 60000,
};

function installFetch() {
  globalThis.fetch = async (rawUrl) => {
    const url = new URL(String(rawUrl));
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/devicecode')) {
      return json({ device_code: 'DEV', user_code: 'CODE-1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    }
    if (url.pathname.endsWith('/token')) return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
    if (url.pathname.endsWith('/me')) return json({ id: 'U1', displayName: 'Alice' });
    if (url.pathname.endsWith('/me/onenote/notebooks')) {
      return json({ value: [{ id: 'NB-WORK', displayName: 'Work', isDefault: true }, { id: 'NB-PRIV', displayName: 'Private', isShared: true }] });
    }
    if (url.pathname.includes('/content')) {
      return new Response('<h1>Sprint</h1><p>Ship <strong>it</strong></p>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname.includes('/me/onenote/pages/')) {
      return json({ id: 'P1', title: 'Sprint plan', parentNotebook: { id: 'NB-WORK', displayName: 'Work' }, parentSection: { id: 'S1', displayName: 'Planning' } });
    }
    if (/\/me\/onenote\/sections\/[^/]+$/.test(url.pathname)) {
      return json({ id: 'S1', displayName: 'Planning', parentNotebook: { id: 'NB-WORK', displayName: 'Work' } });
    }
    if (url.pathname.includes('/sections')) return json({ value: [{ id: 'S1', displayName: 'Planning' }] });
    if (url.pathname.endsWith('/me/onenote/pages')) {
      return json({ value: [{ id: 'P1', title: 'Sprint plan', parentNotebook: { id: 'NB-WORK', displayName: 'Work' }, parentSection: { id: 'S1', displayName: 'Planning' } }] });
    }
    return json({ value: [] });
  };
}

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'onenote-schema-'));
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

async function liveTools() {
  const { writeTokens } = await import('../src/state.js');
  writeTokens({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 });
  const { createOneNoteService } = await import('../src/service.js');
  const { registerTools } = await import('../src/tools.js');
  const service = createOneNoteService(CONFIG);
  const tools = new Map();
  registerTools({ tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } } }, service);
  return { tools, service };
}

test('every declared output schema belongs to the host subset', () => withHome(async () => {
  const { tools } = await liveTools();
  assert.ok(tools.size > 0);
  for (const tool of tools.values()) {
    const problems = [];
    checkSchema(tool.output.schema, `${tool.name}.schema`, problems);
    assert.deepEqual(problems, [], `${tool.name}: ${problems.join('; ')}`);
  }
}));

test('every real tool result satisfies its own schema', () => withHome(async () => {
  installFetch();
  const { tools, service } = await liveTools();
  await service.setAllowedNotebooks(['NB-WORK']);

  const cases = [
    ['onenote_status', {}],
    ['onenote_list_pages', {}],
    ['onenote_list_pages', { notebook_id: 'NB-WORK' }],
    ['onenote_list_pages', { section_id: 'S1' }],
    ['onenote_search', { query: 'sprint' }],
    ['onenote_read_page', { page_id: 'P1' }],
  ];

  for (const [name, args] of cases) {
    const tool = tools.get(name);
    const value = await tool.execute(args, { signal: new AbortController().signal });
    const problems = [];
    checkValue(tool.output.schema, value, `${name}.value`, problems);
    assert.deepEqual(problems, [], `${name}: ${problems.join('; ')}`);
    const blocks = tool.output.render(args, value);
    assert.equal(blocks[0].type, 'text', name);
    assert.ok(blocks[0].text.length > 0, name);
  }
}));

test('the schema checker itself rejects a stray keyword', () => {
  const problems = [];
  checkSchema({ type: 'object', additionalProperties: false, properties: {}, minProperties: 1 }, 's', problems);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /minProperties/);
});

test('the value checker catches an undeclared field', () => {
  const problems = [];
  checkValue(
    { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] },
    { a: 'x', b: 1 },
    'v',
    problems,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /b is not declared/);
});
