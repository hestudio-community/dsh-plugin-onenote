import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tools are exercised against a stubbed registry. `@deepseek-ai/dsh-tools` is a
 * peer of the host, not a dependency of this package, so the stub keeps the
 * suite runnable from a bare checkout.
 */
async function loadTools() {
  const { registerTools } = await import('../src/tools.js');
  const tools = new Map();
  const ctx = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => {};
      },
    },
  };
  return { registerTools, ctx, tools };
}

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'onenote-tools-'));
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

/** A service double: the tools only ever call these methods. */
function fakeService(overrides = {}) {
  return {
    status: () => ({ signedIn: false, allowedNotebooks: [], allowedCount: 0 }),
    listPages: async () => ({ message: 'listed' }),
    search: async () => ({ message: 'searched' }),
    readPage: async () => ({ id: 'P', title: 'T', truncated: false, content: 'body' }),
    ...overrides,
  };
}

test('registers exactly the read-only tools', async () => {
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService());
  assert.deepEqual([...tools.keys()].sort(), [
    'onenote_list_pages',
    'onenote_read_page',
    'onenote_search',
    'onenote_status',
  ]);
  // The tools that could widen consent must not exist.
  assert.equal(tools.has('onenote_manage_notebooks'), false);
  assert.equal(tools.has('onenote_auth'), false);
});

test('every tool declares an output schema the registry subset accepts', async () => {
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService());
  for (const tool of tools.values()) {
    assert.equal(tool.output.schema.type, 'object', tool.name);
    assert.equal(typeof tool.output.render, 'function', tool.name);
    assert.equal(typeof tool.execute, 'function', tool.name);
    assert.equal(typeof tool.description, 'string', tool.name);
    assert.ok(tool.description.length > 40, `${tool.name} description too short`);
  }
});

test('onenote_status explains what to do when signed out', () => withHome(async () => {
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService());
  const value = await tools.get('onenote_status').execute({}, { signal: new AbortController().signal });
  assert.equal(value.signedIn, false);
  assert.match(value.message, /Settings → Plugins → OneNote/);
  // The renderer must accept the value it is given.
  const blocks = tools.get('onenote_status').output.render({}, value);
  assert.equal(blocks[0].type, 'text');
}));

test('onenote_status names the readable notebooks when connected', () => withHome(async () => {
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService({
    status: () => ({
      signedIn: true,
      account: { displayName: 'Alice' },
      expiresAt: '2026-10-28T20:00:00.000Z',
      allowedCount: 2,
      allowedNotebooks: [{ id: 'A', name: 'Work' }, { id: 'B', name: 'Reading' }],
    }),
  }));
  const value = await tools.get('onenote_status').execute({}, { signal: new AbortController().signal });
  assert.equal(value.signedIn, true);
  assert.equal(value.account, 'Alice');
  assert.match(value.message, /Work, Reading/);
  assert.match(value.message, /unreadable by design/);
  assert.equal(value.allowedNotebooks.length, 2);
}));

test('onenote_status warns when nothing is allowed', () => withHome(async () => {
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService({
    status: () => ({ signedIn: true, allowedCount: 0, allowedNotebooks: [] }),
  }));
  const value = await tools.get('onenote_status').execute({}, { signal: new AbortController().signal });
  assert.match(value.message, /No notebook is allowed/);
}));

test('onenote_list_pages passes snake_case arguments through', async () => {
  const seen = [];
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService({
    listPages: async (input) => { seen.push(input); return { message: 'ok' }; },
  }));
  await tools.get('onenote_list_pages').execute(
    { notebook_id: 'NB-1', section_id: 'S-1', limit: 7 },
    { signal: new AbortController().signal },
  );
  assert.deepEqual(seen[0], { notebookId: 'NB-1', sectionId: 'S-1', limit: 7 });
});

test('onenote_search clamps its limit and forwards the query', async () => {
  const seen = [];
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService({
    search: async (input) => { seen.push(input); return { message: 'ok' }; },
  }));
  await tools.get('onenote_search').execute({ query: 'sprint', limit: 9999 }, { signal: new AbortController().signal });
  assert.equal(seen[0].query, 'sprint');
  assert.equal(seen[0].limit, 50);
});

test('onenote_read_page renders a header, body, and truncation notice', async () => {
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService({
    readPage: async () => ({
      id: 'P1',
      title: 'Sprint plan',
      notebookName: 'Work',
      sectionName: 'Planning',
      lastModified: '2026-10-01T00:00:00Z',
      truncated: true,
      content: 'body text',
    }),
  }));
  const tool = tools.get('onenote_read_page');
  const value = await tool.execute({ page_id: 'P1' }, { signal: new AbortController().signal });
  const text = tool.output.render({}, value)[0].text;
  assert.match(text, /^# Sprint plan/);
  assert.match(text, /Work \/ Planning/);
  assert.match(text, /body text/);
  assert.match(text, /truncated/);
});

test('a denial surfaces as a thrown error the model can act on', async () => {
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService({
    readPage: async () => { throw new Error('Notebook not allowed. Notebook "Private" is not in the allowed list.'); },
  }));
  await assert.rejects(
    () => tools.get('onenote_read_page').execute({ page_id: 'P1' }, { signal: new AbortController().signal }),
    /Notebook not allowed/,
  );
});

test('the renderer of every tool accepts its own minimal value', async () => {
  const { registerTools, ctx, tools } = await loadTools();
  registerTools(ctx, fakeService());
  const minimal = {
    onenote_status: { signedIn: false, message: 'm' },
    onenote_list_pages: { message: 'm' },
    onenote_search: { message: 'm' },
    onenote_read_page: { id: 'P', title: 'T', truncated: false, content: 'c' },
  };
  for (const [name, value] of Object.entries(minimal)) {
    const blocks = tools.get(name).output.render({}, value);
    assert.equal(Array.isArray(blocks), true, name);
    assert.equal(blocks[0].type, 'text', name);
    assert.ok(blocks[0].text.length > 0, name);
  }
});
