# Publishing

This document covers versioning, the release process, and what the published
package contains. It assumes the repository is `hestudio-community/dsh-plugin-onenote`.

## 1. Versioning

Semantic Versioning applies to the following public surface. A change to any of
it is at least a **minor** bump; a removal or an incompatible rename is a
**major** bump.

| Surface | Detail |
| --- | --- |
| Package name | `dsh-plugin-onenote` |
| Host row id | `onenote` |
| Tool names and parameters | `onenote_status`, `onenote_list_pages`, `onenote_search`, `onenote_read_page` |
| Route paths and JSON shapes | `/api/onenote/state`, `/device-code/start`, `/device-code`, `/notebooks`, `/sign-out` |
| Config fields | `clientId`, `tenant`, `maxPagesPerList`, `maxPageChars` |
| On-disk state | `tokens.json`, `signin.json`, `settings.json` under `$DSH_HOME/onenote/` |
| Client contract | The bundle id and the `plugins.bundle.config` key |

Internal refactors, comment changes, and test additions are **patch** bumps.

The version lives in `package.json` only. It is not duplicated in source; the
card does not display it.

### Peer and engine ranges

`engines.dsh` and the `@deepseek-ai/dsh-tools` peer must carry the **same**
range, and that range must spell an explicit prerelease branch for every DSH
line the package supports:

```text
>=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-0 <0.3.0-0
```

node-semver only lets a prerelease version satisfy a range when some comparator
on the *same* `major.minor.patch` tuple also carries a prerelease tag. A
broad-looking `^0.2.0-0` therefore matches `0.2.0-rc.x` and `0.2.1` but
silently drops every `0.2.1-rc.x` build — the line the harness actually ships.
When both are installed npm answers with `ERESOLVE`, and the user has to retry
with `--legacy-peer-deps`.

To support a new DSH line, append its branch instead of widening the existing
one — for example `|| >=0.2.2-0 <0.3.0-0` once 0.2.2 prereleases appear. The
manifest test `the DSH ranges admit prerelease builds of the supported line`
pins both fields and the absence of the unused peer below.

`@deepseek-ai/cordis` is deliberately **not** declared. No Host module imports
it: the framework is injected by the loader, not resolved by this package. An
unused peer is one more range that can conflict with the harness's own
prerelease versions, so declaring it only adds a failure mode.

## 2. Pre-release checklist

Run these in order and do not skip a failure:

1. `npm test` — all suites green.
2. `npm run pack:check` — the file list matches section 4 below.
3. `git status` — the working tree is clean apart from the intended change.
4. Confirm `AGENTS.md`, this document, and any affected `docs/developer/*.md`
   were updated in the same change.
5. Confirm the settings card was rendered once in the running app if the change
   touched `client.js`.

## 3. Release

There is no release automation. The repository has no `.github/workflows/`, so
pushing a tag publishes nothing and creates no release. A maintainer cuts the
release by hand on a clean checkout of `main`, in this order:

1. Run the pre-release checklist in section 2; stop on the first failure.
2. Bump the version: `npm version minor`, or `patch`/`major` as section 1
   demands. This writes `package.json`, commits, and creates the `v<version>`
   tag.
3. Publish: `npm publish --access public`.
4. Push the commit and the tag: `git push --follow-tags`.

The maintainer must be authenticated against npm before step 3: run
`npm login`, or export `NPM_TOKEN` with a token that has publish rights for the
package; npm reads that variable automatically.

`--provenance` is not used. It makes npm sign an attestation with the CI
provider's OIDC identity, which a local publish does not have, so
`npm publish --provenance` fails with a usage error off CI. The published tarball
therefore carries no provenance attestation, and the npm package page shows none.

If a review must happen before the tag exists, run
`npm version --no-git-tag-version`, commit through the normal process, tag the
reviewed commit with `git tag v<version>`, and continue from step 3.

The GitHub release is optional and created by hand: open the repository's
Releases page, pick the pushed tag, and use *Generate release notes*. No step
above creates it.

## 4. Packaged contents

`npm pack --dry-run` currently reports 20 files. `package.json` `files` controls
the list; every runtime module and every display resource must appear.

```text
LICENSE
README.md
README.zh.md
assets/icon-180.png
client.js
cordis.patch.yml
icon.svg
index.js
locale/en.json
locale/zh.json
package.json
src/auth.js
src/config.js
src/graph-client.js
src/parser.js
src/permissions.js
src/routes.js
src/service.js
src/state.js
src/tools.js
```

Deliberately excluded: `test/`, `docs/`, `AGENTS.md`, `.gitignore`.
`package.json` is always included by npm regardless of `files`.

Two additions are required when a new file is created:

- a new Host module must be covered by `src/*.js`, which the current pattern
  already does;
- a new top-level asset must be added to `files` explicitly, or it will not ship.
  The existing `assets/*.png` pattern covers the storefront tile.

### Storefront tile

`assets/icon-180.png` is a 180×180 PNG render of `icon.svg`, and it exists for
one consumer: the `awesome-dsh-plugin` listing. That list refuses SVG tiles and
third-party image hosts, so its entry points at

```text
https://raw.githubusercontent.com/hestudio-community/dsh-plugin-onenote/main/assets/icon-180.png
```

The tile is drawn at roughly 96 px, so a square image is what works; 180 px
leaves headroom for high-density screens. It carries an alpha channel, because
the storefront background is not the icon's purple.

Regenerate it whenever `icon.svg` changes. The render is done with `sharp`
(libvips/librsvg) in a temporary directory, never from a dependency of this
package:

```bash
mkdir -p /tmp/svgtool && cd /tmp/svgtool && npm init -y
npm install sharp
node -e "import('sharp').then(async ({default: sharp}) => {
  await sharp('<repo>/icon.svg', { density: 270 })
    .resize(180, 180, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 }).toFile('<repo>/assets/icon-180.png');
})"
```

`density: 270` is `72 × 180 / 48`, the source `viewBox` being 48 px. The tile is
pinned by `the storefront tile is a square 180px PNG that ships` in
`test/package.test.js`; that test fails if the file disappears, stops being a
180×180 PNG, or drops out of `exports` or `files`.

## 5. Installing from the repository

A user can install without a registry:

```bash
dsh plugin install hestudio-community/dsh-plugin-onenote
```

The plugin manager accepts a git spec, clones it, and links the package. A local
checkout installs the same way:

```bash
dsh plugin install /absolute/path/to/dsh-plugin-onenote
```

Either form appends the bundle to the profile and inserts the `onenote` row. The
result to look for is `application: applied` with no warnings.

## 6. After installing

`~/.dsh/onenote/` is created on first use, not at install time. A fresh install
therefore starts signed out with an empty allow-list, which is the intended
default: nothing is readable until the user acts.

To reset the plugin completely, stop the harness and delete that directory.

## 7. Uninstalling

```bash
dsh plugin uninstall dsh-plugin-onenote
```

The bundle and its row are removed. `~/.dsh/onenote/` is **not** removed
automatically, so a reinstall keeps the previous sign-in. Delete it by hand to
leave no trace.

## 8. Known environment constraint

On the development machine used for this repository, `~/.npm` is owned by root,
so `npm pack`, `npm view`, and `npm publish` fail with `EPERM` unless the cache
directory is overridden:

```bash
npm_config_cache=/tmp/npmcache npm pack --dry-run
```

That is a local filesystem problem, not a package problem. Publishing is
therefore expected to happen after
`sudo chown -R $(id -u):$(id -g) ~/.npm`; there is no CI to publish from.
