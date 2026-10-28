/**
 * The one implementation of every OneNote operation.
 *
 * Both callers go through here: the agent tools in `tools.js` and the browser
 * routes in `routes.js`. Neither re-implements a Graph call or a consent check,
 * so the two surfaces can never disagree about what is allowed.
 *
 * Consent is enforced inside this module, not by its callers: every read path
 * resolves the owning notebook and asserts the allow-list before touching page
 * content, so a page id guessed by a model or injected into a note still cannot
 * reach an unapproved notebook.
 */
import {
  OneNoteAuthError,
  pollDeviceCodeOnce,
  rememberAccount,
  signInSummary,
  signOut,
  startDeviceCode,
} from './auth.js';
import {
  getMe,
  getPageContent,
  getPageMeta,
  getSectionMeta,
  GraphError,
  listNotebooks,
  listPagesInNotebook,
  listPagesInSection,
  listSections,
} from './graph-client.js';
import { htmlToPlainText, renderPage } from './parser.js';
import {
  allowedNotebooks,
  assertNotebookAllowed,
  clearAllowedNotebooks,
  hasConsent,
  isNotebookAllowed,
  NotebookNotAllowedError,
  setAllowedNotebooks,
} from './permissions.js';
import { readPendingSignIn, writePendingSignIn } from './state.js';

/** Page-metadata scan budget for a search, and how many bodies it opens. */
const SEARCH_PAGE_SCAN = 300;
const SEARCH_BODY_SCAN = 15;
const SEARCH_SNIPPET_CHARS = 220;

/** A failure whose message is already written for a person to read. */
export class OneNoteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OneNoteError';
    this.code = code;
  }
}

/**
 * Reduce any thrown value to one actionable sentence.
 * @param {unknown} error - whatever was thrown.
 * @returns {string} a message safe to show a model or a browser.
 */
export function describeFailure(error) {
  if (error instanceof NotebookNotAllowedError) return `Notebook not allowed. ${error.message}`;
  if (error instanceof OneNoteAuthError) return `OneNote sign-in needed. ${error.message}`;
  if (error instanceof GraphError) return `OneNote request failed. ${error.message}`;
  if (error instanceof OneNoteError) return error.message;
  if (error instanceof Error) return `OneNote operation failed. ${error.message}`;
  return `OneNote operation failed. ${String(error)}`;
}

/** Copy only defined fields, so no property holds `undefined`. */
function compact(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function clampInt(value, fallback, min = 1, max = 200) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function pageItem(page) {
  return compact({
    id: page.id,
    title: page.title,
    lastModified: page.lastModified,
    sectionName: page.sectionName,
    notebookName: page.notebookName,
    webUrl: page.webUrl,
  });
}

function sectionItem(section) {
  return { id: section.id, name: section.name };
}

/**
 * Build the service over one resolved plugin config.
 * @param {{ clientId: string, tenant: string, maxPagesPerList: number, maxPageChars: number }} config - resolved config.
 * @returns {object} the operations shared by tools and routes.
 */
export function createOneNoteService(config) {
  return {
    /** Sign-in and consent status, for the tool and the settings card. */
    status() {
      const summary = signInSummary();
      const allowed = allowedNotebooks();
      return {
        signedIn: summary.signedIn,
        renewsAutomatically: summary.renewsAutomatically === true,
        expiresAt: summary.expiresAt,
        account: summary.account,
        allowedCount: allowed.length,
        allowedNotebooks: allowed.map((entry) => ({ id: entry.id, name: entry.name })),
        pendingSignIn: readPendingSignIn() !== undefined,
      };
    },

    /** Start (or continue) a device-code attempt and return what to show the user. */
    async beginSignIn() {
      const pending = readPendingSignIn();
      if (pending !== undefined) {
        return {
          userCode: pending.userCode,
          verificationUri: pending.verificationUri,
          expiresInSeconds: Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)),
        };
      }
      const started = await startDeviceCode(config);
      // Persist before returning: the next call is a separate HTTP request, so
      // the attempt must survive this one.
      writePendingSignIn(started);
      return {
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresInSeconds: Math.max(0, Math.round((started.expiresAt - Date.now()) / 1000)),
      };
    },

    /**
     * Poll the pending attempt exactly once.
     *
     * One poll per call keeps an HTTP request short: the browser repeats it,
     * so the user sees a live countdown instead of a stalled request.
     * @returns {Promise<object>} `pending`, `signed-in`, or a thrown auth error.
     */
    async pollSignIn() {
      const pending = readPendingSignIn();
      if (pending === undefined) {
        const summary = signInSummary();
        if (summary.signedIn) return { status: 'signed-in', account: summary.account };
        return { status: 'expired' };
      }
      const outcome = await pollDeviceCodeOnce(pending);
      if (outcome.status === 'pending') {
        return {
          status: 'pending',
          expiresInSeconds: Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)),
        };
      }
      return await this.completeSignIn();
    },

    /** Read the profile once the token is stored, so the card can name the account. */
    async completeSignIn() {
      const summary = signInSummary();
      try {
        const me = await getMe(config);
        rememberAccount(me);
        return { status: 'signed-in', account: me };
      } catch (error) {
        // The token is already stored; a profile read failure must not read as a failed sign-in.
        if (error instanceof GraphError) return { status: 'signed-in', account: summary.account };
        throw error;
      }
    },

    /** Forget the stored session. The allow-list is deliberately untouched. */
    signOut() {
      signOut();
    },

    /**
     * Every notebook the account can see, flagged with whether it is allowed.
     * This is the only read that deliberately looks outside the allow-list: the
     * user has to see the names in order to choose.
     */
    async listNotebooks() {
      const notebooks = await listNotebooks(config);
      return notebooks.map((notebook) => compact({
        id: notebook.id,
        name: notebook.name,
        allowed: isNotebookAllowed(notebook.id),
        isDefault: notebook.isDefault || undefined,
        isShared: notebook.isShared || undefined,
        lastModified: notebook.lastModified,
      }));
    },

    /**
     * Replace the allow-list. Only a user action may call this: the tools never
     * expose it, so a prompt-injected note cannot widen its own read scope.
     * @param {readonly string[]} ids - notebook ids to allow.
     * @returns {Promise<object[]>} the stored entries.
     */
    async setAllowedNotebooks(ids) {
      const requested = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.trim().length > 0) : [];
      if (requested.length === 0) {
        clearAllowedNotebooks();
        return [];
      }
      const available = await listNotebooks(config);
      const byId = new Map(available.map((notebook) => [notebook.id.toLowerCase(), notebook]));
      const unknown = requested.filter((id) => !byId.has(id.trim().toLowerCase()));
      if (unknown.length > 0) {
        throw new OneNoteError(
          `These notebook ids are not visible to the signed-in account: ${unknown.join(', ')}. Refresh the list and try again.`,
          'UNKNOWN_NOTEBOOK',
        );
      }
      return setAllowedNotebooks(requested.map((id) => {
        const notebook = byId.get(id.trim().toLowerCase());
        return { id: notebook.id, name: notebook.name };
      }));
    },

    /** Forget every consent. */
    clearAllowedNotebooks() {
      clearAllowedNotebooks();
    },

    /** Whether any notebook is readable right now. */
    hasConsent,

    /** The readable notebooks, as stored. */
    allowedNotebooks,

    /**
     * Browse allowed structure: no arguments lists notebooks with sections;
     * `notebookId` adds its pages; `sectionId` returns that section's pages.
     * @param {{ notebookId?: string, sectionId?: string, limit?: number }} input - the browse target.
     * @param {AbortSignal} [signal] - caller cancellation.
     */
    async listPages(input, signal) {
      const limit = clampInt(input.limit, Math.min(50, config.maxPagesPerList), 1, 200);
      if (!hasConsent()) {
        return { message: 'No notebooks are allowed yet. Open Settings → Plugins → OneNote to choose which notebooks this agent may read.' };
      }

      if (typeof input.sectionId === 'string' && input.sectionId.trim().length > 0) {
        const sectionId = input.sectionId.trim();
        // Resolve the owner before listing: a guessed section id must not read
        // pages from a notebook the user never approved.
        const section = await getSectionMeta(config, sectionId, signal);
        if (section.notebookId === undefined) {
          throw new OneNoteError('Microsoft Graph did not report which notebook owns this section, so it cannot be checked against the allowed list.', 'UNVERIFIABLE_OWNER');
        }
        assertNotebookAllowed(section.notebookId);
        const pages = await listPagesInSection(config, sectionId, signal, limit);
        return {
          message: pages.length === 0 ? `Section ${section.name} has no pages.` : `${pages.length} page(s) in section ${section.name}.`,
          pages: pages.map(pageItem),
        };
      }

      if (typeof input.notebookId === 'string' && input.notebookId.trim().length > 0) {
        const allowed = assertNotebookAllowed(input.notebookId.trim());
        const sections = await listSections(config, allowed.id, signal);
        const pages = await listPagesInNotebook(config, allowed.id, signal, limit);
        return {
          message: `Notebook ${allowed.name}: ${sections.length} section(s), ${pages.length} page(s).`,
          notebooks: [{ id: allowed.id, name: allowed.name, sections: sections.map(sectionItem) }],
          pages: pages.map(pageItem),
        };
      }

      const notebooks = [];
      for (const allowed of allowedNotebooks()) {
        const sections = await listSections(config, allowed.id, signal);
        notebooks.push({ id: allowed.id, name: allowed.name, sections: sections.map(sectionItem) });
      }
      return {
        message: `${notebooks.length} allowed notebook(s). Pass notebook_id or section_id to list pages.`,
        notebooks,
      };
    },

    /**
     * Search the allowed notebooks: titles first, then the opening text of the
     * most recently modified pages. OneNote's server-side page search was
     * retired in 2024, so matching happens here, bounded to the allowed set.
     * @param {{ query: string, limit?: number }} input - the search.
     * @param {AbortSignal} [signal] - caller cancellation.
     */
    async search(input, signal) {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length === 0) throw new OneNoteError('A search needs a non-empty query.', 'EMPTY_QUERY');
      const limit = clampInt(input.limit, 10, 1, 50);
      const needle = query.toLowerCase();
      const allowed = allowedNotebooks();
      if (allowed.length === 0) {
        return { message: 'No notebooks are allowed yet. Open Settings → Plugins → OneNote to choose notebooks first.' };
      }

      const candidates = [];
      for (const notebook of allowed) {
        const pages = await listPagesInNotebook(config, notebook.id, signal, SEARCH_PAGE_SCAN);
        for (const page of pages) candidates.push({ page, notebook });
      }
      candidates.sort((left, right) => String(right.page.lastModified ?? '').localeCompare(String(left.page.lastModified ?? '')));

      const results = [];
      const seen = new Set();
      const add = (page, notebook, matchedIn, snippet) => {
        if (seen.has(page.id) || results.length >= limit) return;
        seen.add(page.id);
        results.push(compact({
          id: page.id,
          title: page.title,
          notebookName: notebook.name,
          sectionName: page.sectionName,
          lastModified: page.lastModified,
          matchedIn,
          snippet,
        }));
      };

      for (const { page, notebook } of candidates) {
        if (results.length >= limit) break;
        if (page.title.toLowerCase().includes(needle)) add(page, notebook, 'title');
      }

      if (results.length < limit) {
        let scanned = 0;
        for (const { page, notebook } of candidates) {
          if (results.length >= limit || scanned >= SEARCH_BODY_SCAN) break;
          if (seen.has(page.id)) continue;
          scanned += 1;
          try {
            const plain = htmlToPlainText(await getPageContent(config, page.id, signal));
            const at = plain.toLowerCase().indexOf(needle);
            if (at < 0) continue;
            const start = Math.max(0, at - 60);
            add(page, notebook, 'body', plain.slice(start, start + SEARCH_SNIPPET_CHARS).trim());
          } catch (error) {
            // One unreadable page must not fail the search, but a dead session must.
            if (error instanceof OneNoteAuthError) throw error;
          }
        }
      }

      return results.length === 0
        ? { message: `No page in the allowed notebooks matched "${query}".` }
        : { message: `Found ${results.length} matching page(s) for "${query}".`, results };
    },

    /**
     * Read one page as Markdown, refusing any page outside the allow-list.
     * @param {{ pageId: string, maxChars?: number }} input - the page to read.
     * @param {AbortSignal} [signal] - caller cancellation.
     */
    async readPage(input, signal) {
      const pageId = typeof input.pageId === 'string' ? input.pageId.trim() : '';
      if (pageId.length === 0) throw new OneNoteError('Reading a page needs a page id.', 'EMPTY_PAGE_ID');
      const maxChars = clampInt(input.maxChars, config.maxPageChars, 2000, 200000);

      const meta = await getPageMeta(config, pageId, signal);
      if (meta.notebookId === undefined) {
        throw new OneNoteError(
          'Microsoft Graph did not report which notebook owns this page, so it cannot be checked against the allowed list. List the page from its notebook to get an id that carries its notebook.',
          'UNVERIFIABLE_OWNER',
        );
      }
      const allowed = assertNotebookAllowed(meta.notebookId, meta.notebookName);
      const html = await getPageContent(config, pageId, signal);
      const rendered = renderPage(html, maxChars);
      return compact({
        id: meta.id,
        title: meta.title,
        notebookName: allowed.name,
        sectionName: meta.sectionName,
        lastModified: meta.lastModified,
        webUrl: meta.webUrl,
        truncated: rendered.truncated,
        content: rendered.content.length > 0 ? rendered.content : '(this page has no readable text)',
      });
    },
  };
}
