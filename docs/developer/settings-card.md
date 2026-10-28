# Settings card

The settings card is the browser half of the plugin. It is the only surface where
a user can sign in, sign out, or choose readable notebooks. This document records
its loader contract, its slot registration, its route usage, and its styling
rules.

## 1. Bundle contract

`client.js` is a hand-written bundle, not compiled output. It must have exactly
this shape:

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-onenote',
  factory(require) {
    // ...
    return { inject: ['slots', 'locale'], apply(ctx) { /* ... */ } }
  },
})
```

Four requirements, each with a failure mode:

| Requirement | Failure if violated |
| --- | --- |
| `id` equals the package name | The loader cannot match the bundle to its row; the card never appears. |
| `factory` is a function taking `require` | The bundle is rejected at load time. |
| The return value exposes `apply` | The module registers nothing. |
| Every `require` names a module the loader provides | A thrown error blanks the slot entry. |

`require('react')` is the only import. The card must **not** require any
`@deepseek-ai/dsh-client-*` package: those are host internals with no stability
contract, and importing one makes a plugin break on a host upgrade. Controls are
written by hand instead.

There is no build step. A change to `client.js` is live after a page reload.

## 2. Slot registration

The card occupies the bundle configuration slot of the Plugins page:

```js
ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
  name: 'plugins.bundle.config',
  key: 'dsh-plugin-onenote',   // dispatched by the bundle's package name
  id: 'dsh-plugin-onenote',    // the entry id inside this slot
  locale: 'onenote',
}, OneNoteCard))
```

`plugins.bundle.config` is a **keyed** slot: the Plugins page renders one entry
per bundle, keyed by the package name, in the page body between the bundle
description and its rows. Registering an already-occupied key would replace that
occupant, which is why the key must be this package's name.

`ctx.slots.inject` re-registers the entry when the owning declaration collapses
and returns. The callback's registrations are disposed with it.

### 2.1 The component contract

The card receives these props:

| Prop | Type | Use |
| --- | --- | --- |
| `view` | `'summary' \| 'page'` | `summary` renders one line of text; `page` renders the form. |
| `t` | translate function | Optional host translator. The card falls back to its own dictionary. |

The Plugins page draws the title, the icon, and the breadcrumb itself. The card
renders **no** card chrome, no second heading, and no collapse control.

## 3. Localization

The card registers one namespace and uses its own dictionaries:

```js
ctx.effect(() => ctx.locale.register('onenote', { en, zh }))
```

Both dictionaries must declare the same keys; `test/client.test.js` enforces
that. Translation goes through a local `t` helper with `{name}` interpolation,
and prefers the host translator when the page supplies one:

```js
const translated = hostT('onenote.' + key, params)
return translated === 'onenote.' + key ? localT(key, params) : translated
```

The locale service is injected as `locale`, not `i18n`.

## 4. Route contract

The card talks to the Host over same-origin JSON routes. It never imports Host
code and never uses a package-private RPC.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/api/onenote/state` | — | `{ ok, signedIn, account?, expiresAt?, allowedCount, allowedNotebooks, pendingSignIn, notebooks, notebooksError? }` |
| `POST` | `/api/onenote/device-code/start` | `{}` | `{ ok, userCode, verificationUri, expiresInSeconds }` |
| `GET` | `/api/onenote/device-code` | — | `{ ok, status: 'pending' \| 'signed-in' \| 'expired', expiresInSeconds? }`; when signed in, the full state |
| `POST` | `/api/onenote/notebooks` | `{ allowedIds: string[] }` or `{ action: 'clear' }` | The full state plus `allowedCount` |
| `POST` | `/api/onenote/sign-out` | `{}` | `{ ok, signedIn: false, allowedCount }` |

Rules the card relies on:

1. **Every response is JSON and has `ok`.** A handler failure is
   `{ ok: false, error }` with status 200, so the card shows a message instead of
   a dead panel.
2. **`cache-control: no-store`.** State is never cached.
3. **`start` and poll are separate paths.** The Web server rejects a duplicate
   `(kind, path)` pair, so a second method on the same path needs its own path
   segment. This is why start is `/device-code/start` while polling is
   `/device-code`.
4. **A wrong method answers 405** with `{ ok: false, error }`.
5. **The routes mount only once `webServer` is ACTIVE.** `index.js` registers
   them from `ctx.inject(['webServer'], ...)`; a one-shot `ctx.get` in `apply`
   races the Loader and drops all five. When that happens the request reaches
   Connection's `/api` prefix instead, which answers a plain-text `401`, and the
   card reports it with the HTTP status plus the first line of the body, then
   tells the user to restart. See
   [architecture.md](architecture.md#3-host-half-indexjs).

   A non-JSON answer therefore means "the Host half is not mounted", never
   "the server is broken". `call()` in `client.js` marks that case
   `unreachable: true` so the error state offers the restart instead of a
   retry that cannot succeed.

`src/routes.js` exports `ENDPOINTS` so a test and the card refer to the same
paths. The card keeps its own `API` constant because it cannot import Host
modules; `test/client.test.js` and `test/routes.test.js` both pin the strings.

## 5. Card states

The component renders exactly one of these, in this order of precedence:

| State | Trigger | Contents |
| --- | --- | --- |
| `loading` | First render | A loading line. |
| `error` | `/state` answered `ok: false` | The error and a retry button. |
| pending | A device code is outstanding | The code in large type, a copy button, a link to the verification page, and a countdown. |
| signed out | No session | An explanation and a sign-in button. |
| signed in | A session exists | The account, a sign-out button, the notebook checkbox list, and save / allow-none controls. |

While a device code is outstanding the card polls `GET /device-code` every 3
seconds. On `signed-in` it replaces the whole state; on `expired` it stops and
shows the recovery text. The interval is cleared on unmount and whenever the
pending state ends.

## 6. Styling

The card inherits the host theme. Rules:

- Every colour is a `var(--dsw-alias-*)` token; there are no literal colours.
- A filled control pairs the host's own fill and foreground tokens:
  `background: var(--dsw-alias-button-primary-fill)` with
  `color: var(--dsw-alias-label-primary-foreground)`. Do not fill with
  `brand-primary`: that token inverts between themes (near-black on light,
  near-white on dark), so `brand-primary` plus a white label renders
  white-on-white in dark mode and the button text disappears.
- Styles are injected as a `<style>` element rendered inside the component, so
  unmounting removes them.
- Class names are prefixed `dsh-onenote-`.
- Spacing and type sizes follow the host: 13 px body, 12 px captions, 8–10 px
  radii, 30 px controls.

Available tokens (from the Client `Theme` inspect provider): `bg-base`,
`bg-layer-1`, `bg-layer-2`, `bg-overlay`, `border-l1`, `border-l2`,
`brand-primary`, `button-primary-fill`, `button-primary-hover`,
`label-primary`, `label-primary-foreground`, `label-secondary`, `link`,
`state-error-primary`, `state-idle-primary`, `state-success-primary`,
`state-warn-primary`, `specific-sidebar-fill`.

`brand-primary` is a *brand* colour, not a button fill. Use it for accents that
sit on a neutral background (links, checked states); use
`button-primary-fill` / `button-primary-hover` for a filled control.

`test/client.test.js` fails on any literal colour in `CSS` and pins the primary
button's fill/foreground pairing.

## 7. Adding a control

1. Add the strings to both dictionaries in `client.js`.
2. Add the route in `src/routes.js` if the control needs the Host; implement the
   operation in `src/service.js`, not in the handler.
3. Render the control with `h('button', { type: 'button', className: 'dsh-onenote-btn', ... })`.
   Give it a `disabled` state driven by `busy` and an accessible label.
4. Report success with `notice` and failure with `error`; never leave a click
   silent.
5. Add a case to `test/routes.test.js`, and to `test/client.test.js` if the
   rendering logic is non-trivial.

## 8. Verification without a browser

`test/client.test.js` loads `client.js` in a `node:vm` context with a stub
`window.__ModuleLoader__`, runs `factory` with a stub `react`, and inspects what
`apply` registers: the locale namespace, both languages, the slot name, and the
key. It also walks a rendered tree with stub hooks to confirm that the sign-in
and notebook states produce text.

This proves the bundle contract and the registration, **not** the visual result.
A human must open *Settings → Plugins → OneNote* in the running app to confirm
the card renders. Record that step in the change description.
