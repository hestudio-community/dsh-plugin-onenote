import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';
import { DEFAULT_CLIENT_ID } from '../src/state.js';

test('defaults to the bundled client and the multi-tenant endpoint', () => {
  const config = resolveConfig({});
  assert.equal(config.clientId, DEFAULT_CLIENT_ID);
  assert.equal(config.tenant, 'common');
  assert.equal(config.maxPagesPerList, 100);
  assert.equal(config.maxPageChars, 60000);
});

test('accepts a custom client id and tenant', () => {
  const config = resolveConfig({ clientId: '11111111-2222-3333-4444-555555555555', tenant: 'contoso.onmicrosoft.com' });
  assert.equal(config.clientId, '11111111-2222-3333-4444-555555555555');
  assert.equal(config.tenant, 'contoso.onmicrosoft.com');
});

test('rejects a malformed client id and warns once', () => {
  const warnings = [];
  const config = resolveConfig({ clientId: 'not-a-guid' }, { warn: (m) => warnings.push(m) });
  assert.equal(config.clientId, DEFAULT_CLIENT_ID);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /clientId/);
});

test('rejects a tenant with URL metacharacters', () => {
  const warnings = [];
  const config = resolveConfig({ tenant: 'a/b?c' }, { warn: (m) => warnings.push(m) });
  assert.equal(config.tenant, 'common');
  assert.match(warnings[0], /tenant/);
});

test('clamps numeric limits instead of trusting them', () => {
  assert.equal(resolveConfig({ maxPagesPerList: 0 }).maxPagesPerList, 25);
  assert.equal(resolveConfig({ maxPagesPerList: 1e9 }).maxPagesPerList, 200);
  assert.equal(resolveConfig({ maxPageChars: 1 }).maxPageChars, 4000);
  assert.equal(resolveConfig({ maxPageChars: 1e9 }).maxPageChars, 200000);
  assert.equal(resolveConfig({ maxPageChars: 'wide' }).maxPageChars, 60000);
});

test('a non-object config falls back to defaults without throwing', () => {
  for (const raw of [null, undefined, 'x', 42, []]) {
    const config = resolveConfig(raw);
    assert.equal(config.clientId, DEFAULT_CLIENT_ID);
    assert.equal(config.tenant, 'common');
  }
});
