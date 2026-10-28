# Testing

This document describes how the suite is organized, why it can run without an
installed harness, and how to add a case.

## 1. Running

```bash
npm test              # 97 tests
npm run test:watch    # watch mode
```

`npm test` expands to:

```bash
node --import ./test/support/stub-tools.mjs --test "test/*.test.js"
```

Requirements: Node `>=22`. No network, no installed DSH, no `npm install`. The
package has zero runtime dependencies, and the one host-provided peer is stubbed.

The explicit `test/*.test.js` glob is required, not decorative. A bare
`node --test` also executes every `.mjs` file under `test/` as a test file:
`test/support/stub-tools.mjs`, `test/support/define-tool-stub.mjs`, and
`test/support/schema.js` are each counted as a passing entry, so the run reports
100 tests instead of 97 and hides which files actually contain suites. Those
helpers are fixtures, not suites; a helper that threw while being imported would
turn the run red for no reason. The glob keeps the count honest and the helpers
out of the runner.

## 2. Why a peer stub is necessary

`src/tools.js` imports `defineTool` from `@deepseek-ai/dsh-tools`. That package is
supplied by the running harness, not by this package, so a bare checkout cannot
resolve it.

`test/support/stub-tools.mjs` installs a Node module-resolution hook that
redirects exactly that one specifier to `test/support/define-tool-stub.mjs`.
Every other import resolves normally. The stub mirrors the observable contract:
it compiles the author-facing parameter map into JSON Schema and validates
required arguments before calling the body.

The stub is a test fixture. It must never be imported by shipped code, and it is
excluded from the published package by `files`.

## 3. Layout

| File | Covers | Tests |
| --- | --- | --- |
| `test/parser.test.js` | HTML → Markdown: headings, lists, tables, code, links, entities, truncation, malformed input, and void elements inside `<head>`. | 17 |
| `test/permissions.test.js` | Allow-list storage, id normalization, denial messages, state files and their mode. | 8 |
| `test/config.test.js` | Defaults, validation, warnings, clamping, non-object input. | 6 |
| `test/service.test.js` | Every operation against a mocked Graph: sign-in, polling, token lapse, consent, browse, search, read, refusals, the `$expand` shape, and the OData rejection path. | 22 |
| `test/routes.test.js` | The five HTTP routes against a fake request/response pair. | 11 |
| `test/tools.test.js` | The four tool definitions, their argument mapping, and their renderers. | 10 |
| `test/schema.test.js` | Every output schema and every real result against the host's JSON Schema subset. | 4 |
| `test/client.test.js` | The browser bundle: loader contract, slot registration, dictionaries, theme tokens. | 11 |
| `test/package.test.js` | Manifest integrity: exports, `files`, `engines`, locale metadata, icon, repository URLs. | 8 |

Support files:

| File | Purpose |
| --- | --- |
| `test/support/stub-tools.mjs` | The resolution hook. |
| `test/support/define-tool-stub.mjs` | The `defineTool` stand-in. |
| `test/support/schema.js` | A checker for the host's enforced JSON Schema subset. |

## 4. Isolation rules

Tests never touch the real harness home. Every suite that persists anything sets
`DSH_HOME` to a fresh temporary directory and removes it afterwards:

```js
function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'onenote-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return Promise.resolve().then(run).finally(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
}
```

`src/state.js` resolves `dataDir()` on every call rather than at import time,
which is what makes this work.

Tests never call the network. Graph is replaced by assigning `globalThis.fetch`;
the replacement routes on `new URL(url).pathname` and `searchParams` so query
strings are exercised for real rather than matched as substrings.

## 5. The schema subset

DSH enforces a strict subset for tool output schemas. A schema outside it fails
at registration, not at first call. `test/support/schema.js` reimplements the
subset so a mistake fails in CI:

- allowed keywords: `type`, `oneOf`, `properties`, `required`,
  `additionalProperties`, `items`, `enum`, `const`;
- annotations: `description`, `title`, `default`, `examples`;
- `type` must be a single string from
  `object/array/string/number/integer/boolean/null`;
- an `object` must state `additionalProperties` explicitly;
- `required` must name properties that exist;
- `type` and `oneOf` are mutually exclusive.

`test/schema.test.js` runs two checks: every declared schema is inside the
subset, and every result produced by a live service call validates against its
own schema. The second check is the important one: the host snapshots a result as
lossless JSON, so a single `undefined` property would fail at runtime. All
results are built through a `compact()` helper that drops undefined fields.

## 6. Adding a test

1. Name the file `<module>.test.js` in `test/`.
2. Import the module directly with a relative path.
3. If the case persists state, wrap it in `withHome`.
4. If the case reaches Graph, assign `globalThis.fetch` first and route on the
   parsed URL.
5. Assert on observable behavior and on the message a user would read, not on
   internal call order.
6. Run `npm test`; the count in `AGENTS.md` and this document must be updated in
   the same change.

## 7. What the suite does not cover

| Gap | Why | How to check manually |
| --- | --- | --- |
| The card's visual result | No browser in CI. | Open *Settings → Plugins → OneNote*. |
| A real Graph round trip | No credentials in CI. | Sign in once in the running app. |
| Token refresh against the live endpoint | Same. | Let a token expire, then read a page. |
| Graph's real OData parser | The fake Graph models the one rejection that matters (a nested `select` in `$expand`), not the whole grammar. | Call `onenote_read_page` on a real page; a 400 with *Parsing OData Select and Expand failed* means an `$expand` gained a nested `select`. |
| Installation into a profile | Requires a harness. | `dsh plugin install <path>` and confirm the row activates. |

The last row matters: `application: applied` from the plugin manager is the
authoritative signal that a change is live, and it is not reproducible in a unit
test.

The fourth row is why the fake Graph now rejects a nested `select` in `$expand`
with the same 400 body the live service returns. Until it did, the fake returned
the parent objects whatever the query said, so a malformed `$expand` passed all
95 tests and failed every read on a real account. The suite still asserts the
*shape* of `$expand` (`page queries expand the parent without a nested select`)
so a failure names the defect instead of only reporting a 400.

A `Host` change is live only after DeepSeek Harness restarts. The profile links
the package (`link:/path/to/dsh-plugin-onenote`), so no reinstall is needed, but
Node caches the modules: the running process keeps the module it imported, so a
test that passes in the repository can still fail in a running session. This was
measured, not assumed: an edit to `src/tools.js` was still absent from a live
tool answer several minutes after it was written.
