# AGENTS.md

Instructions for AI agents working in this repository. Read this file before
changing anything. It is deliberately short: the reasoning behind each rule and
every implementation detail live in `docs/developer/`.

---

## Overview

`dsh-plugin-onenote` is a DeepSeek Harness (DSH) bundle that lets an agent read
Microsoft OneNote notebooks **the user explicitly allowed**. It has two halves:

- a **Host half** (Node) that registers four read-only agent tools, five HTTP
  routes, and one system-prompt section;
- a **Client half** (browser) that renders the settings card in
  *Settings → Plugins → OneNote*, which is the only surface where a person can
  sign in or change the readable-notebook allow-list.

The product invariant is a privacy boundary: no agent tool can widen its own
read scope, and every read resolves the owning notebook and checks the allow-list
before any Microsoft Graph request.

| Fact | Value |
| --- | --- |
| Package name | `dsh-plugin-onenote` |
| Version | `0.2.1` |
| License | MIT |
| Runtime | Node `>=22`, DSH `>=0.2.0-rc.1` |
| Runtime dependencies | none |
| Host peers | `@deepseek-ai/dsh-tools`, `@deepseek-ai/cordis` (both optional) |
| Build step | none — the client bundle is hand-written |
| Test command | `npm test` (97 tests) |

## Project Structure

```text
.
├── AGENTS.md                  # this file: rules and orientation
├── README.md                  # user-facing documentation (English)
├── README.zh.md               # user-facing documentation (Chinese)
├── LICENSE                    # MIT
├── package.json               # manifest: exports, dsh.bundle, dsh.client, engines
├── cordis.patch.yml           # bundle patch: inserts the `onenote` Host row
├── index.js                   # Host entry: apply(ctx, config)
├── client.js                  # Client bundle: window.__ModuleLoader__.load(...)
├── icon.svg                   # plugin icon shown in the plugin list
├── locale/
│   ├── en.json                # plugin-list metadata (English)
│   └── zh.json                # plugin-list metadata (Chinese)
├── src/                       # Host modules, one responsibility per file
│   ├── config.js              # config resolution and validation
│   ├── state.js               # $DSH_HOME/onenote persistence (tokens, consent)
│   ├── auth.js                # OAuth 2.0 device-code flow and token refresh
│   ├── graph-client.js        # Microsoft Graph HTTP calls and error mapping
│   ├── permissions.js         # allow-list and the consent guard
│   ├── parser.js              # OneNote HTML → Markdown
│   ├── service.js             # the single implementation of every operation
│   ├── routes.js              # /api/onenote/* routes for the settings card
│   └── tools.js               # the four read-only agent tools
├── test/                      # node:test suites; see docs/developer/testing.md
│   ├── *.test.js
│   └── support/               # test-only helpers, never shipped
└── docs/developer/            # engineering documentation
```

## Module Placement Rules

Place new code by responsibility, not by convenience.

1. **A new Microsoft Graph endpoint** goes in `src/graph-client.js` only. It
   returns plain data; it never checks consent and never throws a bare error —
   it maps failures to `GraphError` or `OneNoteAuthError`.
2. **A new operation** goes in `src/service.js` as one method on the object
   returned by `createOneNoteService`. Both the tools and the routes must call
   that method. Never implement an operation twice.
3. **A new consent check** goes in `src/permissions.js`. Callers use
   `assertNotebookAllowed`; they must not compare ids themselves.
4. **A new agent tool** goes in `src/tools.js`. It must be read-only, must call
   the service, and must not accept an argument that widens consent.
5. **A new browser route** goes in `src/routes.js` and is registered through
   `ctx.effect`. It answers JSON and never throws. Routes are mounted from
   `ctx.inject(['webServer'], ...)` in `index.js`, never from a one-shot
   `ctx.get('webServer')` in `apply`: the Loader starts rows concurrently, so
   the strict read answers `undefined` while the `webserver` row is still
   LOADING and every route is silently dropped. That regression is pinned by
   `apply mounts the routes from a webServer dependency callback` in
   `test/routes.test.js`.
6. **A new piece of persisted state** goes in `src/state.js`. It lives under
   `$DSH_HOME/onenote/`, is written atomically, and is created mode `0600`.
7. **A new user-visible string in the card** goes in the `en` and `zh`
   dictionaries inside `client.js`. Both must declare the same keys.
8. **A new tunable** becomes a field of the plugin `Config` resolved in
   `src/config.js`, with a documented default and a clamp.
9. **A new dependency** requires justification in the pull request. The default
   answer is no: this package has zero runtime dependencies by design.
10. **A new test** goes in `test/` and must be named `*.test.js` so
    `node --test` discovers it.

## Graph and Parser Rules

These two are not style preferences: getting them wrong broke every read on a
live account while the whole suite still passed.

1. **`$expand` never carries a nested `select`.** OneNote rejects
   `$expand=parentNotebook(select=id,displayName)` with a 400 *Parsing OData
   Select and Expand failed*. Write `$expand=parentSection,parentNotebook`; the
   bare expansion already returns the parent's `id` and `displayName`.
   `PAGE_EXPAND` in `src/graph-client.js` is the only place that spells it, and
   `page queries expand the parent without a nested select` in
   `test/service.test.js` pins it. `getSectionMeta` spells its own `$expand`
   (`parentNotebook`) and needs its own case. The fake Graph rejects a nested
   `select` with the live 400 body, so this now fails locally; it used to pass
   every test and fail every live read.
2. **A void element never opens a scope in `src/parser.js`.** `meta`, `link`,
   `br`, `img`, and their siblings have no closing tag, so incrementing
   `skipDepth` for one leaks the skip to the end of the document. OneNote puts a
   self-closing `<meta />` in every page's `<head>`; treating it as open
   rendered every page as an empty string. `VOID_TAGS` holds the list, and
   `keeps the body of a page whose head contains void elements` pins it.

A fixture that is a bare `<p>` cannot catch either bug. When changing either
path, test with a full `<html><head>…</head><body>…</body></html>` document, and
confirm once against the live account. The fake Graph now rejects a nested
`select`, but it models no other part of OData's grammar, so a passing suite is
still not proof that Microsoft will accept the query.

A Host change reaches a running session only after DeepSeek Harness restarts.
The profile links this package, so no reinstall is needed, and editing a Host
module does not change a session that is already running: the process keeps the
module it imported, which was measured as an edit still invisible several
minutes later.

## Reference Documents

| Document | Contents |
| --- | --- |
| [docs/developer/architecture.md](docs/developer/architecture.md) | Runtime composition, the Host/Client split, request and data flow, lifecycle. |
| [docs/developer/security-model.md](docs/developer/security-model.md) | The consent boundary, the threat model, and why authorization is user-only. |
| [docs/developer/microsoft-graph.md](docs/developer/microsoft-graph.md) | Endpoints used, the device-code flow, scopes, and Graph's known limits. |
| [docs/developer/settings-card.md](docs/developer/settings-card.md) | The client bundle contract, slot registration, locale, theme tokens, route contract. |
| [docs/developer/testing.md](docs/developer/testing.md) | The test harness, the peer stub, the schema subset, and how to add a suite. |
| [docs/developer/publishing.md](docs/developer/publishing.md) | Versioning, the manual release process, npm publishing, and the packaged file list. |
| [README.md](README.md) / [README.zh.md](README.zh.md) | End-user documentation: install, Azure app registration, configuration. |

## AI Notes Policy

These rules bind every AI agent in this repository. They override convenience.

1. **Never commit or stage without an explicit instruction.** The only phrases
   that authorize a commit are the user saying *"commit it"* (or an unambiguous
   equivalent in their language). Nothing else authorizes staging or committing.
   *(Rule 8, Rule 10)*
2. **"commit it" authorizes exactly one operation**: format and audit the code,
   then `git add --all`, then one commit with a Conventional Commits message.
   It does not authorize a push, a tag, a version bump, or a second commit.
   *(Rule 6)*
3. **"sync" means synchronize rules.** On that word, immediately write every
   rule agreed in the current conversation into `AGENTS.md` or the matching
   `docs/developer/*.md`, then report the complete current rule set back to the
   user. *(Rule 7)*
4. **Never touch committed history.** Do not amend, rebase, reset, revert, or
   force-push an existing commit without explicit user consent. *(Rule 11)*
5. **Never stage code the user has not reviewed.** If you produced a change in
   this session, the user is presumed to have reviewed only what they can see;
   when in doubt, ask before staging. *(Rule 10)*
6. **Synchronize documentation with code, immediately.** Any behavioral change,
   configuration change, new module, new route, new tool, or new rule must be
   reflected in `AGENTS.md` or `docs/developer/*.md` in the same piece of work,
   not afterwards. *(Rule 9)*
7. **Never write throwaway files into the repository.** No scratch tests, no
   vendored reference code, no per-task Markdown files such as `task1-1.md`.
   Build caches and files the user explicitly asked for are exempt. Use the
   system temporary directory for scratch work. *(Rule 14)*
8. **Keep the repository normalized.** File naming, directory layout, commit
   messages, version numbers, and formatting must stay consistent with the
   conventions below. If the user requests an exception, record that exception
   in this file in the same change. *(Rule 13)*
9. **Documentation is English.** `AGENTS.md` and everything under
   `docs/developer/` are written in English. `README.zh.md` is the only
   intentionally localized engineering document; the in-app card is localized
   through the `en`/`zh` dictionaries in `client.js`.
10. **Be precise.** Documentation must be complete, professional, and
    unambiguous: state the default, the allowed range, the failure mode, and the
    recovery step. Do not write "should work" or "probably".

## Dev Conventions

### Code

- ES modules only (`"type": "module"`). No CommonJS, no transpiler, no bundler.
- Node built-ins are imported with the `node:` prefix.
- Two-space indentation, single quotes, semicolons, trailing commas in
  multi-line literals.
- Every exported function has a JSDoc block that states its parameters, its
  return value, and its failure mode.
- Comments explain *why* a decision was made. Never restate what the code says.
- User-facing failure messages name the next action, for example
  *"Open Settings → Plugins → OneNote and sign in."*
- A new behavior needs a test. A changed behavior needs its test updated.

### Naming

| Kind | Convention | Example |
| --- | --- | --- |
| Host module | lowercase, single word where possible | `parser.js` |
| Agent tool | `onenote_` prefix, snake_case | `onenote_read_page` |
| HTTP route | `/api/onenote/<resource>` | `/api/onenote/state` |
| Host row id | short, lowercase | `onenote` |
| CSS class | `dsh-onenote-` prefix, kebab-case | `dsh-onenote-item` |
| Test file | `<module>.test.js` | `service.test.js` |
| Doc file | kebab-case `.md` | `security-model.md` |

### Commits

Conventional Commits, one logical change per commit:

```text
<type>(<scope>): <imperative summary, lowercase, no trailing period>

<body: why the change was needed, wrapped at 72 columns>

<footer: BREAKING CHANGE: ..., refs>
```

Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`,
`chore`, `perf`. Scope is the module or area, for example `settings-card`,
`parser`, `release`. A breaking change to the tool surface, the route contract,
or the config schema requires `!` and a `BREAKING CHANGE:` footer.

### Versioning

Semantic Versioning. The public surface is: the package name, the four tool
names and their parameters, the `/api/onenote/*` route paths and JSON shapes, the
plugin `Config` fields, and the on-disk state files. A change to any of those is
at least a minor bump; a removal or an incompatible rename is a major bump.

### Git hygiene

- `main` is the only long-lived branch.
- Commit messages and code comments are English.
- `.gitignore` covers `node_modules/`, `.DS_Store`, `*.tgz`, `*.log`,
  `coverage/`, and `.plugin-manager/`.

## Build Scripts

There is no build step. `client.js` is loaded verbatim by the browser module
loader, and every Host module is loaded as-is by the DSH Loader.

| Command | Effect |
| --- | --- |
| `npm test` | Runs all suites with `node --test`, using `test/support/stub-tools.mjs` to stub the host-provided peer. Requires no network and no installed harness. |
| `npm run test:watch` | Same, in watch mode. |
| `npm run pack:check` | `npm pack --dry-run`: verifies the publishable file list. |

There is no CI configuration and no `.github/` directory: nothing runs on a push,
a pull request, or a tag. Every command above is run by hand on the machine that
cuts the release; section 2 of
[docs/developer/publishing.md](docs/developer/publishing.md) is the pre-release
checklist.

Local installation into a DSH profile:

```bash
dsh plugin install /absolute/path/to/dsh-plugin-onenote
```

See [docs/developer/publishing.md](docs/developer/publishing.md) for the release
process.
