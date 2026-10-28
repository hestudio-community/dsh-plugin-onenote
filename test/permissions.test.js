import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Each test gets its own `$DSH_HOME`, because the modules read it on every call.
 * The env var is set before the first import of `state.js` inside each test.
 */
function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'onenote-test-'));
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

const load = () => import('../src/permissions.js');
const loadState = () => import('../src/state.js');

test('an empty allow-list denies everything', () => withHome(async () => {
  const perms = await load();
  perms.clearAllowedNotebooks();
  assert.equal(perms.hasConsent(), false);
  assert.equal(perms.isNotebookAllowed('NB-1'), false);
  assert.throws(() => perms.assertNotebookAllowed('NB-1', 'Work'), /not in the allowed list/);
}));

test('stores names, dedupes case-insensitively, and drops empty ids', () => withHome(async () => {
  const perms = await load();
  const stored = perms.setAllowedNotebooks([
    { id: 'NB-1', name: 'Work' },
    { id: 'nb-1', name: 'duplicate' },
    { id: '   ', name: 'blank' },
    { id: 'NB-2' },
  ]);
  assert.deepEqual(stored, [
    { id: 'NB-1', name: 'Work' },
    { id: 'NB-2', name: 'NB-2' },
  ]);
  assert.deepEqual(perms.allowedNotebooks(), stored);
  assert.equal(perms.hasConsent(), true);
}));

test('matching is case-insensitive and tolerates percent-encoding', () => withHome(async () => {
  const perms = await load();
  perms.setAllowedNotebooks([{ id: '1-ABC-DEF', name: 'Work' }]);
  assert.equal(perms.isNotebookAllowed('1-abc-def'), true);
  assert.equal(perms.isNotebookAllowed('1-ABC-DEF'), true);
  assert.equal(perms.isNotebookAllowed('1%2DABC%2DDEF'), true);
  assert.equal(perms.isNotebookAllowed('1-ABC-XXX'), false);
}));

test('the denial carries the recovery step', () => withHome(async () => {
  const perms = await load();
  perms.setAllowedNotebooks([{ id: 'NB-1', name: 'Work' }]);
  try {
    perms.assertNotebookAllowed('NB-SECRET', 'Private');
    assert.fail('expected a denial');
  } catch (error) {
    assert.equal(error.code, 'NOTEBOOK_NOT_ALLOWED');
    assert.match(error.message, /Private/);
    assert.match(error.message, /Settings/);
  }
}));

test('clearing removes consent but keeps the file readable', () => withHome(async () => {
  const perms = await load();
  perms.setAllowedNotebooks([{ id: 'NB-1', name: 'Work' }]);
  perms.clearAllowedNotebooks();
  assert.deepEqual(perms.allowedNotebooks(), []);
  assert.equal(perms.hasConsent(), false);
}));

test('state is written under $DSH_HOME/onenote with private permissions', () => withHome(async () => {
  const perms = await load();
  const state = await loadState();
  perms.setAllowedNotebooks([{ id: 'NB-1', name: 'Work' }]);
  assert.equal(state.dataDir(), join(process.env.DSH_HOME, 'onenote'));
  const { statSync } = await import('node:fs');
  const mode = statSync(join(state.dataDir(), 'settings.json')).mode & 0o777;
  assert.equal(mode, 0o600);
}));

test('tokens round-trip and an empty file reads as signed out', () => withHome(async () => {
  const state = await loadState();
  assert.equal(state.readTokens(), undefined);
  state.writeTokens({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 123, scope: 's', account: { displayName: 'A' } });
  const tokens = state.readTokens();
  assert.equal(tokens.accessToken, 'AT');
  assert.equal(tokens.refreshToken, 'RT');
  assert.equal(tokens.expiresAt, 123);
  state.clearTokens();
  assert.equal(state.readTokens(), undefined);
}));

test('an expired pending sign-in is not returned', () => withHome(async () => {
  const state = await loadState();
  state.writePendingSignIn({ deviceCode: 'D', userCode: 'U', expiresAt: Date.now() - 1000 });
  assert.equal(state.readPendingSignIn(), undefined);
  state.writePendingSignIn({ deviceCode: 'D', userCode: 'U', expiresAt: Date.now() + 60000 });
  assert.equal(state.readPendingSignIn().userCode, 'U');
  state.clearPendingSignIn();
  assert.equal(state.readPendingSignIn(), undefined);
}));
