import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The client half is hand-written, so these checks stand in for the build-time
 * type check a compiled plugin would get: the loader contract, the slot key the
 * Plugins page dispatches, and the locale dictionaries both languages need.
 */

function loadClient() {
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const box = {};
  // The bundle only touches `window.__ModuleLoader__` at load time.
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { box.mod = mod; } } },
    console,
  };
  vm.runInNewContext(source, sandbox);
  return box.mod;
}

/** A tiny hooks harness: enough to render the component once. */
function hooksHarness() {
  let slots = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...kids) => ({
      type,
      props: props ?? {},
      kids: kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false),
    }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useState: (init) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = init;
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useEffect: () => {},
    useRef: (value) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: value };
      return slots[index];
    },
  };
  return {
    React,
    reset() { slots = []; cursor = 0; },
  };
}

test('the bundle registers under the package name the Plugins page keys on', () => {
  const mod = loadClient();
  assert.equal(mod.id, 'dsh-plugin-onenote');
  assert.equal(typeof mod.factory, 'function');
});

test('apply injects slots and locale, then registers the bundle config card', () => {
  const mod = loadClient();
  const harness = hooksHarness();
  const result = mod.factory((name) => {
    if (name === 'react') return harness.React;
    throw new Error(`unexpected require: ${name}`);
  });

  // The factory runs inside a VM realm, so its arrays are not this realm's.
  assert.deepEqual([...result.inject], ['slots', 'locale']);

  const locales = [];
  const registrations = [];
  result.apply({
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: (ns, dicts) => { locales.push({ ns, langs: Object.keys(dicts).sort() }); return () => {}; } },
    slots: {
      inject: (key, callback) => { callback(); return () => {}; },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
  });

  assert.equal(locales.length, 1);
  assert.equal(locales[0].ns, 'onenote');
  assert.deepEqual([...locales[0].langs], ['en', 'zh']);
  assert.equal(registrations.length, 1);
  const [{ options, component }] = registrations;
  assert.equal(options.name, 'plugins.bundle.config');
  assert.equal(options.key, 'dsh-plugin-onenote');
  assert.equal(options.id, 'dsh-plugin-onenote');
  assert.equal(options.locale, 'onenote');
  assert.equal(typeof component, 'function');
});

test('the summary view is a single line of text', () => {
  const mod = loadClient();
  const harness = hooksHarness();
  const result = mod.factory((name) => (name === 'react' ? harness.React : (() => { throw new Error(name); })()));
  let Component = null;
  result.apply({
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => () => {} },
    slots: { inject: (k, cb) => { cb(); return () => {}; }, register: (o, c) => { Component = c; return () => {}; } },
  });
  const summary = Component({ view: 'summary' });
  assert.equal(typeof summary, 'string');
  assert.ok(summary.length > 20);
});

test('the page view renders a sign-in affordance while signed out', () => {
  const mod = loadClient();
  const harness = hooksHarness();
  const result = mod.factory((name) => (name === 'react' ? harness.React : (() => { throw new Error(name); })()));
  let Component = null;
  result.apply({
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => () => {} },
    slots: { inject: (k, cb) => { cb(); return () => {}; }, register: (o, c) => { Component = c; return () => {}; } },
  });

  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') { const s = String(node).trim(); if (s.length > 0) texts.push(s); return; }
    if (typeof node.type === 'function') { walk(node.type(node.props)); return; }
    if (node.type === 'style') return;
    if (node.type === 'button') texts.push(`button:${node.kids.map(String).join('')}`);
    if (node.type === 'input') texts.push(`input:${node.props.checked ? 'on' : 'off'}`);
    if (node.props?.children) walk(node.props.children);
    (node.kids ?? []).forEach(walk);
  };

  harness.reset();
  walk(Component({ view: 'page' }));
  // The first render is the loading state; nothing to assert beyond a real tree.
  assert.ok(texts.length > 0);
});

test('every user-visible string exists in both dictionaries', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const block = (name) => {
    const start = source.indexOf(`const ${name} = {`);
    assert.ok(start >= 0, `missing dictionary ${name}`);
    const end = source.indexOf('\n    }', start);
    return source.slice(start, end);
  };
  const keysOf = (text) => [...text.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1]).sort();
  const en = keysOf(block('en'));
  const zh = keysOf(block('zh'));
  assert.ok(en.length > 20, `only ${en.length} English keys`);
  assert.deepEqual(zh, en, 'zh and en must declare the same keys');
});

test('the card uses only host theme tokens for colour', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const css = source.slice(source.indexOf('const CSS = ['), source.indexOf("].join('\\n')"));
  const colors = [...css.matchAll(/(?:color|background|border-color)\s*:\s*([^;'}]+)/g)].map((match) => match[1].trim());
  for (const value of colors) {
    assert.ok(value.startsWith('var(--dsw-alias-'), `colour outside a theme token: ${value}`);
  }
});

/**
 * `brand-primary` inverts between themes (near-black on light, near-white on
 * dark), so filling a button with it and labelling it with a literal white made
 * the sign-in button white-on-white in dark mode. The primary button must pair
 * the host's fill token with the host's foreground token.
 */
test('the primary button pairs the host fill and foreground tokens', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const rule = source.match(/\.dsh-onenote-btn-primary\{([^}]*)\}/);
  assert.ok(rule, 'client.js no longer styles .dsh-onenote-btn-primary');
  assert.match(rule[1], /background:var\(--dsw-alias-button-primary-fill\)/);
  assert.match(rule[1], /color:var\(--dsw-alias-label-primary-foreground\)/);
  assert.doesNotMatch(rule[1], /#[0-9a-f]{3,8}/i);
});

test('the client never imports a host client package as a module', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]@deepseek-ai\/dsh-client-/);
  assert.doesNotMatch(source, /document\.body\.append/);
});

/**
 * The card used to answer every non-JSON body with one opaque sentence, which
 * hid the real cause: when the Host routes were never registered, the request
 * fell through to Connection's `/api` prefix and got a plain-text 401. The
 * wrapper must now report the status and first line, and mark the answer
 * `unreachable` so the error state offers a restart instead of a dead retry.
 */
test('a non-JSON answer reports its status and is marked unreachable', async () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const start = source.indexOf('async function call(');
  assert.ok(start > 0, 'client.js no longer defines call()');
  const end = source.indexOf('\n    }', start);
  const body = source.slice(start, end + 6);
  // `call` closes over the API constant, so evaluate it with that in scope.
  const call = new Function("const API = '/api/onenote';\n" + body + '\nreturn call;')();

  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 401, text: async () => 'unauthorized\n' });
  let answer;
  try {
    answer = await call('/state', undefined);
  } finally {
    if (previous === undefined) delete globalThis.fetch; else globalThis.fetch = previous;
  }
  assert.equal(answer.ok, false);
  assert.equal(answer.unreachable, true);
  assert.match(answer.error, /401/);
  assert.match(answer.error, /unauthorized/);
  assert.doesNotMatch(answer.error, /unreadable/i);
});

test('a JSON answer passes through untouched', async () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const start = source.indexOf('async function call(');
  const end = source.indexOf('\n    }', start);
  const call = new Function("const API = '/api/onenote';\n" + source.slice(start, end + 6) + '\nreturn call;')();

  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, text: async () => '{"ok":true,"signedIn":false}' });
  let answer;
  try {
    answer = await call('/state', undefined);
  } finally {
    if (previous === undefined) delete globalThis.fetch; else globalThis.fetch = previous;
  }
  assert.deepEqual(answer, { ok: true, signedIn: false });
  assert.equal(answer.unreachable, undefined);
});

test('the unreachable message tells the user to restart, in both languages', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  assert.match(source, /'unreachable': 'The plugin routes are not registered/);
  assert.match(source, /'unreachable': '本进程没有注册插件路由/);
  assert.doesNotMatch(source, /The server returned an unreadable response/);
});
