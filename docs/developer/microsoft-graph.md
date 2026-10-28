# Microsoft Graph integration

This document records every Microsoft endpoint the plugin calls, the
authentication flow that obtains the token, and the Graph limits that shaped the
implementation.

## 1. Authentication: OAuth 2.0 device code

OneNote does not support app-only authentication. A signed-in user is mandatory,
and the delegated `Notes.Read` scope is the least privilege that works.

The plugin uses the **device-code** flow because it needs no listening socket, no
client secret, and no browser automation. It behaves identically on macOS,
Windows, and a remote shell.

| Step | Request |
| --- | --- |
| 1. Start | `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode` with `client_id` and `scope` |
| 2. Poll | `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id` |
| 3. Refresh | `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with `grant_type=refresh_token`, `refresh_token`, `client_id`, `scope` |

Scopes: `offline_access Notes.Read User.Read`.

- `offline_access` is what makes a refresh token available; without it the user
  would sign in again every hour.
- `User.Read` is used only to name the account in the card and the prompt.
- `Notes.Read` is read-only. The plugin never requests a write scope, so it
  cannot modify or delete a note even if it tried.

`{tenant}` defaults to `common`, which accepts both organizational and personal
Microsoft accounts. A single-tenant deployment sets `tenant` to the tenant id or
domain.

### 1.1 Polling rules

The token endpoint answers with one of:

| `error` | Meaning | Plugin behavior |
| --- | --- | --- |
| `authorization_pending` | The user has not finished in the browser. | Report `pending`; the card polls again in 3 s. |
| `slow_down` | Polling too fast. | Add 5 s to the stored interval and persist it. |
| `authorization_declined` | The user refused. | Clear the pending attempt; report the refusal. |
| `expired_token` | The code expired. | Clear the pending attempt; ask for a new start. |
| `bad_verification_code` | The stored attempt is stale. | Clear it; ask for a new start. |
| `invalid_client` | The app registration is wrong. | Surface Graph's message with a hint about the client id. |
| `unauthorized_client` | Public client flows are disabled. | Surface the message with the hint to enable them. |

`pollDeviceCodeOnce` performs exactly one token request. `pollDeviceCode` loops
over it for callers that want to block (there are none in the shipped paths; the
loop exists for a future CLI). The card never blocks because it uses the
single-shot function.

### 1.2 Token lifetime

An access token is treated as expired 60 seconds before its stated expiry, so a
request never races the deadline. When it is expired, `requireAccessToken`
refreshes with the stored refresh token and writes the new pair before returning.
A refresh failure clears the tokens and reports that the user must sign in again.

`signInSummary().signedIn` therefore answers *"can this session still read?"*, not
*"is the cached access token still unexpired?"*. A session with a stored refresh
token stays `signedIn: true` after the access token lapses, because the next
request renews it silently. Reporting `false` there made `onenote_status` say the
plugin was not connected and made the settings card hide the notebook list, even
though reads worked. `signedIn` is `false` only when there is no token at all or
when a lapsed token has no refresh token to renew it.

## 2. Endpoints in use

Base URL: `https://graph.microsoft.com/v1.0`.

| Purpose | Request | Notes |
| --- | --- | --- |
| Account | `GET /me?$select=id,displayName,userPrincipalName,mail` | Called once after sign-in. |
| Notebooks | `GET /me/onenote/notebooks?$select=id,displayName,isDefault,isShared,lastModifiedDateTime,createdDateTime&$top=100` | Includes shared notebooks. |
| Sections | `GET /me/onenote/notebooks/{id}/sections?$select=id,displayName,lastModifiedDateTime&$top=100` | Direct children only; section groups are not traversed. |
| Section owner | `GET /me/onenote/sections/{id}?$select=id,displayName&$expand=parentNotebook` | Used to authorize a `section_id` before listing. |
| Pages in a notebook | `GET /me/onenote/pages?$filter=parentNotebook/id eq '{id}'&$select=...&$expand=parentSection,parentNotebook&$top=100` | The only server-side notebook filter OneNote offers. |
| Pages in a section | `GET /me/onenote/sections/{id}/pages?$select=...&$expand=parentSection,parentNotebook&$top=100` | |
| Page metadata | `GET /me/onenote/pages/{id}?$select=...&$expand=parentSection,parentNotebook` | Supplies the owning notebook for the consent check. |
| Page content | `GET /me/onenote/pages/{id}/content` with `Accept: text/html` | Returns OneNote's HTML dialect. |

`$select` and `$expand` are always explicit. Leaving them to the service default
produced payloads that omitted `parentNotebook`, which made the consent check
impossible; pinning the projection fixed that.

### 2.1 `$expand` takes no nested `select`

OneNote implements only a subset of OData. A navigation property expanded with a
nested projection is rejected outright:

```text
$expand=parentNotebook(select=id,displayName)
→ 400 BadRequest: Parsing OData Select and Expand failed:
  Term '(select=id,displayName)' is not valid in a $select or $expand expression.
```

That form was in use for every page and section read, so **all** of
`onenote_list_pages`, `onenote_read_page`, and `onenote_search` failed with a
Graph 400 before returning anything. The bare expansion is accepted and already
returns the parent's `id`, `displayName`, and `lastModifiedDateTime`:

```text
$expand=parentSection,parentNotebook        # correct
```

`PAGE_EXPAND` in `src/graph-client.js` is the single place that spells this, and
`test/service.test.js` asserts that no `$expand` value contains `select=`. Do not
reintroduce the nested projection, even though the OData specification allows it
and other Graph endpoints accept it.

`getSectionMeta` spells its own `$expand` rather than reusing `PAGE_EXPAND`, so
fixing one site does not fix the other. `the section-owner lookup expands
parentNotebook without a nested select` in `test/service.test.js` pins it.

A rejected OData expression is a plugin defect, never a permission or network
failure. `src/graph-client.js` maps a 400 whose message matches *Parsing OData
Select and Expand* to a message that says so and names the recovery step
(update the plugin, then restart DeepSeek Harness), because re-authenticating
cannot change a query string.

### 2.2 Pagination

`requestCollection` follows `@odata.nextLink` for at most 5 pages. The cap exists
so one very large notebook cannot stall a turn. A truncated listing is reported
as a smaller page count, not as an error.

## 3. Why search is client-side

OneNote's `GET /me/onenote/pages?$search=` was decommissioned on 5 May 2024 for
consumer notebooks
([announcement](https://devblogs.microsoft.com/microsoft365dev/onenote-get-pagessearch-api-deprecation))
and has no replacement. `service.search` therefore:

1. lists page metadata per **allowed** notebook (up to 300 pages per notebook);
2. sorts candidates by `lastModifiedDateTime` descending;
3. matches titles locally and returns those first;
4. opens at most 15 page bodies, in that same order, to match opening text, and
   returns a 220-character snippet around the first hit.

Consequences, which are documented for users in `README.md`:

- Title matches are complete for the scanned page set.
- Body matches only consider the 15 most recently modified candidate pages.
- A very large notebook beyond the 300-page scan will not have older pages
  considered.

Every request in this path is scoped to an allowed notebook, so search cannot
widen visibility.

## 4. Error mapping

`src/graph-client.js` converts HTTP failures into two typed errors:

| Status | Error | Message strategy |
| --- | --- | --- |
| 401 | `OneNoteAuthError` (`SIGN_IN_REQUIRED`) | Name the settings card as the recovery step. |
| 403 | `GraphError` | Include Graph's reason; suggest a permission problem. |
| 404 | `GraphError` | Tell the caller to re-list, because ids changed. |
| 429 | `GraphError` | Include `Retry-After` when present. |
| 5xx | `GraphError` | Say the service failed and to retry shortly. |
| Network | `GraphError` (`NETWORK`) | Say the network failed. |

`service.describeFailure` renders all of these, plus consent denials, into one
sentence for a tool result or a card message.

## 5. Local development against Graph

A full round trip needs a real account. To exercise the code without one, the
test suites replace `globalThis.fetch` with a router keyed on the parsed URL; see
[docs/developer/testing.md](testing.md). A manual check is possible from the
harness:

```bash
curl -s http://127.0.0.1:49289/api/onenote/state
curl -s -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:49289/api/onenote/device-code/start
```

The second call returns a real user code, which is the fastest way to confirm
that the configured client id is accepted by Microsoft.
