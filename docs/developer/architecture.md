# Architecture

This document describes how `dsh-plugin-onenote` is composed at runtime, how the
two halves communicate, and where each responsibility lives. It is the reference
for anyone changing the plugin's structure.

## 1. The DSH composition model

DSH composes a running application from **rows**: named entries in a Loader
patch list. Each row names a package and an optional `config`. The Loader
imports the package and calls its exported `apply(ctx, config)` inside a Cordis
fiber. When the row is disabled or the profile unloads, everything the plugin
registered through `ctx.effect` is disposed.

This package is a **bundle**: a package whose `package.json` declares
`dsh.bundle.patch`. Installing it appends the bundle to the profile's bundle
list, and the bundle's patch inserts exactly one row:

```yaml
- insert:
    - id: onenote
      name: 'dsh-plugin-onenote'
      config:
        clientId: a2e9773e-e783-4e5c-83ff-8c627eec0e6e
        tenant: common
```

The `config` block is replaced wholesale by any later patch layer that targets
`id: onenote`; it is never deep-merged. A user who wants a different Azure app
registration must restate every field they need.

## 2. Two halves in one package

A DSH plugin may ship a Node half and a browser half in the same package. This
one does:

| Declaration | Value | Effect |
| --- | --- | --- |
| `exports["."]` | `./index.js` | The Host half the Loader imports. |
| `exports["./client"]` | `./client.js` | The browser bundle the Web page loads. |
| `dsh.client.platform` | `web` | The bundle targets the Web UI. |
| `dsh.client.inject` | `dsh-client-locale`, `dsh-client-ui-plugin-manager` | Activation ordering only; no module is imported from them. |

The browser bundle is discovered by the Host's client-module scanner, served
under a hashed URL, and executed by the page's module loader. Its registration
id must equal the package name, or the loader cannot match the bundle to its
row.

## 3. Host half: `index.js`

`index.js` is the composition root. Its whole job is wiring:

```js
export const name = 'onenote';
export const inject = ['tools'];

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig, { warn });
  const service = createOneNoteService(config);

  const disposers = registerTools(ctx, service);   // four read-only tools
  ctx.inject(['webServer'], (scoped) => {           // five /api/onenote/* routes
    installRoutes(scoped, service);                // mounted once the service is ACTIVE
  });
  const section = systemPrompt.section({ ... });   // one prompt paragraph
}
```

Three properties matter:

1. **One service instance.** `createOneNoteService(config)` is called once per
   activation and the same object is handed to both the tools and the routes.
   There is no second implementation of any operation.
2. **Everything is effect-owned.** Tool registrations are collected into a list
   and disposed from a single `ctx.effect`. Routes register inside their own
   `ctx.effect`. The prompt section returns its own disposer. Disabling the row
   therefore leaves nothing behind.
3. **`tools` is the only hard dependency; `webServer` is awaited, not probed.**
   The routes mount from `ctx.inject(['webServer'], ...)`, which pends until the
   service is ACTIVE and re-runs if it is replaced. A composition without a Web
   server still activates with working tools and one warning from
   `installRoutes`; the routes simply never mount.

   Do not replace that callback with a one-shot `ctx.get('webServer')` inside
   `apply`. The Loader starts every row concurrently and the `webserver` row
   stays LOADING while it binds its socket, so the strict read answers
   `undefined` and all five routes are dropped without a trace. The card then
   falls through to Connection's `/api` prefix, which answers a plain-text
   `401`, and it renders an error instead of the sign-in form. This is not
   hypothetical: it is the defect that
   `apply mounts the routes from a webServer dependency callback` in
   `test/routes.test.js` pins.

## 4. Module responsibilities

| Module | Owns | Must not |
| --- | --- | --- |
| `src/config.js` | Turning a raw `config` object into validated values with documented defaults and clamps. | Read state, call Graph, or throw on bad input. |
| `src/state.js` | Reading and writing `$DSH_HOME/onenote/*.json` atomically at mode `0600`. | Interpret business meaning or decide policy. |
| `src/auth.js` | The device-code flow, token storage, and refresh. | Know about notebooks or consent. |
| `src/graph-client.js` | Microsoft Graph HTTP calls and mapping failures to `GraphError` / `OneNoteAuthError`. | Check consent or render Markdown. |
| `src/permissions.js` | The allow-list and `assertNotebookAllowed`. | Perform I/O beyond reading the allow-list. |
| `src/parser.js` | OneNote HTML → Markdown, and HTML → plain text. | Fetch anything, including media. |
| `src/service.js` | Every operation, as one method each, with consent enforced inside. | Know about HTTP routes or tool schemas. |
| `src/routes.js` | The browser JSON contract. | Implement an operation itself. |
| `src/tools.js` | Tool schemas, descriptions, and argument mapping. | Implement an operation itself. |
| `client.js` | The settings card UI and its locale dictionaries. | Import a host client package or touch the DOM outside its component. |

The dependency direction is strictly one-way:

```text
tools.js ─┐
          ├─> service.js ─> permissions.js
routes.js ┘        │      └> graph-client.js ─> auth.js ─> state.js
                   └─> parser.js
```

Nothing imports `tools.js` or `routes.js`. `index.js` is the only module that
knows both exist.

## 5. Data flow

### 5.1 Sign-in

```text
card  ──POST /api/onenote/device-code/start──> routes.beginSignIn
                                                  │ service.beginSignIn
                                                  ├─ auth.startDeviceCode  (login.microsoftonline.com)
                                                  └─ state.writePendingSignIn
card  ──GET  /api/onenote/device-code (every 3 s)─> routes.pollSignIn
                                                  │ service.pollSignIn
                                                  ├─ auth.pollDeviceCodeOnce (one token request)
                                                  ├─ auth.writeTokens
                                                  └─ service.completeSignIn  (GET /me)
```

The attempt is persisted between the two calls because they are separate HTTP
requests. Polling performs exactly one token request and returns immediately, so
the card can show a live countdown instead of a stalled request.

### 5.2 Reading a page

```text
tool  ──> service.readPage
            ├─ graph.getPageMeta   (expands parentNotebook)
            ├─ permissions.assertNotebookAllowed(meta.notebookId)
            ├─ graph.getPageContent
            └─ parser.renderPage
```

The order is the security property: the owning notebook is resolved and checked
**before** content is fetched. `service.listPages` applies the same order for a
section id, which is why a guessed section id cannot reach an unapproved
notebook.

### 5.3 HTML rendering

`parser.renderPage` tokenizes the HTML OneNote returns; it never fetches media,
so an image contributes only its alt text.

One rule is load-bearing: a **void element** (`meta`, `link`, `br`, `img`, …)
must never open a scope. Every page Graph returns wraps its body in a `<head>`
containing a self-closing `<meta … />`, which has no closing tag. Counting that
as an open `meta` pushed the parser's `skipDepth` to 1 for the rest of the
document, so the rendered Markdown was the empty string for every real page
while the synthetic single-paragraph fixtures in the tests still passed. The
`VOID_TAGS` set in `src/parser.js` and the `keeps the body of a page whose head
contains void elements` test pin the behavior.

### 5.4 Changing consent

```text
card  ──POST /api/onenote/notebooks { allowedIds }──> routes.saveNotebooks
                                                        │ service.setAllowedNotebooks
                                                        ├─ graph.listNotebooks  (validate ids)
                                                        └─ state.writeAllowedNotebooks
```

Only this route reaches `setAllowedNotebooks`. No agent tool can.

## 6. Lifecycle

| Moment | What happens |
| --- | --- |
| Row activates | `resolveConfig`, `createOneNoteService`, four tool registrations, one prompt section. |
| `webServer` becomes ACTIVE | The `ctx.inject` callback runs and registers the five routes. This can be later than row activation, because the Loader starts rows concurrently. |
| Prompt is assembled | The section's text function calls `service.status()` and renders either "not connected" or the live allow-list names. |
| Row is disabled or the profile unloads | Every `ctx.effect` disposer runs: tools, routes, and the prompt section disappear. |
| The process restarts | Nothing is replayed from memory. Tokens and consent are re-read from `$DSH_HOME/onenote/` on the first call that needs them. |

State is deliberately file-backed rather than held in memory: a restart, a
profile switch, or a second process must all see the same consent.

## 7. Why the settings card uses HTTP routes

The browser half cannot import Host modules, and the Host cannot push React
props into a slot. The two established bridges are a package-private RPC and an
HTTP route on the same origin. This package uses HTTP routes because:

- `ctx.webServer.register` is a documented, stable Host service;
- the route table is visible and testable without a browser;
- the same routes can be exercised with `curl` during diagnosis;
- the response shape is plain JSON, which the card validates with `ok`.

The cost is that the routes must handle their own errors. `installRoutes`
therefore wraps every handler and answers `{ ok: false, error }` with status 200
for any thrown failure, reserving non-200 for a method mismatch.

## 8. Extension points

| Need | Extend |
| --- | --- |
| A new Graph endpoint | `src/graph-client.js` |
| A new operation usable by tools and card | `src/service.js`, then both callers |
| A new read-only agent tool | `src/tools.js` |
| A new browser action | `src/routes.js` plus a card control |
| A new persisted field | `src/state.js` |
| A new tunable | `src/config.js` and the patch |
| A new visible string | the `en` and `zh` dictionaries in `client.js` |

See `AGENTS.md` → *Module Placement Rules* for the binding version of this
table.
