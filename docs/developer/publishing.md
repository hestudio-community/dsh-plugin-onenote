# Publishing

This document covers versioning, the release workflow, and what the published
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

## 2. Pre-release checklist

Run these in order and do not skip a failure:

1. `npm test` — all suites green.
2. `npm run pack:check` — the file list matches section 4 below.
3. `git status` — the working tree is clean apart from the intended change.
4. Confirm `AGENTS.md`, this document, and any affected `docs/developer/*.md`
   were updated in the same change.
5. Confirm the settings card was rendered once in the running app if the change
   touched `client.js`.

## 3. Release workflow

Releases are cut from a tag. `.github/workflows/release.yml` runs on `v*` and:

1. runs `npm test`;
2. publishes with `npm publish --access public --provenance`;
3. creates a GitHub release with generated notes.

`--provenance` publishes a signed attestation linking the tarball to the commit
and the workflow run. It requires the `id-token: write` permission, which the
workflow grants.

The publish step needs a repository secret named `NPM_TOKEN`: an npm automation
token with publish rights for the package.

Manual release:

```bash
npm version minor          # bumps package.json, commits, and tags
git push --follow-tags
```

`npm version` creates the commit and the tag itself. If the project's commit
policy requires a review before tagging, run it with `--no-git-tag-version`,
commit through the normal process, and tag afterwards.

## 4. Packaged contents

`npm pack --dry-run` currently reports 19 files. `package.json` `files` controls
the list; every runtime module and every display resource must appear.

```text
LICENSE
README.md
README.zh.md
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

Deliberately excluded: `test/`, `docs/`, `AGENTS.md`, `.github/`, `.gitignore`.
`package.json` is always included by npm regardless of `files`.

Two additions are required when a new file is created:

- a new Host module must be covered by `src/*.js`, which the current pattern
  already does;
- a new top-level asset must be added to `files` explicitly, or it will not ship.

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
therefore expected to happen either from CI or after
`sudo chown -R $(id -u):$(id -g) ~/.npm`.
