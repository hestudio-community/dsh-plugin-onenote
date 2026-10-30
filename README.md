# dsh-plugin-onenote

Read the Microsoft OneNote notebooks **you choose** from inside
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Sign in once, tick the notebooks this agent may read, and everything else stays
invisible. The allow-list is enforced inside the plugin before any Microsoft
Graph request, so a page that tries to talk the model into reading another
notebook has nothing to call.

> 中文文档：[README.zh.md](./README.zh.md)

## What it looks like

The settings card (Settings → Plugins → OneNote) is the only place to sign in or
change which notebooks are readable:

```
┌ OneNote ──────────────────────────────────────────────┐
│ Connected                                             │
│ Signed in as you@example.com        [ Sign out ]      │
├───────────────────────────────────────────────────────┤
│ Readable notebooks            [ Refresh list ]        │
│ Only the notebooks you tick can be listed, searched,  │
│ or read.                                              │
│   [x] Work                              default       │
│   [ ] Team wiki                         shared        │
│   [ ] Journal                                         │
│                          1 of 3 allowed  [Allow none] │
│                                                [Save] │
└───────────────────────────────────────────────────────┘
```

## Tools

The agent gets four read-only tools. None of them can sign in, sign out, or
change the allow-list — those are user actions in the settings card.

| Tool | What it does |
| --- | --- |
| `onenote_status` | Reports the account and which notebooks are readable. |
| `onenote_list_pages` | Browses allowed notebooks → sections → pages. |
| `onenote_search` | Matches page titles first, then the opening text of recent pages. |
| `onenote_read_page` | Reads one page as Markdown (headings, lists, tables, links, code). |

## Install

```bash
# From the plugin manager (recommended)
dsh plugin install hestudio-community/dsh-plugin-onenote

# Or from npm
dsh plugin install dsh-plugin-onenote
```

Then open **Settings → Plugins → OneNote** and sign in.

## Azure app registration

The bundle ships a public client ID so it works out of the box. To use your own
app registration instead (recommended for anything beyond personal use), create
one in about two minutes — no paid subscription is needed:

1. Open [App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
   → **New registration**.
2. **Name**: anything, e.g. `DSH-OneNote`.
3. **Supported account types**: *Accounts in any organizational directory and
   personal Microsoft accounts*. Choose a single-tenant option instead if every
   user is in one tenant.
4. **Redirect URI**: leave empty — the device-code flow needs none.
5. **Register**, then copy **Application (client) ID**.
6. **Authentication → Advanced settings → Allow public client flows** = **Yes**,
   then **Save**. Without this, sign-in fails with `unauthorized_client`.
7. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**:
   - `Notes.Read` — read the user's notebooks
   - `offline_access` — keep the session alive between turns
   - `User.Read` — name the signed-in account
8. No client secret and no admin consent are needed for a personal account. A
   work account may need an admin to grant consent once.

Then point the plugin at your app by adding a patch layer of your own:

```yaml
# ~/.dsh/cordis.patch.yml (applies to every profile) or the profile's cordis.patch.yml
- id: onenote
  name: 'dsh-plugin-onenote'
  config:
    clientId: 00000000-0000-0000-0000-000000000000
    tenant: common
```

`config` replaces the row's config wholesale, so restate every field you need.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `clientId` | the bundled public app | Azure application (client) ID. |
| `tenant` | `common` | Tenant id or domain. `common` accepts work and personal accounts. |
| `maxPagesPerList` | `100` | Default page cap for `onenote_list_pages`. |
| `maxPageChars` | `60000` | Default Markdown cap for `onenote_read_page`. |

## Where state lives

`$DSH_HOME/onenote/` (usually `~/.dsh/onenote/`), mode `0600`:

| File | Contents |
| --- | --- |
| `tokens.json` | Access and refresh token. |
| `signin.json` | The pending device-code attempt, so a reload continues the same code. |
| `settings.json` | The notebook allow-list. |

Delete the directory to reset everything. Nothing is written into your
workspace.

## How the privacy boundary works

1. The allow-list is a list of notebook ids in `settings.json`.
2. Every read resolves the **owning notebook first** — from the page, the
   section, or the notebook itself — and asserts the allow-list before fetching
   content. Guessing a section id does not bypass it.
3. The agent tools cannot write the allow-list. Only the settings card can, and
   only through `POST /api/onenote/notebooks`.
4. The system prompt tells the model the readable notebook names and that
   everything else is unreadable by design.

## Notes on the Graph API

- OneNote does not support app-only authentication, so a signed-in user is
  required; `Notes.Read` is delegated.
- `GET /me/onenote/pages?$search=` was retired in 2024
  ([announcement](https://devblogs.microsoft.com/microsoft365dev/onenote-get-pagessearch-api-deprecation)),
  so search lists page metadata per allowed notebook and matches titles
  locally, then reads the opening text of the most recently modified pages. That
  keeps the cost bounded and never leaves the allowed set.
- Page content arrives as OneNote's HTML dialect; `src/parser.js` converts it to
  Markdown without a third-party dependency and never downloads media.

## Development

```bash
npm test          # 98 tests, no network, no host required
npm run pack:check
```

The suite stubs `@deepseek-ai/dsh-tools` (a host-provided peer) through a Node
module hook, so a bare checkout runs without installing the harness.

## License

MIT — see [LICENSE](./LICENSE).
