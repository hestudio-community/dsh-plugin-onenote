/**
 * Microsoft Graph client for OneNote.
 *
 * Three rules keep this thin and predictable:
 *   - every call re-resolves the access token, so a refresh reaches the next call;
 *   - a 401 becomes one actionable sign-in message instead of a bare status;
 *   - pagination follows `@odata.nextLink` but stops at a cap, so one huge
 *     notebook cannot stall a turn.
 */
import { OneNoteAuthError, requireAccessToken } from './auth.js';

const GRAPH_ORIGIN = 'https://graph.microsoft.com/v1.0';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 5;

/** A Graph failure carrying the status and Graph's own error code. */
export class GraphError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
  }
}

function buildUrl(path, params) {
  const url = new URL(`${GRAPH_ORIGIN}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function request(url, config, { accept = 'application/json', signal } = {}) {
  const token = await requireAccessToken(config);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept },
      signal: combined,
    });
  } catch (error) {
    if (error instanceof OneNoteAuthError) throw error;
    if (signal?.aborted === true) throw new GraphError('The OneNote request was cancelled.', { code: 'CANCELLED' });
    const detail = error instanceof Error ? error.message : String(error);
    throw new GraphError(`Could not reach Microsoft Graph (${detail}). Check the network and try again.`, { code: 'NETWORK' });
  }

  if (response.status === 401) {
    throw new OneNoteAuthError(
      'Microsoft Graph rejected the OneNote token. Open Settings → Plugins → OneNote and sign in again.',
      'SIGN_IN_REQUIRED',
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let code;
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      code = parsed?.error?.code;
      detail = parsed?.error?.message ?? body;
    } catch {
      /* a non-JSON error body is still worth showing, trimmed below */
    }
    const reason = typeof detail === 'string' ? detail.split('\n')[0].slice(0, 400) : '';
    if (response.status === 403) {
      throw new GraphError(
        `Microsoft Graph denied access${reason.length > 0 ? `: ${reason}` : ''}. The signed-in account may lack permission for this notebook.`,
        { status: 403, code: code ?? 'FORBIDDEN' },
      );
    }
    if (response.status === 404) {
      throw new GraphError('That OneNote item no longer exists. List the notebooks again to get current ids.', { status: 404, code: code ?? 'NOT_FOUND' });
    }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      throw new GraphError(
        `Microsoft Graph rate-limited the request${retry === null ? '' : `; retry after ${retry}s`}. Wait and try again.`,
        { status: 429, code: code ?? 'TOO_MANY_REQUESTS' },
      );
    }
    throw new GraphError(
      `Microsoft Graph request failed (${response.status})${reason.length > 0 ? `: ${reason}` : ''}.`,
      { status: response.status, code: code ?? 'GRAPH_ERROR' },
    );
  }

  if (accept === 'text/html') return response.text();
  return response.json();
}

async function requestCollection(path, params, config, signal) {
  const items = [];
  let next = buildUrl(path, params);
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await request(next, config, { signal });
    if (Array.isArray(payload?.value)) items.push(...payload.value);
    const nextLink = payload?.['@odata.nextLink'];
    if (typeof nextLink !== 'string' || nextLink.length === 0) return items;
    next = new URL(nextLink);
  }
  return items;
}

/** The expanded parent selectors shared by every page query. */
const PAGE_EXPAND = 'parentSection(select=id,displayName),parentNotebook(select=id,displayName)';
const PAGE_SELECT = 'id,title,createdDateTime,lastModifiedDateTime,links';

function toNotebook(raw) {
  const notebook = {
    id: typeof raw?.id === 'string' ? raw.id : '',
    name: typeof raw?.displayName === 'string' && raw.displayName.length > 0 ? raw.displayName : String(raw?.id ?? ''),
    isDefault: raw?.isDefault === true,
    isShared: raw?.isShared === true,
  };
  const modified = raw?.lastModifiedDateTime ?? raw?.createdDateTime;
  if (typeof modified === 'string') notebook.lastModified = modified;
  return notebook;
}

function toSection(raw) {
  const section = {
    id: typeof raw?.id === 'string' ? raw.id : '',
    name: typeof raw?.displayName === 'string' && raw.displayName.length > 0 ? raw.displayName : String(raw?.id ?? ''),
  };
  if (typeof raw?.parentNotebook?.id === 'string') section.notebookId = raw.parentNotebook.id;
  return section;
}

function toPage(raw) {
  const page = {
    id: typeof raw?.id === 'string' ? raw.id : '',
    title: typeof raw?.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : '(untitled page)',
  };
  if (typeof raw?.lastModifiedDateTime === 'string') page.lastModified = raw.lastModifiedDateTime;
  if (typeof raw?.parentSection?.displayName === 'string' && raw.parentSection.displayName.length > 0) {
    page.sectionName = raw.parentSection.displayName;
  }
  if (typeof raw?.parentNotebook?.displayName === 'string' && raw.parentNotebook.displayName.length > 0) {
    page.notebookName = raw.parentNotebook.displayName;
  }
  if (typeof raw?.parentNotebook?.id === 'string' && raw.parentNotebook.id.length > 0) {
    page.notebookId = raw.parentNotebook.id;
  }
  const webUrl = raw?.links?.oneNoteWebUrl?.href;
  if (typeof webUrl === 'string' && webUrl.length > 0) page.webUrl = webUrl;
  return page;
}

/** The signed-in user, used to name the account in sign-in reports. */
export async function getMe(config, signal) {
  const raw = await request(buildUrl('/me', { $select: 'id,displayName,userPrincipalName,mail' }), config, { signal });
  const me = {};
  for (const key of ['id', 'displayName', 'userPrincipalName', 'mail']) {
    if (typeof raw?.[key] === 'string' && raw[key].length > 0) me[key] = raw[key];
  }
  return me;
}

/** Every notebook the account can see, including shared ones. */
export async function listNotebooks(config, signal) {
  const raw = await requestCollection(
    '/me/onenote/notebooks',
    { $select: 'id,displayName,isDefault,isShared,lastModifiedDateTime,createdDateTime', $top: 100 },
    config,
    signal,
  );
  return raw.map(toNotebook);
}

/** Sections directly inside one notebook. */
export async function listSections(config, notebookId, signal) {
  const raw = await requestCollection(
    `/me/onenote/notebooks/${encodeURIComponent(notebookId)}/sections`,
    { $select: 'id,displayName,lastModifiedDateTime', $top: 100 },
    config,
    signal,
  );
  return raw.map(toSection);
}

/**
 * Pages inside one notebook.
 *
 * `$filter=parentNotebook/id eq …` is the only server-side notebook filter
 * OneNote offers, and it needs the expanded parent in the same request, so the
 * page projection is pinned rather than left to the service default.
 */
export async function listPagesInNotebook(config, notebookId, signal, limit = 200) {
  const raw = await requestCollection(
    '/me/onenote/pages',
    {
      $filter: `parentNotebook/id eq '${notebookId}'`,
      $select: PAGE_SELECT,
      $expand: PAGE_EXPAND,
      $top: Math.min(100, limit),
    },
    config,
    signal,
  );
  return raw.slice(0, limit).map(toPage);
}

/** Pages inside one section. */
export async function listPagesInSection(config, sectionId, signal, limit = 200) {
  const raw = await requestCollection(
    `/me/onenote/sections/${encodeURIComponent(sectionId)}/pages`,
    { $select: PAGE_SELECT, $expand: PAGE_EXPAND, $top: Math.min(100, limit) },
    config,
    signal,
  );
  return raw.slice(0, limit).map(toPage);
}

/** One section's metadata, including the notebook that owns it. */
export async function getSectionMeta(config, sectionId, signal) {
  const raw = await request(
    buildUrl(`/me/onenote/sections/${encodeURIComponent(sectionId)}`, {
      $select: 'id,displayName',
      $expand: 'parentNotebook(select=id,displayName)',
    }),
    config,
    { signal },
  );
  return toSection(raw);
}

/** One page's metadata, including the notebook that owns it. */
export async function getPageMeta(config, pageId, signal) {
  const raw = await request(
    buildUrl(`/me/onenote/pages/${encodeURIComponent(pageId)}`, { $select: PAGE_SELECT, $expand: PAGE_EXPAND }),
    config,
    { signal },
  );
  return toPage(raw);
}

/** One page's HTML content. */
export async function getPageContent(config, pageId, signal) {
  const html = await request(buildUrl(`/me/onenote/pages/${encodeURIComponent(pageId)}/content`), config, {
    accept: 'text/html',
    signal,
  });
  return typeof html === 'string' ? html : '';
}
