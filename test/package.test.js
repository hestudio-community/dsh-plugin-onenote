import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the manifest points at files that exist', () => {
  assert.equal(manifest.name, 'dsh-plugin-onenote');
  assert.equal(manifest.type, 'module');
  for (const target of Object.values(manifest.exports)) {
    if (typeof target !== 'string') continue;
    if (target.includes('*')) continue;
    assert.ok(existsSync(join(root, target)), `missing export target: ${target}`);
  }
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(existsSync(join(root, manifest.dsh.bundle.patch)));
});

test('the client declaration matches a real bundle export', () => {
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.ok(existsSync(join(root, 'client.js')));
  const source = readFileSync(join(root, 'client.js'), 'utf8');
  // The loader id must equal the package name, or the bundle never activates.
  assert.match(source, new RegExp(`id:\\s*'${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
});

test('every file the bundle patch names is publishable', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  const match = patch.match(/name:\s*'([^']+)'/);
  assert.ok(match !== null, 'the patch names no plugin');
  assert.equal(match[1], manifest.name);
  // `files` must cover the runtime modules, the patch, and the display resources.
  for (const needed of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(manifest.files.includes(needed), `files is missing ${needed}`);
  }
  assert.ok(manifest.files.includes('src/*.js'));
  assert.ok(manifest.files.includes('locale/*.json'));
});

test('the DSH version requirement is declared where the manager reads it', () => {
  assert.equal(typeof manifest.engines.dsh, 'string');
  assert.match(manifest.engines.dsh, />=|\^/);
});

test('the DSH ranges admit prerelease builds of the supported line', () => {
  // node-semver only lets a prerelease version satisfy a range when a
  // comparator on the same major.minor.patch tuple also carries a prerelease
  // tag. `^0.2.0-0` therefore dropped every 0.2.1-rc build — the harness line
  // users actually run — and npm answered with ERESOLVE. The explicit branches
  // are the fix; pinning them here keeps a later "tidy-up" from reinstating it.
  const range = '>=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-0 <0.3.0-0';
  assert.equal(manifest.engines.dsh, range);
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], range);
  // Nothing imports cordis; an unused peer is one more range that can drift.
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], undefined);
});

test('both locale files carry the metadata the plugin list renders', () => {
  for (const locale of ['en', 'zh']) {
    const dict = JSON.parse(readFileSync(join(root, 'locale', `${locale}.json`), 'utf8'));
    assert.equal(typeof dict.meta.title, 'string', locale);
    assert.ok(dict.meta.title.length > 0, locale);
    assert.equal(typeof dict.meta.description, 'string', locale);
    assert.ok(dict.meta.description.length > 20, locale);
  }
});

test('the icon is a parseable SVG within the size limit', () => {
  const path = join(root, 'icon.svg');
  const bytes = readFileSync(path);
  assert.ok(bytes.byteLength <= 256 * 1024, 'icon exceeds 256 KiB');
  const text = bytes.toString('utf8');
  assert.match(text, /^<svg\s/);
  assert.match(text, /viewBox="0 0 \d+ \d+"/);
});

test('the storefront tile is a square 180px PNG that ships', () => {
  // The awesome-dsh-plugin listing refuses SVG tiles, so its `icon:` points at
  // this render of icon.svg instead. Dropping the file, the export, or the
  // `files` pattern breaks the storefront tile while every other check passes.
  const path = join(root, 'assets', 'icon-180.png');
  assert.ok(existsSync(path), 'assets/icon-180.png is missing');
  const bytes = readFileSync(path);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'not a PNG',
  );
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  assert.equal(bytes.readUInt32BE(16), 180);
  assert.equal(bytes.readUInt32BE(20), 180);
  assert.ok(bytes.byteLength <= 256 * 1024, 'tile exceeds 256 KiB');
  assert.equal(manifest.exports['./icon-180'], './assets/icon-180.png');
  assert.ok(manifest.files.includes('assets/*.png'), 'files would drop the tile');
});

test('the repository, homepage, and bugs point at the same project', () => {
  assert.match(manifest.repository.url, /github\.com\/hestudio-community\/dsh-plugin-onenote/);
  assert.match(manifest.homepage, /github\.com\/hestudio-community\/dsh-plugin-onenote/);
  assert.match(manifest.bugs.url, /github\.com\/hestudio-community\/dsh-plugin-onenote/);
  assert.equal(manifest.license, 'MIT');
  assert.ok(existsSync(join(root, 'LICENSE')));
});

test('the package is publishable rather than private', () => {
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.publishConfig.access, 'public');
});
